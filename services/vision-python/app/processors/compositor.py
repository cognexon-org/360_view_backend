"""Spherical compositing with exposure compensation, seam cutting and blending.

Why this replaces the old weighted average
------------------------------------------
The previous compositor averaged every frame that covered a pixel, weighted by
distance from the frame centre raised to a high power. Averaging is the wrong
operator for overlapping photographs: wherever two frames disagree even slightly
about where a thing is, the average shows *both* copies. That is exactly the
"collision" and doubled furniture seen in the room panoramas. Raising the blend
power only narrows the band in which the ghost appears; it never removes it, and
it trades the ghost for a visible content jump.

The fix is the standard three-stage composite:

1. **Exposure compensation** - per-block, per-channel gains remove the brightness
   and white-balance drift that CameraX introduces between shots, and also
   flatten lens vignetting. Seams stop being visible as brightness steps.
2. **Seam cutting** - a graph cut finds the path through each overlap where the
   two frames agree most. Every output pixel then comes from exactly one frame,
   so a misaligned object is cut around rather than duplicated.
3. **Multi-band blending** - low frequencies are blended over a wide band and
   high frequencies over a narrow one, so the cut is invisible without smearing
   detail across it.

The canvas is the OpenCV spherical projection with ``scale = out_w / 2*pi``,
which is exactly a 2:1 equirectangular image: longitude runs across the full
width and latitude down the full height.
"""

from __future__ import annotations

import logging
from typing import Any

import cv2
import numpy as np

LOGGER = logging.getLogger("propertytour360-vision.compositor")

# Working resolution for exposure gains, seam search and quality metrics.
SEAM_LONG_SIDE = 1024

# Fraction of each frame's border discarded before warping. Uncorrected radial
# distortion and JPEG ringing are worst at the extreme edge, and the seam finder
# produces cleaner cuts when it is not offered that data.
EDGE_TRIM_FRACTION = 0.012

EXPOSURE_BLOCK_SIZE = 32


def _canvas_rect(out_w: int, out_h: int) -> tuple[int, int, int, int]:
    return (-out_w // 2, 0, out_w, out_h)


def _crop_to_canvas(
    corner: tuple[int, int],
    image: np.ndarray,
    mask: np.ndarray,
    rect: tuple[int, int, int, int],
) -> tuple[tuple[int, int], np.ndarray, np.ndarray] | None:
    """Clip a warped frame to the canvas so nothing addresses outside the sphere."""
    rx, ry, rw, rh = rect
    x, y = int(corner[0]), int(corner[1])
    h, w = image.shape[:2]

    left = max(x, rx)
    top = max(y, ry)
    right = min(x + w, rx + rw)
    bottom = min(y + h, ry + rh)
    if right <= left or bottom <= top:
        return None

    sub_image = image[top - y : bottom - y, left - x : right - x]
    sub_mask = mask[top - y : bottom - y, left - x : right - x]
    return (left, top), np.ascontiguousarray(sub_image), np.ascontiguousarray(sub_mask)


def _source_mask(shape: tuple[int, int]) -> np.ndarray:
    """Full-frame mask with the unreliable outer border trimmed away."""
    height, width = shape
    mask = np.zeros((height, width), np.uint8)
    trim_x = max(1, int(round(width * EDGE_TRIM_FRACTION)))
    trim_y = max(1, int(round(height * EDGE_TRIM_FRACTION)))
    mask[trim_y : height - trim_y, trim_x : width - trim_x] = 255
    return mask


def _overlap_disagreement(
    images: list[np.ndarray],
    masks: list[np.ndarray],
    corners: list[tuple[int, int]],
    rect: tuple[int, int, int, int],
) -> dict[str, float]:
    """Measure how much overlapping frames disagree after alignment.

    This is the honest quality signal for this pipeline. Once the frames are
    aligned, any remaining disagreement in an overlap is parallax (the phone
    rotated about the wrist rather than the lens), a moving subject, or residual
    misregistration - all of them things a blend cannot fix and the operator
    needs to know about before leaving the property.
    """
    rx, ry, rw, rh = rect
    scale = min(1.0, SEAM_LONG_SIDE / float(rw))
    small_w, small_h = max(1, int(rw * scale)), max(1, int(rh * scale))

    accumulator = np.zeros((small_h, small_w), np.float32)
    accumulator_sq = np.zeros((small_h, small_w), np.float32)
    counts = np.zeros((small_h, small_w), np.float32)

    for image, mask, corner in zip(images, masks, corners):
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32)
        canvas = np.zeros((rh, rw), np.float32)
        canvas_mask = np.zeros((rh, rw), np.uint8)
        x, y = corner[0] - rx, corner[1] - ry
        h, w = gray.shape[:2]
        canvas[y : y + h, x : x + w] = gray
        canvas_mask[y : y + h, x : x + w] = mask

        small = cv2.resize(canvas, (small_w, small_h), interpolation=cv2.INTER_AREA)
        small_mask = (
            cv2.resize(canvas_mask, (small_w, small_h), interpolation=cv2.INTER_AREA) > 200
        ).astype(np.float32)
        accumulator += small * small_mask
        accumulator_sq += (small**2) * small_mask
        counts += small_mask

    overlapped = counts >= 2
    if not overlapped.any():
        return {"overlapRatio": 0.0, "overlapDisagreement": 0.0, "overlapDisagreementP95": 0.0}

    mean = accumulator[overlapped] / counts[overlapped]
    mean_sq = accumulator_sq[overlapped] / counts[overlapped]
    deviation = np.sqrt(np.maximum(mean_sq - mean**2, 0.0))
    covered = counts >= 1
    return {
        "overlapRatio": float(overlapped.sum() / max(covered.sum(), 1)),
        "overlapDisagreement": float(np.mean(deviation)),
        "overlapDisagreementP95": float(np.percentile(deviation, 95)),
    }


def compose_spherical(
    images: list[np.ndarray],
    rotations: list[np.ndarray],
    focals: list[float],
    out_w: int,
    out_h: int,
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    """Warp, compensate, seam-cut and blend frames into an equirectangular canvas.

    Returns the panorama, a boolean coverage mask and a metrics dict.
    """
    scale = out_w / (2.0 * np.pi)
    rect = _canvas_rect(out_w, out_h)
    warper = cv2.PyRotationWarper("spherical", scale)

    corners: list[tuple[int, int]] = []
    warped_images: list[np.ndarray] = []
    warped_masks: list[np.ndarray] = []

    for image, rotation, focal in zip(images, rotations, focals):
        # Resample the source so one source pixel maps to about one canvas pixel.
        # Warping a 12 MP frame straight into a 600 px wide slice aliases badly;
        # INTER_AREA downsampling first is what keeps fine texture clean.
        resample = float(np.clip(scale / max(float(focal), 1e-6), 0.05, 4.0))
        interpolation = cv2.INTER_AREA if resample < 1.0 else cv2.INTER_CUBIC
        resized = cv2.resize(image, None, fx=resample, fy=resample, interpolation=interpolation)
        height, width = resized.shape[:2]

        intrinsics = np.array(
            [[scale, 0.0, width / 2.0], [0.0, scale, height / 2.0], [0.0, 0.0, 1.0]],
            dtype=np.float32,
        )
        rotation32 = np.ascontiguousarray(rotation, dtype=np.float32)

        corner, warped = warper.warp(
            resized, intrinsics, rotation32, cv2.INTER_LINEAR, cv2.BORDER_REFLECT
        )
        _, warped_mask = warper.warp(
            _source_mask((height, width)),
            intrinsics,
            rotation32,
            cv2.INTER_NEAREST,
            cv2.BORDER_CONSTANT,
        )
        clipped = _crop_to_canvas(corner, warped, warped_mask, rect)
        if clipped is None:
            continue
        clipped_corner, clipped_image, clipped_mask = clipped
        corners.append(clipped_corner)
        warped_images.append(clipped_image)
        warped_masks.append(clipped_mask)

    if not warped_images:
        raise ValueError("No frame projected onto the panorama canvas.")

    metrics: dict[str, Any] = {"composedFrameCount": len(warped_images)}
    metrics.update(_overlap_disagreement(warped_images, warped_masks, corners, rect))

    # ---- Stage 1: exposure and white balance compensation --------------------
    seam_scale = min(1.0, SEAM_LONG_SIDE / float(out_w))
    seam_images: list[np.ndarray] = []
    seam_masks: list[np.ndarray] = []
    seam_corners: list[tuple[int, int]] = []
    for image, mask, corner in zip(warped_images, warped_masks, corners):
        small = cv2.resize(image, None, fx=seam_scale, fy=seam_scale, interpolation=cv2.INTER_AREA)
        small_mask = cv2.resize(
            mask, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_NEAREST
        )
        seam_images.append(small)
        seam_masks.append(small_mask)
        seam_corners.append((int(round(corner[0] * seam_scale)), int(round(corner[1] * seam_scale))))

    try:
        compensator = cv2.detail_BlocksChannelsCompensator(
            EXPOSURE_BLOCK_SIZE, EXPOSURE_BLOCK_SIZE, 1
        )
        compensator.feed(seam_corners, seam_images, seam_masks)
        for index in range(len(warped_images)):
            compensator.apply(index, corners[index], warped_images[index], warped_masks[index])
        metrics["exposureCompensation"] = "BLOCKS_CHANNELS"
    except cv2.error as exc:
        LOGGER.warning("Exposure compensation skipped: %s", exc)
        metrics["exposureCompensation"] = "NONE"

    # ---- Stage 2: seam cutting ----------------------------------------------
    final_masks = warped_masks
    try:
        seam_finder = cv2.detail_GraphCutSeamFinder("COST_COLOR")
        seam_input = [image.astype(np.float32) for image in seam_images]
        cut_masks = seam_finder.find(seam_input, seam_corners, [cv2.UMat(m) for m in seam_masks])
        final_masks = []
        for index, cut in enumerate(cut_masks):
            cut_np = cut.get() if isinstance(cut, cv2.UMat) else cut
            upscaled = cv2.resize(
                cut_np,
                (warped_masks[index].shape[1], warped_masks[index].shape[0]),
                interpolation=cv2.INTER_LINEAR,
            )
            # Dilate slightly so neighbouring cuts overlap and the blender has a
            # transition band to work with instead of a hard butt joint.
            upscaled = cv2.dilate(upscaled, np.ones((3, 3), np.uint8), iterations=2)
            final_masks.append(cv2.bitwise_and(upscaled, warped_masks[index]))
        metrics["seamFinder"] = "GRAPH_CUT_COLOR"
    except cv2.error as exc:
        LOGGER.warning("Graph cut seam finding failed, falling back: %s", exc)
        try:
            seam_finder = cv2.detail_DpSeamFinder("COLOR")
            cut_masks = seam_finder.find(
                [image.astype(np.float32) for image in seam_images], seam_corners, seam_masks
            )
            final_masks = [
                cv2.bitwise_and(
                    cv2.resize(
                        cut.get() if isinstance(cut, cv2.UMat) else cut,
                        (warped_masks[i].shape[1], warped_masks[i].shape[0]),
                        interpolation=cv2.INTER_LINEAR,
                    ),
                    warped_masks[i],
                )
                for i, cut in enumerate(cut_masks)
            ]
            metrics["seamFinder"] = "DYNAMIC_PROGRAMMING_COLOR"
        except cv2.error:
            metrics["seamFinder"] = "NONE"

    # ---- Stage 3: multi-band blending ---------------------------------------
    blender = cv2.detail_MultiBandBlender()
    blend_width = np.sqrt(float(out_w) * float(out_h)) * 0.02
    blender.setNumBands(int(np.clip(np.log2(max(blend_width, 2.0)) - 1.0, 1, 6)))
    blender.prepare(rect)
    for image, mask, corner in zip(warped_images, final_masks, corners):
        blender.feed(image.astype(np.int16), mask, corner)
    blended, blended_mask = blender.blend(None, None)

    panorama = np.clip(blended, 0, 255).astype(np.uint8)
    coverage = np.asarray(blended_mask) > 0

    if panorama.shape[0] != out_h or panorama.shape[1] != out_w:
        panorama = cv2.resize(panorama, (out_w, out_h), interpolation=cv2.INTER_LINEAR)
        coverage = (
            cv2.resize(
                coverage.astype(np.uint8), (out_w, out_h), interpolation=cv2.INTER_NEAREST
            )
            > 0
        )

    panorama, coverage = _repair_wrap_column(panorama, coverage)

    metrics["blendBandCount"] = int(blender.numBands())
    return panorama, coverage, metrics


def _repair_wrap_column(
    panorama: np.ndarray, coverage: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Close the hairline gap at longitude +-180.

    The spherical warper's bounding box for a frame straddling the antimeridian
    starts one pixel inside the canvas, so the outermost column can end up
    uncovered even when the sphere is fully captured. In a viewer that shows as a
    thin dark line running pole to pole. The two edge columns are neighbours on
    the sphere, so each can simply borrow from the other.
    """
    for source, destination in ((-1, 0), (0, -1)):
        gap = ~coverage[:, destination] & coverage[:, source]
        if gap.any():
            panorama[gap, destination] = panorama[gap, source]
            coverage[gap, destination] = True
    return panorama, coverage
