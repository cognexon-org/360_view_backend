"""Mode A panorama assembly.

Pipeline
--------
1. Load frames and their IMU orientation from the guided capture.
2. Refine rotations and the shared focal length against the image content
   (``alignment.refine_alignment``). The IMU seeds the solve; pixels decide it.
3. Rotate the solution so the wrap-around meridian falls inside a single frame,
   so the panorama's left and right edges are continuous.
4. Warp, exposure-compensate, seam-cut and multi-band blend
   (``compositor.compose_spherical``).
5. Close residual holes, run QA, and report honest alignment diagnostics.

If refinement or compositing cannot run - a very dark room, a nearly textureless
wall, an OpenCV build without the detail module - the module falls back to the
original pose-projection blend so a capture never fails outright.
"""

from __future__ import annotations

import logging
import re
from io import BytesIO
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageOps

from ..storage import get_bytes, put_bytes
from .alignment import pose_from_rotation, refine_alignment, rotation_from_pose
from .compositor import compose_spherical
from .panorama import analyze_panorama

LOGGER = logging.getLogger("propertytour360-vision.stitch")

QUICK_CENTRAL_RING = "QUICK_CENTRAL_RING"
FULL_TWO_RINGS_WITH_CAPS = "FULL_TWO_RINGS_WITH_CAPS"
LEGACY_GUIDED = "LEGACY_GUIDED"

LEGACY_CAPTURE_TARGETS: list[tuple[float, float]] = (
    [(y, 0.0) for y in (0, 45, 90, 135, 180, 225, 270, 315)]
    + [(y, -42.0) for y in (22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5)]
    + [(y, 42.0) for y in (0, 45, 90, 135, 180, 225, 270, 315)]
    + [(0.0, -78.0), (180.0, 78.0)]
)

OUT_W = 4096
OUT_H = 2048
DEFAULT_HFOV_DEG = 52.0
DEFAULT_VFOV_DEG = 68.0
BLEND_POWER = 7.0

# A measured orientation further than this from the guided target is treated as
# a bad sensor sample and the target is used instead. The old code clamped the
# correction to +-8 degrees, which silently placed genuinely off-target frames at
# a knowingly wrong angle; refusing the sample outright is the honest version,
# and the bundle adjuster fixes the residual either way.
MAX_TRUSTED_TARGET_DEVIATION_DEGREES = 25.0

# Above this, overlapping frames disagree so much after alignment that the cause
# is physical (the phone orbited instead of pivoting, or something moved) and no
# amount of blending will produce a clean room.
PARALLAX_WARNING_THRESHOLD = 11.0
PARALLAX_FAILURE_THRESHOLD = 20.0


def _frame_index_from_key(key: str) -> int | None:
    match = re.search(r"frame[_-]?(\d+)", key, re.IGNORECASE)
    return int(match.group(1)) if match else None


def _signed_angle_delta(from_degrees: float, to_degrees: float) -> float:
    return ((to_degrees - from_degrees + 180.0) % 360.0) - 180.0


# ---------------------------------------------------------------------------
# Legacy pose-only projection, retained as the fallback path
# ---------------------------------------------------------------------------


def _camera_basis(yaw_deg: float, pitch_deg: float, roll_deg: float = 0.0):
    yaw = np.radians(yaw_deg)
    elevation = np.radians(-pitch_deg)
    forward = np.array(
        [
            np.cos(elevation) * np.sin(yaw),
            np.sin(elevation),
            np.cos(elevation) * np.cos(yaw),
        ],
        dtype=np.float32,
    )
    world_up = np.array([0.0, 1.0, 0.0], dtype=np.float32)
    right = np.cross(world_up, forward)
    norm = np.linalg.norm(right)
    right = np.array([1.0, 0.0, 0.0], dtype=np.float32) if norm < 1e-6 else right / norm
    up = np.cross(forward, right)

    if abs(roll_deg) > 1e-4:
        roll = np.radians(roll_deg)
        cos_roll, sin_roll = np.cos(roll), np.sin(roll)
        right, up = right * cos_roll + up * sin_roll, -right * sin_roll + up * cos_roll
    return forward, right, up


def _direction_grid(width: int, height: int):
    xs = (np.arange(width, dtype=np.float32) + 0.5) / width
    ys = (np.arange(height, dtype=np.float32) + 0.5) / height
    longitude = (xs * 2.0 - 1.0) * np.pi
    latitude = (0.5 - ys) * np.pi
    longitude_grid, latitude_grid = np.meshgrid(longitude, latitude)
    cos_latitude = np.cos(latitude_grid)
    dx = (cos_latitude * np.sin(longitude_grid)).astype(np.float32)
    dy = np.sin(latitude_grid).astype(np.float32)
    dz = (cos_latitude * np.cos(longitude_grid)).astype(np.float32)
    return dx, dy, dz


def _normalize_exposure(frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not frames:
        return frames
    medians = [float(np.median(cv2.cvtColor(f["image"], cv2.COLOR_BGR2GRAY))) for f in frames]
    target = float(np.median(medians))
    normalized: list[dict[str, Any]] = []
    for frame, median in zip(frames, medians):
        gain = 1.0 if median < 1.0 else float(np.clip(target / median, 0.78, 1.28))
        adjusted = np.clip(frame["image"].astype(np.float32) * gain, 0, 255).astype(np.uint8)
        normalized.append({**frame, "image": adjusted, "exposureGain": round(gain, 4)})
    return normalized


def project_equirectangular(
    frames: list[dict[str, Any]],
    out_w: int = OUT_W,
    out_h: int = OUT_H,
) -> tuple[np.ndarray, np.ndarray]:
    """Pose-only projection with high-dominance feathering (fallback path)."""
    dx, dy, dz = _direction_grid(out_w, out_h)
    accumulator = np.zeros((out_h, out_w, 3), np.float32)
    weight_sum = np.zeros((out_h, out_w), np.float32)

    for frame in frames:
        image = frame["image"]
        height, width = image.shape[:2]
        horizontal_tangent = np.tan(np.radians(float(frame["horizontalFovDegrees"])) / 2.0)
        vertical_tangent = np.tan(np.radians(float(frame["verticalFovDegrees"])) / 2.0)

        forward, right, up = _camera_basis(
            float(frame["yawDegrees"]),
            float(frame["pitchDegrees"]),
            float(frame.get("rollDegrees", 0.0)),
        )
        local_z = dx * forward[0] + dy * forward[1] + dz * forward[2]
        valid_front = local_z > 1e-3
        safe_z = np.where(valid_front, local_z, 1.0)
        local_x = dx * right[0] + dy * right[1] + dz * right[2]
        local_y = dx * up[0] + dy * up[1] + dz * up[2]
        u = (local_x / safe_z) / horizontal_tangent
        v = (local_y / safe_z) / vertical_tangent
        in_frame = valid_front & (np.abs(u) <= 1.0) & (np.abs(v) <= 1.0)

        map_x = ((u * 0.5 + 0.5) * (width - 1)).astype(np.float32)
        map_y = ((0.5 - v * 0.5) * (height - 1)).astype(np.float32)
        sampled = cv2.remap(image, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

        edge_x = np.clip(1.0 - np.abs(u), 0.0, 1.0)
        edge_y = np.clip(1.0 - np.abs(v), 0.0, 1.0)
        base_weight = np.sqrt(edge_x * edge_y)
        weight = np.where(in_frame, np.power(base_weight, BLEND_POWER), 0.0).astype(np.float32)
        accumulator += sampled.astype(np.float32) * weight[..., None]
        weight_sum += weight

    covered = weight_sum > 1e-7
    output = np.zeros_like(accumulator)
    output[covered] = accumulator[covered] / weight_sum[covered, None]
    return np.clip(output, 0, 255).astype(np.uint8), covered


# ---------------------------------------------------------------------------
# Hole closing
# ---------------------------------------------------------------------------


def _fill_quick_view_uncovered(image: np.ndarray, covered: np.ndarray) -> np.ndarray:
    """Remove black poles while preserving explicit pitch limits in the manifest."""
    result = image.copy()
    row_coverage = covered.mean(axis=1)
    usable_rows = np.where(row_coverage > 0.97)[0]
    if usable_rows.size == 0:
        usable_rows = np.where(row_coverage > 0.20)[0]
    if usable_rows.size == 0:
        return result
    first_row, last_row = int(usable_rows[0]), int(usable_rows[-1])
    result[:first_row] = result[first_row]
    result[last_row + 1 :] = result[last_row]

    interior_holes = (~covered).astype(np.uint8) * 255
    interior_holes[:first_row] = 0
    interior_holes[last_row + 1 :] = 0
    if interior_holes.any():
        result = cv2.inpaint(result, interior_holes, 3, cv2.INPAINT_TELEA)
    return result


def _fill_full_sphere_holes(image: np.ndarray, covered: np.ndarray) -> np.ndarray:
    holes = (~covered).astype(np.uint8) * 255
    if not holes.any():
        return image
    return cv2.inpaint(image, holes, 3, cv2.INPAINT_TELEA)


def _covered_pitch_range(covered: np.ndarray, out_h: int) -> tuple[float, float]:
    """Actual vertical extent of the panorama, in capture pitch degrees."""
    row_coverage = covered.mean(axis=1)
    usable = np.where(row_coverage > 0.97)[0]
    if usable.size == 0:
        return -90.0, 90.0
    to_pitch = lambda row: (float(row) / float(out_h) - 0.5) * 180.0  # noqa: E731
    return to_pitch(int(usable[0])), to_pitch(int(usable[-1]) + 1)


# ---------------------------------------------------------------------------
# Frame loading
# ---------------------------------------------------------------------------


def _resolve_pose(item: dict[str, Any], index: int, key: str) -> tuple[float, float, float] | None:
    """Best available (yaw, pitch, roll) for a frame, in degrees."""
    measured_yaw = item.get("measuredYawDegrees")
    measured_pitch = item.get("measuredPitchDegrees")
    target_yaw = item.get("targetYawDegrees")
    target_pitch = item.get("targetPitchDegrees")
    roll = float(item.get("measuredRollDegrees") or item.get("rollDegrees") or 0.0)

    if measured_yaw is not None and measured_pitch is not None:
        yaw, pitch = float(measured_yaw), float(measured_pitch)
        # The measured value is the truth about where the shutter actually fired,
        # so it is used as-is. The target is only a sanity check against a bad
        # sensor sample, never a correction applied on top of a good one.
        if target_yaw is not None and target_pitch is not None:
            yaw_deviation = abs(_signed_angle_delta(float(target_yaw), yaw))
            pitch_deviation = abs(pitch - float(target_pitch))
            if max(yaw_deviation, pitch_deviation) > MAX_TRUSTED_TARGET_DEVIATION_DEGREES:
                yaw, pitch = float(target_yaw), float(target_pitch)
        return yaw, pitch, roll

    if target_yaw is not None and target_pitch is not None:
        return float(target_yaw), float(target_pitch), roll

    if item.get("yawDegrees") is not None and item.get("pitchDegrees") is not None:
        return float(item["yawDegrees"]), float(item["pitchDegrees"]), roll

    frame_index = _frame_index_from_key(key)
    if frame_index is None:
        frame_index = index
    if frame_index >= len(LEGACY_CAPTURE_TARGETS):
        return None
    yaw, pitch = LEGACY_CAPTURE_TARGETS[frame_index]
    return yaw, pitch, roll


def _load_frames(payload: dict[str, Any]) -> tuple[list[np.ndarray], list[tuple[float, float, float]], list[str]]:
    inputs = list(payload.get("inputs", []))
    undistort_k1 = float(payload.get("radialDistortionK1") or 0.0)
    horizontal_fov = float(
        payload.get("horizontalFovDegrees") or payload.get("fovDegrees") or DEFAULT_HFOV_DEG
    )

    images: list[np.ndarray] = []
    poses: list[tuple[float, float, float]] = []
    names: list[str] = []

    for index, item in enumerate(inputs):
        key = str(item["objectKey"])
        pose = _resolve_pose(item, index, key)
        if pose is None:
            continue

        raw = get_bytes(str(item["bucket"]), key)
        with Image.open(BytesIO(raw)) as source:
            upright = ImageOps.exif_transpose(source).convert("RGB")
            image = cv2.cvtColor(np.asarray(upright), cv2.COLOR_RGB2BGR)

        if abs(undistort_k1) > 1e-6:
            image = _undistort(image, horizontal_fov, undistort_k1)

        images.append(image)
        poses.append(pose)
        names.append(str(item.get("fileName") or key))
    return images, poses, names


def _undistort(image: np.ndarray, hfov_deg: float, k1: float) -> np.ndarray:
    """Optional single-parameter radial correction.

    Phone wide lenses have a few percent of barrel distortion, which makes the
    outer third of every frame disagree with its neighbour no matter how good the
    rotation solve is. If a per-device ``k1`` has been calibrated once with a
    chessboard, pass it in ``radialDistortionK1`` and it is removed here.
    """
    height, width = image.shape[:2]
    focal = (width / 2.0) / float(np.tan(np.radians(hfov_deg) / 2.0))
    camera_matrix = np.array(
        [[focal, 0.0, width / 2.0], [0.0, focal, height / 2.0], [0.0, 0.0, 1.0]], dtype=np.float64
    )
    distortion = np.array([k1, 0.0, 0.0, 0.0, 0.0], dtype=np.float64)
    return cv2.undistort(image, camera_matrix, distortion, None, camera_matrix)


# ---------------------------------------------------------------------------
# Wrap-around handling
# ---------------------------------------------------------------------------


def _yaw_rotation(degrees: float) -> np.ndarray:
    angle = np.radians(float(degrees))
    return np.array(
        [
            [np.cos(angle), 0.0, np.sin(angle)],
            [0.0, 1.0, 0.0],
            [-np.sin(angle), 0.0, np.cos(angle)],
        ],
        dtype=np.float32,
    )


def _align_wrap_meridian(rotations: list[np.ndarray]) -> tuple[list[np.ndarray], float]:
    """Rotate the panorama so the +-180 meridian sits inside one frame.

    An equirectangular canvas is cut open at longitude +-180. If that cut falls
    between two frames, the left and right edges of the image come from different
    photographs and the viewer shows a hard vertical seam where the sphere closes.
    Placing the cut at the centre of a single frame makes both edges the same
    photograph, so the sphere closes continuously.
    """
    if not rotations:
        return rotations, 0.0
    yaws = [pose_from_rotation(rotation)[0] for rotation in rotations]
    pitches = [abs(pose_from_rotation(rotation)[1]) for rotation in rotations]

    # Prefer a horizon frame; caps cover every longitude and anchor nothing.
    candidates = [i for i, pitch in enumerate(pitches) if pitch < 60.0] or list(range(len(yaws)))
    best = min(candidates, key=lambda i: abs(_signed_angle_delta(180.0, yaws[i])))
    offset = _signed_angle_delta(yaws[best], 180.0)
    if abs(offset) < 1e-3:
        return rotations, 0.0
    shift = _yaw_rotation(offset)
    return [(shift @ np.asarray(r, dtype=np.float32)).astype(np.float32) for r in rotations], float(
        offset
    )


# ---------------------------------------------------------------------------
# Fallback assembly
# ---------------------------------------------------------------------------


def _legacy_assemble(
    images: list[np.ndarray],
    poses: list[tuple[float, float, float]],
    horizontal_fov: float,
    vertical_fov: float | None,
) -> tuple[np.ndarray, np.ndarray]:
    frames: list[dict[str, Any]] = []
    for image, (yaw, pitch, roll) in zip(images, poses):
        height, width = image.shape[:2]
        frame_vertical_fov = (
            float(vertical_fov)
            if vertical_fov is not None
            else float(
                2.0
                * np.degrees(
                    np.arctan(
                        np.tan(np.radians(horizontal_fov) / 2.0) * height / max(width, 1)
                    )
                )
            )
        )
        frames.append(
            {
                "image": image,
                "yawDegrees": yaw % 360.0,
                "pitchDegrees": pitch,
                "rollDegrees": float(np.clip(roll, -15.0, 15.0)),
                "horizontalFovDegrees": horizontal_fov,
                "verticalFovDegrees": frame_vertical_fov,
            }
        )
    return project_equirectangular(_normalize_exposure(frames))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def stitch_panorama(payload: dict[str, Any]) -> dict[str, Any]:
    inputs = list(payload.get("inputs", []))
    if len(inputs) < 3:
        raise ValueError("At least three guided-capture frames are required.")

    capture_pattern = str(payload.get("capturePattern") or LEGACY_GUIDED)
    images, poses, _names = _load_frames(payload)
    if len(images) < 3:
        raise ValueError("Could not determine orientations for enough frames to build a panorama.")

    horizontal_fov = float(
        payload.get("horizontalFovDegrees") or payload.get("fovDegrees") or DEFAULT_HFOV_DEG
    )
    explicit_vertical_fov = payload.get("verticalFovDegrees")
    height, width = images[0].shape[:2]
    vertical_fov = (
        float(explicit_vertical_fov)
        if explicit_vertical_fov is not None
        else float(
            2.0
            * np.degrees(
                np.arctan(np.tan(np.radians(horizontal_fov) / 2.0) * height / max(width, 1))
            )
        )
    )

    alignment_enabled = bool(payload.get("refineAlignment", True))
    alignment: dict[str, Any]
    if alignment_enabled:
        alignment = refine_alignment(images, poses, horizontal_fov, vertical_fov)
    else:
        alignment = {
            "rotations": [rotation_from_pose(*pose) for pose in poses],
            "focals": [(width / 2.0) / np.tan(np.radians(horizontal_fov) / 2.0)] * len(images),
            "diagnostics": {"method": "DISABLED", "notes": ["refinement_disabled_by_payload"]},
        }

    rotations, heading_offset = _align_wrap_meridian(alignment["rotations"])

    blend_mode = "SEAM_CUT_MULTIBAND"
    composite_metrics: dict[str, Any] = {}
    try:
        panorama, covered, composite_metrics = compose_spherical(
            images, rotations, alignment["focals"], OUT_W, OUT_H
        )
    except (cv2.error, ValueError) as exc:
        LOGGER.warning("Seam-cut compositing failed, using pose projection: %s", exc)
        shifted_poses = [pose_from_rotation(rotation) for rotation in rotations]
        panorama, covered = _legacy_assemble(images, shifted_poses, horizontal_fov, explicit_vertical_fov)
        blend_mode = "POSE_PROJECTION_HIGH_DOMINANCE_FEATHER"

    raw_coverage_ratio = float(np.mean(covered))
    equator_coverage_ratio = float(np.mean(covered[OUT_H // 2]))
    measured_min_pitch, measured_max_pitch = _covered_pitch_range(covered, OUT_H)

    if capture_pattern == QUICK_CENTRAL_RING:
        panorama = _fill_quick_view_uncovered(panorama, covered)
        projection_type = "EQUIRECTANGULAR_LIMITED"
        min_pitch = float(payload.get("minPitchDegrees") or measured_min_pitch)
        max_pitch = float(payload.get("maxPitchDegrees") or measured_max_pitch)
    else:
        panorama = _fill_full_sphere_holes(panorama, covered)
        projection_type = "EQUIRECTANGULAR_FULL_SPHERE"
        min_pitch, max_pitch = -90.0, 90.0

    ok, encoded = cv2.imencode(".jpg", panorama, [int(cv2.IMWRITE_JPEG_QUALITY), 91])
    if not ok:
        raise ValueError("Failed to encode the assembled panorama.")

    output_bucket = str(payload["outputBucket"])
    output_key = str(payload["outputKey"])
    data = encoded.tobytes()
    put_bytes(output_bucket, output_key, data, "image/jpeg")
    qa = analyze_panorama({"bucket": output_bucket, "objectKey": output_key})

    diagnostics = dict(alignment.get("diagnostics", {}))
    disagreement = float(composite_metrics.get("overlapDisagreement", 0.0))

    extra_issues: list[str] = []
    if equator_coverage_ratio < 0.97:
        extra_issues.append("incomplete_horizontal_coverage")
    if capture_pattern == FULL_TWO_RINGS_WITH_CAPS and raw_coverage_ratio < 0.90:
        extra_issues.append("incomplete_spherical_coverage")
    if diagnostics.get("method") not in {"BUNDLE_ADJUSTED_RAY", "DISABLED"}:
        extra_issues.append("alignment_not_refined_from_images")
    if diagnostics.get("refinedFrameCount", 0) and diagnostics["refinedFrameCount"] < len(images):
        extra_issues.append("some_frames_kept_sensor_pose")
    if disagreement >= PARALLAX_FAILURE_THRESHOLD:
        extra_issues.append("severe_overlap_mismatch_recapture_required")
    elif disagreement >= PARALLAX_WARNING_THRESHOLD:
        extra_issues.append("overlap_mismatch_parallax_suspected")

    if extra_issues:
        hard = {"severe_overlap_mismatch_recapture_required", "incomplete_horizontal_coverage"}
        if any(issue in hard for issue in extra_issues):
            qa["approved"] = False
        qa["issues"] = list(dict.fromkeys(list(qa.get("issues", [])) + extra_issues))
        qa["qualityScore"] = max(0, int(qa.get("qualityScore", 100)) - 12 * len(extra_issues))

    return {
        "outputBucket": output_bucket,
        "outputKey": output_key,
        "sizeBytes": len(data),
        "mimeType": "image/jpeg",
        "qa": qa,
        "capturePattern": capture_pattern,
        "projectionType": projection_type,
        "minPitchDegrees": round(min_pitch, 3),
        "maxPitchDegrees": round(max_pitch, 3),
        "frameCount": len(images),
        "rawCoverageRatio": round(raw_coverage_ratio, 4),
        "equatorCoverageRatio": round(equator_coverage_ratio, 4),
        "blendMode": blend_mode,
        # Degrees the panorama was rotated to place the wrap meridian inside a
        # single frame. Subtract this in the viewer to restore the heading the
        # operator started the capture from.
        "headingOffsetDegrees": round(heading_offset, 3),
        "alignment": diagnostics,
        "composite": {k: (round(v, 4) if isinstance(v, float) else v) for k, v in composite_metrics.items()},
        "warning": (
            "Nearby objects can still show parallax if the camera moves away from the capture point. "
            "Use the normal 1x camera, pivot the phone around the lens rather than around your body, "
            "and keep close furniture away from the lens."
        ),
    }
