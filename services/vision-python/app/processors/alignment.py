"""IMU-seeded, image-based pose refinement for Mode A guided panorama capture.

Why this module exists
----------------------
The original pipeline projected every frame using the raw phone orientation and a
*nominal* field of view, then averaged overlaps. That is open-loop: every error
source lands directly on the canvas as a misregistration.

  * 1 degree of residual yaw error  ~= 11 px of double-edge at 4096 px wide
  * 2 percent of field-of-view error ~= a scale mismatch that no blend can hide
  * relative yaw from GAME_ROTATION_VECTOR drifts over a 10-shot sweep
  * autofocus "breathing" changes the effective focal length between frames

This module closes the loop. The IMU pose is demoted from "answer" to "initial
guess", and the actual image content decides the final rotations and the shared
focal length via a global bundle adjustment in ray space.

The IMU is still valuable and is not thrown away:

  * it supplies the initialisation, so the bundle adjuster starts in the right
    basin and converges instead of folding the panorama onto itself
  * it prunes the match graph, so only frame pairs that plausibly overlap are
    matched (this is what makes matching fast and robust in low-texture rooms)
  * gravity from the accelerometer is exact, so the final solution is rotated
    back onto the measured horizon instead of guessing with waveCorrect()
  * frames that fail to match anything (blank wall, dark ceiling) silently fall
    back to their IMU pose rather than being dropped
"""

from __future__ import annotations

import logging
from typing import Any

import cv2
import numpy as np

LOGGER = logging.getLogger("propertytour360-vision.alignment")

# Long side used for feature detection. Panorama alignment does not need full
# resolution; 1000 px keeps SIFT fast while still resolving wall texture.
FEATURE_LONG_SIDE = 1000

# Lowe-ratio style threshold used by BestOf2NearestMatcher.
MATCH_CONFIDENCE = 0.30

# Pair confidence below this is ignored by the bundle adjuster.
BA_CONFIDENCE_THRESHOLD = 0.9

# A pair needs meaningfully more than the four points a homography requires
# before it is allowed to influence the global solve.
MIN_PAIR_INLIERS = 14

# Ceiling applied when recomputing pair confidence, so one extremely rich pair
# cannot dominate the bundle adjustment.
MAX_PAIR_CONFIDENCE = 8.0

# Looser thresholds used only for the neighbour-restricted retry pass.
RELAXED_MATCH_CONFIDENCE = 0.20
RELAXED_MIN_PAIR_INLIERS = 9

# A refined pose further than this from the IMU pose is treated as a bad solve
# for that frame and reverted. Guided capture is never off by this much.
MAX_POSE_CORRECTION_DEGREES = 22.0

# The bundle adjuster may only move the focal length this far from the
# Camera2-derived estimate. Wider than this means the solve went wrong.
FOCAL_TOLERANCE = 0.35

# World axis convention used throughout: x right, y DOWN, z forward.
# This matches OpenCV's SphericalProjector, so rotations produced here can be
# handed straight to cv2.PyRotationWarper without any further conversion.
_Y_FLIP = np.diag([1.0, -1.0, 1.0]).astype(np.float64)


# ---------------------------------------------------------------------------
# Pose <-> rotation matrix
# ---------------------------------------------------------------------------


def rotation_from_pose(yaw_deg: float, pitch_deg: float, roll_deg: float = 0.0) -> np.ndarray:
    """Camera-to-world rotation for a capture pose.

    Columns are (right, down, forward) expressed in the y-down world frame.
    Capture pitch is positive looking down, matching the Android client.
    """
    yaw = np.radians(float(yaw_deg))
    elevation = np.radians(-float(pitch_deg))

    forward = np.array(
        [
            np.cos(elevation) * np.sin(yaw),
            np.sin(elevation),
            np.cos(elevation) * np.cos(yaw),
        ],
        dtype=np.float64,
    )
    world_up = np.array([0.0, 1.0, 0.0])
    right = np.cross(world_up, forward)
    norm = float(np.linalg.norm(right))
    right = np.array([1.0, 0.0, 0.0]) if norm < 1e-8 else right / norm
    up = np.cross(forward, right)

    if abs(float(roll_deg)) > 1e-6:
        roll = np.radians(float(roll_deg))
        cos_roll, sin_roll = np.cos(roll), np.sin(roll)
        right, up = right * cos_roll + up * sin_roll, -right * sin_roll + up * cos_roll

    # y-up basis -> y-down world, and camera "up" -> camera "down".
    rotation = np.column_stack(
        [_Y_FLIP @ right, -(_Y_FLIP @ up), _Y_FLIP @ forward]
    )
    return _orthonormalize(rotation).astype(np.float32)


def pose_from_rotation(rotation: np.ndarray) -> tuple[float, float, float]:
    """Inverse of :func:`rotation_from_pose`, used for diagnostics."""
    rotation = np.asarray(rotation, dtype=np.float64)
    forward = _Y_FLIP @ rotation[:, 2]
    down = _Y_FLIP @ rotation[:, 1]
    up = -down

    yaw = float(np.degrees(np.arctan2(forward[0], forward[2])) % 360.0)
    pitch = float(-np.degrees(np.arcsin(np.clip(forward[1], -1.0, 1.0))))

    reference_right = np.cross(np.array([0.0, 1.0, 0.0]), forward)
    norm = float(np.linalg.norm(reference_right))
    if norm < 1e-8:
        return yaw, pitch, 0.0
    reference_right /= norm
    reference_up = np.cross(forward, reference_right)
    roll = float(
        np.degrees(np.arctan2(-float(np.dot(up, reference_right)), float(np.dot(up, reference_up))))
    )
    return yaw, pitch, roll


def _orthonormalize(matrix: np.ndarray) -> np.ndarray:
    u, _, vt = np.linalg.svd(np.asarray(matrix, dtype=np.float64))
    rotation = u @ vt
    if np.linalg.det(rotation) < 0:
        u[:, -1] *= -1.0
        rotation = u @ vt
    return rotation


def angular_difference_degrees(a: np.ndarray, b: np.ndarray) -> float:
    """Geodesic angle between two rotations, in degrees.

    Uses the chord length rather than the trace: ``arccos`` of a trace-derived
    cosine loses all precision near identity, which matters because comparing a
    float32 rotation with itself must return zero, not a spurious hundredth of a
    degree that trips the "did refinement move this frame" checks.
    """
    difference = np.asarray(a, dtype=np.float64) - np.asarray(b, dtype=np.float64)
    chord = float(np.linalg.norm(difference)) / (2.0 * np.sqrt(2.0))
    return float(np.degrees(2.0 * np.arcsin(np.clip(chord, 0.0, 1.0))))


# ---------------------------------------------------------------------------
# Features and matching
# ---------------------------------------------------------------------------


def _build_detector() -> tuple[Any, str]:
    try:
        return cv2.SIFT_create(nfeatures=2500), "SIFT"
    except Exception:  # pragma: no cover - only on unusual OpenCV builds
        return cv2.ORB_create(nfeatures=4000), "ORB"


def _detect_features(images: list[np.ndarray]) -> tuple[list[Any], float, str]:
    """Detect features on downscaled grayscale copies.

    Returns the feature list, the scale factor applied to the source images and
    the detector name. Keypoint coordinates live in the downscaled space, so the
    focal length handed to the bundle adjuster must be scaled the same way.
    """
    detector, detector_name = _build_detector()
    longest = max(max(image.shape[:2]) for image in images)
    scale = min(1.0, FEATURE_LONG_SIDE / float(longest))

    features: list[Any] = []
    for index, image in enumerate(images):
        if scale < 1.0:
            work = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        else:
            work = image
        gray = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)
        # Mild CLAHE lifts keypoint counts on flat, evenly painted interior walls,
        # which is the dominant failure case for this kind of capture.
        gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
        feature = cv2.detail.computeImageFeatures2(detector, gray)
        feature.img_idx = index
        features.append(feature)
    return features, scale, detector_name


def _overlap_mask(rotations: list[np.ndarray], hfov_deg: float, vfov_deg: float) -> np.ndarray:
    """Only match frame pairs whose optical axes are close enough to overlap.

    Matching every pair is both slow and a source of false positives when a room
    has repeated texture (tiles, identical windows, patterned curtains). The IMU
    tells us which pairs are geometrically plausible, so we ask for those only.
    """
    count = len(rotations)
    threshold = float(np.clip(max(hfov_deg, vfov_deg) * 1.15, 55.0, 150.0))
    mask = np.zeros((count, count), dtype=np.uint8)
    for i in range(count):
        forward_i = np.asarray(rotations[i], dtype=np.float64)[:, 2]
        for j in range(i + 1, count):
            forward_j = np.asarray(rotations[j], dtype=np.float64)[:, 2]
            angle = np.degrees(np.arccos(np.clip(float(np.dot(forward_i, forward_j)), -1.0, 1.0)))
            if angle <= threshold:
                mask[i, j] = 1
                mask[j, i] = 1
    return mask


def _restore_pair_confidence(pairwise: list[Any]) -> None:
    """Undo OpenCV's "images are too similar" confidence clamp.

    ``BestOf2NearestMatcher`` zeroes the confidence of any pair scoring above 3.0,
    on the assumption that near-duplicate images add nothing to a general-purpose
    stitch. Guided capture deliberately produces 35-45 percent overlap, so this
    heuristic throws away precisely the strongest links in the ring and leaves the
    bundle adjuster with only the weak, noisy pairs. Confidence is recomputed here
    with the same formula minus the clamp, and capped so one very rich pair cannot
    outvote the rest of the graph.
    """
    for match in pairwise:
        if match.src_img_idx < 0 or match.dst_img_idx < 0:
            continue
        match_count = len(match.getMatches())
        inliers = int(match.num_inliers)
        if match_count == 0 or inliers < MIN_PAIR_INLIERS:
            match.confidence = 0.0
            continue
        match.confidence = float(
            min(inliers / (8.0 + 0.3 * match_count), MAX_PAIR_CONFIDENCE)
        )


def _second_chance_matching(
    features: list[Any],
    pairwise: list[Any],
    rotations: list[np.ndarray],
    component: set[int],
    count: int,
) -> int:
    """Retry stranded frames against their nearest neighbours, permissively.

    A blank painted wall is the most common real failure in interior capture: one
    or two frames in the ring find nothing to match and drop out of the graph,
    which leaves them at the raw sensor pose and reintroduces ghosting in just
    that part of the room. Those frames get a second attempt with a looser ratio
    test, restricted to the handful of neighbours the IMU says they overlap. The
    restriction is what makes the looser threshold safe: a false match can only
    happen between frames already known to be pointing at nearly the same wall,
    and the global correction limit still catches a bad solve.
    """
    stranded = [index for index in range(count) if index not in component]
    if not stranded or not component:
        return 0

    mask = np.zeros((count, count), dtype=np.uint8)
    for index in stranded:
        forward = np.asarray(rotations[index], dtype=np.float64)[:, 2]
        neighbours = sorted(
            (i for i in range(count) if i != index),
            key=lambda i: -float(np.dot(forward, np.asarray(rotations[i], dtype=np.float64)[:, 2])),
        )[:4]
        for neighbour in neighbours:
            mask[index, neighbour] = 1
            mask[neighbour, index] = 1

    matcher = cv2.detail_BestOf2NearestMatcher.create(False, RELAXED_MATCH_CONFIDENCE)
    retry = matcher.apply2(features, mask)
    matcher.collectGarbage()

    recovered = 0
    for source in range(count):
        for destination in range(count):
            if not mask[source, destination]:
                continue
            candidate = retry[source * count + destination]
            if int(candidate.num_inliers) < RELAXED_MIN_PAIR_INLIERS:
                continue
            match_count = len(candidate.getMatches())
            if match_count == 0:
                continue
            candidate.confidence = float(
                min(int(candidate.num_inliers) / (8.0 + 0.3 * match_count), MAX_PAIR_CONFIDENCE)
            )
            if candidate.confidence <= BA_CONFIDENCE_THRESHOLD:
                continue
            pairwise[source * count + destination] = candidate
            if source < destination:
                recovered += 1
    return recovered


def _largest_component(count: int, pairs: list[tuple[int, int]]) -> set[int]:
    """Largest set of frames linked by confident matches.

    Frames outside it are in their own arbitrary global frame after bundle
    adjustment, so blending them in would tear the panorama. They keep their IMU
    pose instead, which is at least consistent with everything else.
    """
    parent = list(range(count))

    def find(node: int) -> int:
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    for i, j in pairs:
        root_i, root_j = find(i), find(j)
        if root_i != root_j:
            parent[root_j] = root_i

    groups: dict[int, set[int]] = {}
    for node in range(count):
        groups.setdefault(find(node), set()).add(node)
    return max(groups.values(), key=len) if groups else set()


# ---------------------------------------------------------------------------
# Global alignment back onto measured gravity
# ---------------------------------------------------------------------------


def _global_alignment(refined: list[np.ndarray], seed: list[np.ndarray]) -> np.ndarray:
    """Rotation that best maps the refined solution back onto the IMU frame.

    Bundle adjustment fixes relative geometry but leaves the whole panorama free
    to tumble. OpenCV normally guesses the horizon with waveCorrect(); we do not
    have to guess, because the accelerometer measured it. Orthogonal Procrustes
    over all frames recovers the single global rotation, which levels the horizon
    and keeps the panorama's heading consistent with the capture start direction.
    """
    accumulator = np.zeros((3, 3), dtype=np.float64)
    for refined_rotation, seed_rotation in zip(refined, seed):
        accumulator += np.asarray(seed_rotation, dtype=np.float64) @ np.asarray(
            refined_rotation, dtype=np.float64
        ).T
    return _orthonormalize(accumulator)


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def refine_alignment(
    images: list[np.ndarray],
    seed_poses: list[tuple[float, float, float]],
    hfov_deg: float,
    vfov_deg: float,
) -> dict[str, Any]:
    """Refine per-frame rotations and the shared focal length from image content.

    Args:
        images: full resolution BGR frames.
        seed_poses: IMU (yaw, pitch, roll) per frame, in degrees.
        hfov_deg / vfov_deg: nominal field of view from Camera2 metadata.

    Returns a dict with ``rotations`` (camera-to-world, float32), ``focals``
    expressed in full-resolution pixels, plus diagnostics describing how much of
    the panorama was actually solved from image evidence.
    """
    count = len(images)
    seed_rotations = [rotation_from_pose(*pose) for pose in seed_poses]
    nominal_focals = [
        (image.shape[1] / 2.0) / float(np.tan(np.radians(hfov_deg) / 2.0)) for image in images
    ]

    diagnostics: dict[str, Any] = {
        "method": "IMU_ONLY",
        "refinedFrameCount": 0,
        "frameCount": count,
        "matchedPairCount": 0,
        "medianPoseCorrectionDegrees": 0.0,
        "maxPoseCorrectionDegrees": 0.0,
        "focalScaleFactor": 1.0,
        "notes": [],
    }

    if count < 3:
        diagnostics["notes"].append("too_few_frames_for_refinement")
        return {"rotations": seed_rotations, "focals": nominal_focals, "diagnostics": diagnostics}

    try:
        features, feature_scale, detector_name = _detect_features(images)
        diagnostics["detector"] = detector_name
        keypoint_counts = [len(feature.getKeypoints()) for feature in features]
        diagnostics["medianKeypointCount"] = int(np.median(keypoint_counts))
        if diagnostics["medianKeypointCount"] < 60:
            diagnostics["notes"].append("low_texture_scene")

        mask = _overlap_mask(seed_rotations, hfov_deg, vfov_deg)
        matcher = cv2.detail_BestOf2NearestMatcher.create(False, MATCH_CONFIDENCE)
        # apply2 returns a tuple; the retry pass needs to substitute entries.
        pairwise = list(matcher.apply2(features, mask))
        matcher.collectGarbage()
        _restore_pair_confidence(pairwise)

        confident_pairs = [
            match
            for match in pairwise
            if match.src_img_idx >= 0
            and match.dst_img_idx >= 0
            and match.src_img_idx < match.dst_img_idx
            and match.confidence > BA_CONFIDENCE_THRESHOLD
        ]
        diagnostics["matchedPairCount"] = len(confident_pairs)
        diagnostics["medianPairInliers"] = (
            int(np.median([match.num_inliers for match in confident_pairs]))
            if confident_pairs
            else 0
        )

        # A ring needs at least one confident link per frame to be solvable.
        if len(confident_pairs) < max(3, count // 2):
            diagnostics["notes"].append("insufficient_confident_matches")
            return {
                "rotations": seed_rotations,
                "focals": nominal_focals,
                "diagnostics": diagnostics,
            }

        def confident() -> list[tuple[int, int]]:
            return [
                (match.src_img_idx, match.dst_img_idx)
                for match in pairwise
                if match.src_img_idx >= 0
                and match.src_img_idx < match.dst_img_idx
                and match.confidence > BA_CONFIDENCE_THRESHOLD
            ]

        component = _largest_component(count, confident())
        if len(component) < count:
            recovered = _second_chance_matching(
                features, pairwise, seed_rotations, component, count
            )
            if recovered:
                diagnostics["recoveredPairCount"] = recovered
                component = _largest_component(count, confident())
        diagnostics["matchedPairCount"] = len(confident())
        diagnostics["connectedFrameCount"] = len(component)
        if len(component) < max(3, int(count * 0.6)):
            diagnostics["notes"].append("match_graph_fragmented")
            return {
                "rotations": seed_rotations,
                "focals": nominal_focals,
                "diagnostics": diagnostics,
            }
        if len(component) < count:
            diagnostics["notes"].append("some_frames_unlinked")

        # Seed the bundle adjuster with the IMU pose and the Camera2 focal,
        # both expressed in the downscaled feature coordinate system.
        cameras = []
        for index, image in enumerate(images):
            camera = cv2.detail_CameraParams()
            camera.focal = float(nominal_focals[index] * feature_scale)
            camera.aspect = 1.0
            camera.ppx = float(image.shape[1] * feature_scale / 2.0)
            camera.ppy = float(image.shape[0] * feature_scale / 2.0)
            camera.R = np.ascontiguousarray(seed_rotations[index], dtype=np.float32)
            camera.t = np.zeros((3, 1), dtype=np.float32)
            cameras.append(camera)

        adjuster = cv2.detail_BundleAdjusterRay()
        adjuster.setConfThresh(BA_CONFIDENCE_THRESHOLD)
        # Refine the focal length only. Principal point and aspect are known from
        # the sensor, and refining them with ten frames invites overfitting.
        refinement_mask = np.zeros((3, 3), np.uint8)
        refinement_mask[0, 0] = 1
        adjuster.setRefinementMask(refinement_mask)

        success, adjusted = adjuster.apply(features, pairwise, cameras)
        if not success or adjusted is None:
            diagnostics["notes"].append("bundle_adjustment_failed")
            return {
                "rotations": seed_rotations,
                "focals": nominal_focals,
                "diagnostics": diagnostics,
            }

        refined_rotations = [_orthonormalize(np.asarray(cam.R, dtype=np.float64)) for cam in adjusted]
        refined_focals_full = [float(cam.focal) / feature_scale for cam in adjusted]

        # Put the solution back on the measured horizon, using only the frames
        # that were actually constrained by matches.
        linked = sorted(component)
        alignment = _global_alignment(
            [refined_rotations[i] for i in linked], [seed_rotations[i] for i in linked]
        )
        refined_rotations = [alignment @ rotation for rotation in refined_rotations]

        # Reject per-frame solves that wandered impossibly far from the guided
        # target; those frames keep their IMU pose instead of dragging the seam.
        corrections = [
            angular_difference_degrees(seed, refined)
            for seed, refined in zip(seed_rotations, refined_rotations)
        ]
        final_rotations: list[np.ndarray] = []
        refined_count = 0
        for index, correction in enumerate(corrections):
            if index in component and correction <= MAX_POSE_CORRECTION_DEGREES:
                final_rotations.append(refined_rotations[index].astype(np.float32))
                refined_count += 1
            else:
                final_rotations.append(seed_rotations[index])
                diagnostics["notes"].append(f"frame_{index}_kept_sensor_pose")

        # One physical lens took every frame, so the focal length is shared.
        # The median is far more stable than any individual estimate.
        median_focal = float(np.median(refined_focals_full))
        nominal_focal = float(np.median(nominal_focals))
        focal_ratio = median_focal / max(nominal_focal, 1e-6)
        if not (1.0 - FOCAL_TOLERANCE <= focal_ratio <= 1.0 + FOCAL_TOLERANCE):
            diagnostics["notes"].append("focal_estimate_rejected")
            median_focal = nominal_focal
            focal_ratio = 1.0

        final_focals = [median_focal * (image.shape[1] / images[0].shape[1]) for image in images]

        diagnostics.update(
            {
                "method": "BUNDLE_ADJUSTED_RAY",
                "refinedFrameCount": refined_count,
                "medianPoseCorrectionDegrees": round(float(np.median(corrections)), 3),
                "maxPoseCorrectionDegrees": round(float(np.max(corrections)), 3),
                "focalScaleFactor": round(focal_ratio, 4),
                "solvedHorizontalFovDegrees": round(
                    float(
                        2.0
                        * np.degrees(np.arctan((images[0].shape[1] / 2.0) / max(median_focal, 1e-6)))
                    ),
                    3,
                ),
                "nominalHorizontalFovDegrees": round(float(hfov_deg), 3),
            }
        )
        if abs(focal_ratio - 1.0) > 0.06:
            diagnostics["notes"].append("camera2_fov_estimate_was_inaccurate")

        return {
            "rotations": final_rotations,
            "focals": final_focals,
            "diagnostics": diagnostics,
        }

    except cv2.error as exc:
        LOGGER.warning("Alignment refinement failed, falling back to IMU poses: %s", exc)
        diagnostics["notes"].append("opencv_error")
        return {"rotations": seed_rotations, "focals": nominal_focals, "diagnostics": diagnostics}
