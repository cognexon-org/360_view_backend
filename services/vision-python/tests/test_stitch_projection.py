import numpy as np

from app.processors.stitch import (
    _fill_quick_view_uncovered,
    project_equirectangular,
)


def frame(image, yaw, pitch):
    return {
        "image": image,
        "yawDegrees": yaw,
        "pitchDegrees": pitch,
        "rollDegrees": 0.0,
        "horizontalFovDegrees": 52.0,
        "verticalFovDegrees": 68.0,
    }


def test_quick_ring_covers_equator_and_has_no_black_after_limited_fill():
    image = np.full((160, 120, 3), 128, dtype=np.uint8)
    frames = [frame(image, index * 36.0, 0.0) for index in range(10)]
    panorama, covered = project_equirectangular(frames, out_w=512, out_h=256)

    assert covered[128].mean() > 0.99
    filled = _fill_quick_view_uncovered(panorama, covered)
    assert filled.mean() > 100
    assert np.min(filled) > 0


def test_two_rings_and_caps_cover_full_sphere():
    image = np.full((160, 120, 3), 128, dtype=np.uint8)
    frames = [frame(image, index * 36.0, -30.0) for index in range(10)]
    frames += [frame(image, (index * 36.0 + 18.0) % 360.0, 30.0) for index in range(10)]
    frames += [frame(image, 0.0, -82.0), frame(image, 180.0, 82.0)]

    _, covered = project_equirectangular(frames, out_w=512, out_h=256)
    assert covered.mean() > 0.98
    assert covered[128].mean() > 0.99
