"""Pose-aware panorama assembly.

Instead of feature-based OpenCV stitching (which fails on plain room walls),
this projects each guided-capture frame onto a 2:1 equirectangular canvas using
the *known* yaw/pitch each frame was aimed at. The guided capture aims at 26
fixed targets and saves each shot as frame_00.jpg .. frame_25.jpg, so the angle
for each photo is recovered from its filename index (or from explicit
yawDegrees/pitchDegrees if the client sends them).
"""

import re
from io import BytesIO
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageOps

from ..storage import get_bytes, put_bytes
from .panorama import analyze_panorama

# 26-point capture sphere (index -> (yawDeg, pitchDeg)). Pitch positive = DOWN,
# matching the Android capture targets (Ceiling -78, Floor +78).
CAPTURE_TARGETS: list[tuple[float, float]] = (
    [(y, 0.0) for y in (0, 45, 90, 135, 180, 225, 270, 315)]
    + [(y, -42.0) for y in (22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5)]
    + [(y, 42.0) for y in (0, 45, 90, 135, 180, 225, 270, 315)]
    + [(0.0, -78.0), (180.0, 78.0)]
)

OUT_W = 4096
OUT_H = 2048

# ---- THE ONE KNOB TO TUNE PER PHONE ----
# Horizontal field of view (in degrees) of ONE upright captured photo, measured
# across the SHORT side if the phone captures in portrait. Typical phone main
# cameras land around 60-68 in portrait. If the assembled 360 looks squeezed /
# seams overlap -> lower this. If it looks stretched / gaps at seams -> raise it.
DEFAULT_HFOV_DEG = 64.0


def _frame_index_from_key(key: str) -> int | None:
    m = re.search(r"frame[_-]?(\d+)", key, re.IGNORECASE)
    return int(m.group(1)) if m else None


def _camera_basis(yaw_deg: float, pitch_deg: float):
    """Forward/right/up unit vectors for a camera aimed at (yaw, pitch).
    World axes: x=right, y=up, z=forward. elevation = -pitch (pitch down positive)."""
    yaw = np.radians(yaw_deg)
    elev = np.radians(-pitch_deg)
    forward = np.array([
        np.cos(elev) * np.sin(yaw),
        np.sin(elev),
        np.cos(elev) * np.cos(yaw),
    ])
    world_up = np.array([0.0, 1.0, 0.0])
    right = np.cross(world_up, forward)
    n = np.linalg.norm(right)
    right = np.array([1.0, 0.0, 0.0]) if n < 1e-6 else right / n
    up = np.cross(forward, right)
    return forward, right, up


def _direction_grid(w: int, h: int):
    xs = (np.arange(w, dtype=np.float32) + 0.5) / w
    ys = (np.arange(h, dtype=np.float32) + 0.5) / h
    lon = (xs * 2.0 - 1.0) * np.pi        # -pi .. pi
    lat = (0.5 - ys) * np.pi              # +pi/2 (top) .. -pi/2 (bottom)
    lon2, lat2 = np.meshgrid(lon, lat)
    clat = np.cos(lat2)
    dx = (clat * np.sin(lon2)).astype(np.float32)
    dy = np.sin(lat2).astype(np.float32)
    dz = (clat * np.cos(lon2)).astype(np.float32)
    return dx, dy, dz


def project_equirectangular(frames, hfov_deg=DEFAULT_HFOV_DEG, out_w=OUT_W, out_h=OUT_H):
    """frames: list of (bgr_uint8, yaw_deg, pitch_deg). Returns BGR uint8 equirect."""
    dx, dy, dz = _direction_grid(out_w, out_h)
    accum = np.zeros((out_h, out_w, 3), np.float32)
    wsum = np.zeros((out_h, out_w), np.float32)

    for arr, yaw, pitch in frames:
        fh, fw = arr.shape[:2]
        vfov = 2.0 * np.degrees(np.arctan(np.tan(np.radians(hfov_deg) / 2.0) * fh / fw))
        th = np.tan(np.radians(hfov_deg) / 2.0)
        tv = np.tan(np.radians(vfov) / 2.0)

        forward, right, up = _camera_basis(yaw, pitch)
        lz = dx * forward[0] + dy * forward[1] + dz * forward[2]
        valid = lz > 1e-3
        lz_safe = np.where(valid, lz, 1.0)
        lx = dx * right[0] + dy * right[1] + dz * right[2]
        ly = dx * up[0] + dy * up[1] + dz * up[2]
        u = (lx / lz_safe) / th          # -1..1 across width
        v = (ly / lz_safe) / tv          # -1..1 across height (up positive)
        in_frame = valid & (np.abs(u) <= 1.0) & (np.abs(v) <= 1.0)

        map_x = ((u * 0.5 + 0.5) * (fw - 1)).astype(np.float32)
        map_y = ((0.5 - v * 0.5) * (fh - 1)).astype(np.float32)  # image y grows down
        sampled = cv2.remap(arr, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

        # Feather toward frame edges so overlaps blend smoothly.
        w = np.clip(1.0 - np.abs(u), 0, 1) * np.clip(1.0 - np.abs(v), 0, 1)
        w = np.where(in_frame, w * w, 0.0).astype(np.float32)
        accum += sampled.astype(np.float32) * w[..., None]
        wsum += w

    out = np.zeros_like(accum)
    covered = wsum > 1e-6
    out[covered] = accum[covered] / wsum[covered, None]
    out8 = np.clip(out, 0, 255).astype(np.uint8)

    # Fill any small uncovered gaps (e.g. at the poles) so QA brightness passes.
    holes = (~covered).astype(np.uint8) * 255
    if holes.any() and holes.mean() < 60:  # only if gaps are modest
        out8 = cv2.inpaint(out8, holes, 3, cv2.INPAINT_TELEA)
    return out8


def stitch_panorama(payload: dict[str, Any]) -> dict[str, Any]:
    inputs = list(payload.get("inputs", []))
    if len(inputs) < 3:
        raise ValueError("At least three guided-capture frames are required.")

    hfov = float(payload.get("fovDegrees", DEFAULT_HFOV_DEG))
    frames: list[tuple[np.ndarray, float, float]] = []
    for i, item in enumerate(inputs):
        raw = get_bytes(str(item["bucket"]), str(item["objectKey"]))
        with Image.open(BytesIO(raw)) as image:
            # Honour the camera's EXIF rotation so the photo is upright before projecting.
            upright = ImageOps.exif_transpose(image).convert("RGB")
            arr = cv2.cvtColor(np.asarray(upright), cv2.COLOR_RGB2BGR)

        if item.get("yawDegrees") is not None and item.get("pitchDegrees") is not None:
            yaw, pitch = float(item["yawDegrees"]), float(item["pitchDegrees"])
        else:
            idx = _frame_index_from_key(str(item["objectKey"]))
            if idx is None or idx >= len(CAPTURE_TARGETS):
                idx = i
            if idx >= len(CAPTURE_TARGETS):
                continue
            yaw, pitch = CAPTURE_TARGETS[idx]
        frames.append((arr, yaw, pitch))

    if len(frames) < 3:
        raise ValueError("Could not determine orientations for enough frames to build a 360.")

    panorama = project_equirectangular(frames, hfov_deg=hfov)

    ok, encoded = cv2.imencode(".jpg", panorama, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
    if not ok:
        raise ValueError("Failed to encode the assembled panorama.")

    output_bucket = str(payload["outputBucket"])
    output_key = str(payload["outputKey"])
    data = encoded.tobytes()
    put_bytes(output_bucket, output_key, data, "image/jpeg")
    qa = analyze_panorama({"bucket": output_bucket, "objectKey": output_key})
    return {
        "outputBucket": output_bucket,
        "outputKey": output_key,
        "sizeBytes": len(data),
        "mimeType": "image/jpeg",
        "qa": qa,
        "warning": (
            "Assembled by pose-aware projection from guided-capture angles. "
            "Seams may show slight parallax on nearby objects; capture from the room "
            "centre and keep the phone steady for best results."
        ),
    }