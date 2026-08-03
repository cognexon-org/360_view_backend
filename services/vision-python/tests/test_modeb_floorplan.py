"""End-to-end Mode B geometry test.

Builds a synthetic Capture Package v2 (the same zip the Android app uploads),
runs it through the real pipeline, and checks the recovered room layout.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import zipfile

import numpy as np
import pytest

from app.processors import modeb_pipeline
from app.processors.floorplan import extract_floor_polygon, polygon_dimensions

cv2 = pytest.importorskip("cv2")
shapely = pytest.importorskip("shapely")
from shapely.geometry import Point, Polygon  # noqa: E402

RNG = np.random.default_rng(17)

L_SHAPED = [(0.0, 0.0), (6.0, 0.0), (6.0, 3.0), (3.5, 3.0), (3.5, 5.5), (0.0, 5.5)]
RECTANGLE = [(0.0, 0.0), (5.0, 0.0), (5.0, 4.0), (0.0, 4.0)]


def _room_cloud(outline, height=2.7, wall_points=70000, rotation_deg=0.0, outliers=400):
    """Simulate ARCore depth returns from walls, floor, ceiling, plus outliers."""
    shape = Polygon(outline)
    corners = list(shape.exterior.coords)[:-1]
    count = len(corners)
    segments = [
        (np.array(corners[i]), np.array(corners[(i + 1) % count])) for i in range(count)
    ]
    lengths = np.array([np.linalg.norm(b - a) for a, b in segments])
    weights = lengths / lengths.sum()

    picks = RNG.choice(len(segments), wall_points, p=weights)
    ts = RNG.random(wall_points)
    wall = np.empty((wall_points, 3), np.float64)
    for index, (segment_index, t) in enumerate(zip(picks, ts)):
        start, end = segments[segment_index]
        xz = start + (end - start) * t
        wall[index] = [xz[0], RNG.uniform(0.05, height), xz[1]]
    wall[:, [0, 2]] += RNG.normal(0, 0.02, (wall_points, 2))

    min_x, min_z, max_x, max_z = shape.bounds
    inside = []
    while len(inside) < 18000:
        batch = np.column_stack(
            [RNG.uniform(min_x, max_x, 8000), RNG.uniform(min_z, max_z, 8000)]
        )
        keep = np.array([shape.contains(Point(x, z)) for x, z in batch])
        inside.extend(batch[keep].tolist())
    inside = np.array(inside[:18000])
    floor = np.column_stack([inside[:, 0], RNG.normal(0, 0.01, len(inside)), inside[:, 1]])
    ceiling = np.column_stack(
        [inside[:, 0], height + RNG.normal(0, 0.01, len(inside)), inside[:, 1]]
    )

    # Mirror reflections and leakage through an open doorway.
    stray = np.column_stack(
        [
            RNG.uniform(min_x - 2.5, max_x + 2.5, outliers),
            RNG.uniform(0, height, outliers),
            RNG.uniform(min_z - 2.5, max_z + 2.5, outliers),
        ]
    )

    points = np.vstack([wall, floor, ceiling, stray])
    if rotation_deg:
        angle = math.radians(rotation_deg)
        rotation = np.array(
            [[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]]
        )
        points[:, [0, 2]] = points[:, [0, 2]] @ rotation.T
    return points.astype(np.float32)


def _rotated_outline(outline, rotation_deg):
    angle = math.radians(rotation_deg)
    rotation = np.array(
        [[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]]
    )
    return [(np.array(point) @ rotation.T).tolist() for point in outline]


def _iou(a, b):
    poly_a, poly_b = Polygon(a), Polygon(b)
    if not poly_a.is_valid:
        poly_a = poly_a.buffer(0)
    return poly_a.intersection(poly_b).area / poly_a.union(poly_b).area


# ---------------------------------------------------------------------------
# Floor plan extraction
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("outline,name", [(RECTANGLE, "rectangle"), (L_SHAPED, "l_shaped")])
def test_floor_plan_matches_ground_truth(outline, name):
    rotation = 17.0
    cloud = _room_cloud(outline, rotation_deg=rotation)
    low, high = np.quantile(cloud[:, 1], [0.02, 0.98])
    result = extract_floor_polygon(cloud, float(low), float(high))

    assert result["polygon"] is not None, f"{name}: no polygon recovered"
    assert result["method"] == "DENSITY_RASTER_MANHATTAN"
    truth = _rotated_outline(outline, rotation)
    assert _iou(result["polygon"], truth) > 0.93


def test_non_convex_room_keeps_its_concave_corner():
    """The whole point of replacing the convex hull: L-shapes must survive."""
    cloud = _room_cloud(L_SHAPED)
    low, high = np.quantile(cloud[:, 1], [0.02, 0.98])
    result = extract_floor_polygon(cloud, float(low), float(high))
    polygon = result["polygon"]

    assert result["convexityRatio"] < 0.95
    assert "non_convex_room_detected" in result["notes"]
    # A convex hull would report the full bounding area (~33 m2); the true
    # L-shaped area is 26.75 m2.
    assert 25.0 < result["areaM2"] < 29.0
    assert len(polygon) >= 6


def test_rectangular_room_is_not_flagged_non_convex():
    cloud = _room_cloud(RECTANGLE)
    low, high = np.quantile(cloud[:, 1], [0.02, 0.98])
    result = extract_floor_polygon(cloud, float(low), float(high))
    assert result["convexityRatio"] >= 0.97
    assert "non_convex_room_detected" not in result["notes"]
    assert len(result["polygon"]) == 4


def test_walls_come_out_square():
    """Manhattan snapping should leave right angles, not a wobbly trace."""
    cloud = _room_cloud(RECTANGLE, rotation_deg=31.0)
    low, high = np.quantile(cloud[:, 1], [0.02, 0.98])
    polygon = extract_floor_polygon(cloud, float(low), float(high))["polygon"]
    count = len(polygon)
    for index in range(count):
        previous = polygon[(index - 1) % count]
        current = polygon[index]
        following = polygon[(index + 1) % count]
        a = math.atan2(current[1] - previous[1], current[0] - previous[0])
        b = math.atan2(following[1] - current[1], following[0] - current[0])
        turn = abs(math.degrees(b - a)) % 360.0
        turn = min(turn, 360.0 - turn)
        assert abs(turn - 90.0) < 6.0, f"corner {index} is {turn:.1f} degrees"


def test_dimensions_are_accurate():
    cloud = _room_cloud(RECTANGLE, rotation_deg=17.0)
    low, high = np.quantile(cloud[:, 1], [0.02, 0.98])
    polygon = extract_floor_polygon(cloud, float(low), float(high))["polygon"]
    length, width = polygon_dimensions(polygon)
    assert length == pytest.approx(5.0, abs=0.25)
    assert width == pytest.approx(4.0, abs=0.25)


def test_sparse_cloud_degrades_without_crashing():
    result = extract_floor_polygon(RNG.normal(0, 1, (50, 3)).astype(np.float32), 0.0, 2.7)
    assert result["polygon"] is None
    assert "insufficient_points" in result["notes"]


# ---------------------------------------------------------------------------
# Full package -> pipeline
# ---------------------------------------------------------------------------


def _build_capture_package(outline, room_id="room-1", keyframe_count=6, height=2.7):
    """Write the same zip layout the Android recorder produces."""
    shape = Polygon(outline)
    centre = shape.centroid
    files: dict[str, bytes] = {}
    keyframes: list[dict] = []

    width, image_height = 96, 72
    focal = 72.0

    for index in range(keyframe_count):
        keyframe_id = str(index).padStart if False else str(index).zfill(4)
        angle = 2 * math.pi * index / keyframe_count
        # Camera at room centre looking outward, ARCore convention (-Z forward).
        forward = np.array([math.sin(angle), 0.0, math.cos(angle)])
        right = np.array([math.cos(angle), 0.0, -math.sin(angle)])
        up = np.array([0.0, 1.0, 0.0])
        rotation = np.column_stack([right, up, -forward])

        depth = np.zeros((image_height, width), np.uint16)
        for v in range(image_height):
            for u in range(width):
                ray_local = np.array([(u - width / 2) / focal, -(v - image_height / 2) / focal, -1.0])
                ray = rotation @ ray_local
                ray /= np.linalg.norm(ray)
                # Intersect the ray with the room walls in plan.
                origin = np.array([centre.x, height / 2.0, centre.y])
                best = None
                for step in np.arange(0.3, 9.0, 0.03):
                    point = origin + ray * step
                    if not shape.contains(Point(point[0], point[2])):
                        best = step
                        break
                    if point[1] < 0.02 or point[1] > height:
                        best = step
                        break
                if best:
                    depth[v, u] = int(best * 1000)

        directory = f"keyframes/{keyframe_id}"
        files[f"{directory}/depth_raw.depth16"] = depth.tobytes()
        rgb = (RNG.integers(60, 200, (image_height, width, 3))).astype(np.uint8)
        files[f"{directory}/rgb.jpg"] = cv2.imencode(".jpg", rgb)[1].tobytes()

        quaternion = _matrix_to_quaternion(rotation)
        meta = {
            "keyframeId": keyframe_id,
            "relativeDirectory": directory,
            "rgbFile": "rgb.jpg",
            "focalLength": [focal, focal],
            "principalPoint": [width / 2, image_height / 2],
            "intrinsicsImageDimensions": [width, image_height],
            "translationM": [centre.x, height / 2.0, centre.y],
            "quaternionXYZW": quaternion,
            "depth": {
                "rawDepth": {
                    "file": "depth_raw.depth16",
                    "width": width,
                    "height": image_height,
                    "format": "millimeters_uint16_little_endian",
                }
            },
        }
        files[f"{directory}/metadata.json"] = json.dumps(meta).encode()
        keyframes.append(meta)

    files["keyframes.jsonl"] = ("\n".join(json.dumps(k) for k in keyframes) + "\n").encode()
    files["poses.jsonl"] = b""
    files["planes.jsonl"] = b""
    files["operator-markups.jsonl"] = b""
    files["measurements.json"] = b"[]"
    files["field-plan.json"] = json.dumps(
        {
            "schemaVersion": "2.1",
            "roomId": room_id,
            "floorPolygonM": [list(p) for p in outline],
            "ceilingHeightM": height,
            "openings": [],
        }
    ).encode()
    files["manifest.json"] = json.dumps(
        {"schemaVersion": "2.1", "roomId": room_id, "checksums": "checksums.sha256"}
    ).encode()

    checksum_lines = [
        f"{hashlib.sha256(data).hexdigest()}  {name}" for name, data in sorted(files.items())
    ]
    files["checksums.sha256"] = ("\n".join(checksum_lines) + "\n").encode()

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    return buffer.getvalue()


def _matrix_to_quaternion(matrix):
    trace = matrix[0, 0] + matrix[1, 1] + matrix[2, 2]
    if trace > 0:
        s = math.sqrt(trace + 1.0) * 2
        w = 0.25 * s
        x = (matrix[2, 1] - matrix[1, 2]) / s
        y = (matrix[0, 2] - matrix[2, 0]) / s
        z = (matrix[1, 0] - matrix[0, 1]) / s
    else:
        s = 2.0
        w, x, y, z = 1.0, 0.0, 0.0, 0.0
    return [float(x), float(y), float(z), float(w)]


def test_pipeline_builds_a_room_from_a_capture_package(monkeypatch):
    archive = _build_capture_package(RECTANGLE)
    monkeypatch.setattr(modeb_pipeline, "get_bytes", lambda bucket, key: archive)

    packages = modeb_pipeline.load_capture_packages(
        [
            {
                "id": "asset-1",
                "roomId": "room-1",
                "bucket": "b",
                "objectKey": "room-1_capture_package_v2.zip",
                "mimeType": "application/zip",
                "kind": "MODEL_EVIDENCE",
            }
        ]
    )
    assert len(packages) == 1
    proposal = modeb_pipeline._room_sensor_proposal(packages[0])

    assert proposal["pointCount"] > 1000
    assert proposal["polygon"] is not None
    assert proposal["heightM"] == pytest.approx(2.7, abs=0.5)
    assert proposal["floorPlan"]["method"] in {
        "DENSITY_RASTER_MANHATTAN",
        "ORIENTED_BOUNDING_BOX_FALLBACK",
    }
