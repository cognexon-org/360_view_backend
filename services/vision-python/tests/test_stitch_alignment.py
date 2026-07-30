import numpy as np
import pytest

from app.processors.alignment import (
    angular_difference_degrees,
    pose_from_rotation,
    refine_alignment,
    rotation_from_pose,
)
from app.processors.compositor import compose_spherical
from app.processors.stitch import _align_wrap_meridian, _resolve_pose

cv2 = pytest.importorskip("cv2")

RNG = np.random.default_rng(11)


def _room(width=2048, height=1024):
    image = RNG.integers(40, 210, (height // 8, width // 8, 3)).astype(np.uint8)
    image = cv2.resize(image, (width, height), interpolation=cv2.INTER_CUBIC)
    for _ in range(60):
        x, y = int(RNG.integers(0, width - 80)), int(RNG.integers(0, height - 80))
        cv2.rectangle(
            image, (x, y), (x + 60, y + 50), RNG.integers(0, 255, 3).tolist(), -1
        )
    return image


def _render(equirect, rotation, fov_deg, out_w=260, out_h=340):
    height, width = equirect.shape[:2]
    focal = (out_w / 2.0) / np.tan(np.radians(fov_deg) / 2.0)
    xs = (np.arange(out_w) + 0.5 - out_w / 2.0) / focal
    ys = (np.arange(out_h) + 0.5 - out_h / 2.0) / focal
    gx, gy = np.meshgrid(xs, ys)
    rays = np.stack([gx, gy, np.ones_like(gx)], -1)
    rays /= np.linalg.norm(rays, axis=-1, keepdims=True)
    world = rays @ np.asarray(rotation, np.float64).T
    col = ((np.arctan2(world[..., 0], world[..., 2]) / (2 * np.pi)) + 0.5) * width
    row = (1.0 - np.arccos(np.clip(world[..., 1], -1, 1)) / np.pi) * height
    return cv2.remap(
        equirect,
        col.astype(np.float32),
        row.astype(np.float32),
        cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_WRAP,
    )


def _ring_capture(true_fov=44.0, yaw_noise=5.0, frames=15):
    """Ring capture with about 45 percent overlap, the geometry the app should use."""
    room = _room()
    images, reported = [], []
    step = 360.0 / frames
    for index in range(frames):
        target_yaw = index * step
        actual_yaw = target_yaw + float(RNG.normal(0, yaw_noise))
        actual_pitch = float(RNG.normal(0, 2.0))
        images.append(_render(room, rotation_from_pose(actual_yaw, actual_pitch, 0.0), true_fov))
        reported.append((target_yaw, 0.0, 0.0))
    return room, images, reported


def test_pose_round_trip_is_exact():
    for yaw, pitch, roll in [(0, 0, 0), (37, -22, 5), (200, 60, -9), (350, -80, 12)]:
        back = pose_from_rotation(rotation_from_pose(yaw, pitch, roll))
        assert back[0] == pytest.approx(yaw % 360.0, abs=1e-3)
        assert back[1] == pytest.approx(pitch, abs=1e-3)
        assert back[2] == pytest.approx(roll, abs=1e-3)


def test_refinement_recovers_the_true_field_of_view():
    """The Camera2 estimate is deliberately 20 percent wrong; the solve must fix it."""
    _, images, reported = _ring_capture(true_fov=44.0)
    result = refine_alignment(images, reported, 53.0, 68.0)
    diagnostics = result["diagnostics"]
    assert diagnostics["method"] == "BUNDLE_ADJUSTED_RAY"
    assert diagnostics["solvedHorizontalFovDegrees"] == pytest.approx(44.0, abs=1.5)
    assert diagnostics["refinedFrameCount"] == len(images)


def test_sparse_capture_degrades_gracefully():
    """Too little overlap breaks the match graph; the sensor pose must still carry it."""
    _, images, reported = _ring_capture(true_fov=44.0, yaw_noise=7.0, frames=10)
    result = refine_alignment(images, reported, 53.0, 68.0)
    assert len(result["rotations"]) == len(images)
    for rotation in result["rotations"]:
        assert np.isfinite(np.asarray(rotation)).all()


def test_refinement_corrects_sensor_yaw_error():
    _, images, reported = _ring_capture(true_fov=44.0, yaw_noise=6.0)
    result = refine_alignment(images, reported, 53.0, 68.0)
    seeds = [rotation_from_pose(*pose) for pose in reported]
    corrections = [
        angular_difference_degrees(seed, refined)
        for seed, refined in zip(seeds, result["rotations"])
    ]
    # The solve should actually move the frames, but never wildly.
    assert np.median(corrections) > 1.0
    assert max(corrections) < 25.0


def test_textureless_capture_falls_back_to_sensor_poses():
    """A flat, evenly painted wall has nothing to match; the IMU must still win."""
    flat = np.full((340, 260, 3), 190, np.uint8)
    images = [flat.copy() for _ in range(8)]
    reported = [(index * 45.0, 0.0, 0.0) for index in range(8)]
    result = refine_alignment(images, reported, 52.0, 68.0)
    assert result["diagnostics"]["method"] == "IMU_ONLY"
    for pose, rotation in zip(reported, result["rotations"]):
        assert angular_difference_degrees(rotation_from_pose(*pose), rotation) < 1e-4


def test_too_few_frames_is_not_an_error():
    images = [np.full((60, 40, 3), 120, np.uint8)] * 2
    result = refine_alignment(images, [(0.0, 0.0, 0.0), (30.0, 0.0, 0.0)], 52.0, 68.0)
    assert result["diagnostics"]["method"] == "IMU_ONLY"
    assert len(result["rotations"]) == 2


def test_wrap_meridian_is_placed_inside_a_frame():
    rotations = [rotation_from_pose(index * 30.0 + 7.0, 0.0, 0.0) for index in range(12)]
    shifted, offset = _align_wrap_meridian(rotations)
    yaws = [pose_from_rotation(rotation)[0] for rotation in shifted]
    closest = min(yaws, key=lambda yaw: abs(((yaw - 180.0 + 180.0) % 360.0) - 180.0))
    assert closest == pytest.approx(180.0, abs=0.5)
    assert abs(offset) <= 180.0


def test_wrap_edges_are_continuous_after_composition():
    room, images, reported = _ring_capture(true_fov=44.0)
    result = refine_alignment(images, reported, 53.0, 68.0)
    rotations, _ = _align_wrap_meridian(result["rotations"])
    panorama, covered, _ = compose_spherical(images, rotations, result["focals"], 1024, 512)
    band = slice(180, 330)
    left = panorama[band, 0].astype(np.float32)
    right = panorama[band, -1].astype(np.float32)
    # Adjacent columns on a sphere; a torn wrap shows up as a large step here.
    assert float(np.mean(np.abs(left - right))) < 18.0


def test_composition_covers_the_equator():
    _, images, reported = _ring_capture()
    result = refine_alignment(images, reported, 53.0, 68.0)
    _, covered, metrics = compose_spherical(images, result["rotations"], result["focals"], 1024, 512)
    assert covered[256].mean() > 0.99
    assert metrics["composedFrameCount"] == len(images)
    assert metrics["overlapDisagreement"] < 25.0


def test_measured_pose_is_used_verbatim_when_plausible():
    pose = _resolve_pose(
        {
            "measuredYawDegrees": 43.0,
            "measuredPitchDegrees": -3.0,
            "targetYawDegrees": 30.0,
            "targetPitchDegrees": 0.0,
        },
        0,
        "frame_00.jpg",
    )
    # The old code clamped this to 38 degrees, knowingly placing it 5 degrees wrong.
    assert pose[0] == pytest.approx(43.0)
    assert pose[1] == pytest.approx(-3.0)


def test_wildly_off_target_sensor_sample_is_rejected():
    pose = _resolve_pose(
        {
            "measuredYawDegrees": 190.0,
            "measuredPitchDegrees": 0.0,
            "targetYawDegrees": 30.0,
            "targetPitchDegrees": 0.0,
        },
        0,
        "frame_00.jpg",
    )
    assert pose[0] == pytest.approx(30.0)
