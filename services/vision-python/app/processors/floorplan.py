"""Floor-plan extraction from a Mode B room point cloud.

Why this replaces the convex hull
---------------------------------
The previous room proposal took the convex hull of the point cloud's XZ
projection, simplified it, and fell back to ``minimum_rotated_rectangle`` when
the hull had more than ten vertices. That has three failure modes that matter
for real property scans:

1. **A convex hull cannot represent a non-convex room.** L-shaped living rooms,
   alcoves, bay windows, chimney breasts and closet recesses are exactly the
   features a designer needs, and the hull erases every one of them by spanning
   across the opening.
2. **A hull is defined by its outliers.** One stray depth point behind a doorway
   or reflected off a mirror drags a whole edge outward by half a metre. There
   is no averaging: the single worst point wins.
3. **The fallback made every room a rectangle.** Because a noisy hull almost
   always exceeds ten vertices, the common path produced an oriented bounding
   box, discarding the room's actual shape.

The approach here instead treats the floor plan as an occupancy problem:

* project points to the XZ plane and rasterise **density**, so a wall is a ridge
  of thousands of returns and an outlier is one cell that thresholds away;
* recover the room's dominant axis, since almost all built interiors are locally
  Manhattan, and rotate the raster onto it;
* close the raster morphologically so doorways and scan gaps do not leak the
  interior into the exterior, then take the largest filled region;
* trace its outline and simplify it, then snap near-axis edges to exact axes so
  walls come out straight and corners square, which is what makes the result
  look like a floor plan rather than a scan blob.

Non-convex shapes survive this whole path.
"""

from __future__ import annotations

import logging
import math
from typing import Any

import cv2
import numpy as np
from shapely.geometry import MultiPoint, Polygon

LOGGER = logging.getLogger("propertytour360-vision.floorplan")

# Raster cell size. 4 cm resolves a doorway reveal without making the grid huge.
CELL_SIZE_M = 0.04

# Cells with fewer returns than this are treated as noise rather than structure.
MIN_CELL_HITS = 3

# Wall openings and scan shadows are bridged by a morphological close of about
# this width, so the interior stays one connected region.
CLOSE_RADIUS_M = 0.30

# Douglas-Peucker tolerance for the traced outline.
SIMPLIFY_TOLERANCE_M = 0.09

# An edge within this angle of the dominant axis is snapped square to it.
SNAP_ANGLE_DEGREES = 22.0

# Collinear vertices closer than this are merged after snapping.
MERGE_DISTANCE_M = 0.14

# Rooms smaller than this are rejected as a failed reconstruction.
MIN_ROOM_AREA_M2 = 1.2


def _dominant_axis_degrees(xz: np.ndarray) -> float:
    """Rotation of the room's dominant wall direction, in degrees.

    Wall points dominate the horizontal band of an interior scan, so the
    directions between nearby points cluster hard around the two Manhattan axes.
    Because those axes are 90 degrees apart, angles are doubled before averaging
    (a circular-mean trick) so that 0 and 90 degrees reinforce instead of
    cancelling, then halved to recover the axis.
    """
    if len(xz) < 50:
        return 0.0

    sample = xz
    if len(sample) > 20000:
        sample = sample[np.linspace(0, len(sample) - 1, 20000, dtype=int)]

    # Edge directions from a coarse PCA of local neighbourhoods is overkill here;
    # the gradient of the density raster gives the same information more cheaply.
    centred = sample - sample.mean(axis=0)
    span = float(np.abs(centred).max()) or 1.0
    grid_size = 256
    grid = np.zeros((grid_size, grid_size), np.float32)
    indices = np.clip(
        ((centred / (2.0 * span) + 0.5) * (grid_size - 1)).astype(int), 0, grid_size - 1
    )
    np.add.at(grid, (indices[:, 1], indices[:, 0]), 1.0)
    grid = cv2.GaussianBlur(grid, (5, 5), 0)

    gx = cv2.Sobel(grid, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(grid, cv2.CV_32F, 0, 1, ksize=3)
    magnitude = np.sqrt(gx**2 + gy**2)
    strong = magnitude > np.percentile(magnitude, 92)
    if strong.sum() < 20:
        return 0.0

    angles = np.arctan2(gy[strong], gx[strong])
    doubled = 4.0 * angles  # 90-degree symmetry -> multiply by 4, not 2
    weights = magnitude[strong]
    mean_angle = np.arctan2(
        float(np.sum(weights * np.sin(doubled))), float(np.sum(weights * np.cos(doubled)))
    )
    axis = math.degrees(mean_angle) / 4.0
    return float(axis % 90.0)


def _rotate(points: np.ndarray, degrees: float) -> np.ndarray:
    angle = math.radians(degrees)
    cos_a, sin_a = math.cos(angle), math.sin(angle)
    matrix = np.array([[cos_a, -sin_a], [sin_a, cos_a]], dtype=np.float64)
    return points @ matrix.T


def _snap_axis_aligned(polygon: list[list[float]]) -> list[list[float]]:
    """Square up edges that are already nearly axis-aligned.

    Traced contours wobble by a cell or two, so a straight wall arrives as a
    staircase of slightly different angles. Snapping each near-axis edge to the
    exact axis, then reconciling shared vertices, turns that back into the
    straight lines and right angles a designer expects.
    """
    count = len(polygon)
    if count < 4:
        return polygon

    points = [list(map(float, point)) for point in polygon]
    orientations: list[str | None] = []
    for index in range(count):
        x0, z0 = points[index]
        x1, z1 = points[(index + 1) % count]
        angle = math.degrees(math.atan2(z1 - z0, x1 - x0)) % 180.0
        if angle < SNAP_ANGLE_DEGREES or angle > 180.0 - SNAP_ANGLE_DEGREES:
            orientations.append("H")
        elif abs(angle - 90.0) < SNAP_ANGLE_DEGREES:
            orientations.append("V")
        else:
            orientations.append(None)

    # Horizontal edges share one z; vertical edges share one x. Averaging the two
    # endpoints keeps the wall where the evidence put it.
    for index in range(count):
        orientation = orientations[index]
        if orientation is None:
            continue
        start, end = index, (index + 1) % count
        if orientation == "H":
            mid = (points[start][1] + points[end][1]) / 2.0
            points[start][1] = points[end][1] = mid
        else:
            mid = (points[start][0] + points[end][0]) / 2.0
            points[start][0] = points[end][0] = mid

    # Drop vertices that snapping collapsed onto their neighbour.
    cleaned: list[list[float]] = []
    for index, point in enumerate(points):
        previous = cleaned[-1] if cleaned else points[-1]
        if math.dist(point, previous) >= MERGE_DISTANCE_M:
            cleaned.append(point)
    if len(cleaned) >= 3 and math.dist(cleaned[0], cleaned[-1]) < MERGE_DISTANCE_M:
        cleaned.pop()
    return cleaned if len(cleaned) >= 4 else points


def _drop_collinear(polygon: list[list[float]], tolerance_deg: float = 8.0) -> list[list[float]]:
    count = len(polygon)
    if count < 4:
        return polygon
    kept: list[list[float]] = []
    for index in range(count):
        previous = polygon[(index - 1) % count]
        current = polygon[index]
        following = polygon[(index + 1) % count]
        a = math.atan2(current[1] - previous[1], current[0] - previous[0])
        b = math.atan2(following[1] - current[1], following[0] - current[0])
        turn = abs(math.degrees(b - a)) % 360.0
        turn = min(turn, 360.0 - turn)
        if turn > tolerance_deg:
            kept.append(current)
    return kept if len(kept) >= 4 else polygon


def extract_floor_polygon(
    points: np.ndarray,
    floor_y: float,
    ceiling_y: float,
) -> dict[str, Any]:
    """Recover a floor-plan polygon from a room point cloud.

    Args:
        points: (N, 3) cloud in world metres, y up.
        floor_y / ceiling_y: robust floor and ceiling heights.

    Returns a dict with ``polygon`` (list of [x, z] or None), ``method`` and
    diagnostics. ``polygon`` may be non-convex, which is the point.
    """
    diagnostics: dict[str, Any] = {"method": "NONE", "notes": []}
    if points is None or len(points) < 200:
        diagnostics["notes"].append("insufficient_points")
        return {"polygon": None, **diagnostics}

    # Use the wall band only. Floor and ceiling returns are horizontal surfaces
    # that spread past the walls through doorways and add nothing to the outline.
    height = ceiling_y - floor_y
    low = floor_y + max(0.25, height * 0.12)
    high = ceiling_y - max(0.25, height * 0.12)
    band = points[(points[:, 1] > low) & (points[:, 1] < high)]
    if len(band) < 150:
        band = points
        diagnostics["notes"].append("wall_band_empty_using_all_points")

    xz = band[:, [0, 2]].astype(np.float64)
    diagnostics["wallBandPointCount"] = int(len(xz))

    axis_degrees = _dominant_axis_degrees(xz)
    diagnostics["dominantAxisDegrees"] = round(axis_degrees, 2)
    rotated = _rotate(xz, -axis_degrees)

    min_xz = rotated.min(axis=0) - 0.5
    max_xz = rotated.max(axis=0) + 0.5
    extent = max_xz - min_xz
    if float(np.max(extent)) > 60.0:
        diagnostics["notes"].append("implausible_room_extent")
        return {"polygon": None, **diagnostics}

    width = max(8, int(math.ceil(extent[0] / CELL_SIZE_M)))
    depth = max(8, int(math.ceil(extent[1] / CELL_SIZE_M)))
    if width * depth > 8_000_000:
        diagnostics["notes"].append("raster_too_large")
        return {"polygon": None, **diagnostics}

    density = np.zeros((depth, width), np.int32)
    columns = np.clip(((rotated[:, 0] - min_xz[0]) / CELL_SIZE_M).astype(int), 0, width - 1)
    rows = np.clip(((rotated[:, 1] - min_xz[1]) / CELL_SIZE_M).astype(int), 0, depth - 1)
    np.add.at(density, (rows, columns), 1)

    occupied = (density >= MIN_CELL_HITS).astype(np.uint8) * 255
    if occupied.sum() == 0:
        diagnostics["notes"].append("no_occupied_cells")
        return {"polygon": None, **diagnostics}

    # Close doorways and scan shadows so the room interior is one blob, then fill
    # it: the interior of a room is the hole enclosed by its walls.
    radius = max(1, int(round(CLOSE_RADIUS_M / CELL_SIZE_M)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))
    closed = cv2.morphologyEx(occupied, cv2.MORPH_CLOSE, kernel)

    filled = closed.copy()
    flood_mask = np.zeros((depth + 2, width + 2), np.uint8)
    cv2.floodFill(filled, flood_mask, (0, 0), 255)
    interior = cv2.bitwise_or(closed, cv2.bitwise_not(filled))
    interior = cv2.morphologyEx(
        interior, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    )

    contours, _ = cv2.findContours(interior, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        diagnostics["notes"].append("no_contour_found")
        return {"polygon": None, **diagnostics}

    contour = max(contours, key=cv2.contourArea)
    area_m2 = float(cv2.contourArea(contour)) * CELL_SIZE_M**2
    if area_m2 < MIN_ROOM_AREA_M2:
        diagnostics["notes"].append("region_too_small")
        return {"polygon": None, **diagnostics}

    approx = cv2.approxPolyDP(contour, SIMPLIFY_TOLERANCE_M / CELL_SIZE_M, True)
    if len(approx) < 4:
        approx = cv2.approxPolyDP(contour, (SIMPLIFY_TOLERANCE_M / 2.0) / CELL_SIZE_M, True)
    if len(approx) < 3:
        diagnostics["notes"].append("degenerate_contour")
        return {"polygon": None, **diagnostics}

    local = [
        [float(point[0][0]) * CELL_SIZE_M + min_xz[0], float(point[0][1]) * CELL_SIZE_M + min_xz[1]]
        for point in approx
    ]
    local = _snap_axis_aligned(local)
    local = _drop_collinear(local)

    world = _rotate(np.asarray(local, dtype=np.float64), axis_degrees)
    polygon = [[round(float(x), 4), round(float(z), 4)] for x, z in world]

    shape = Polygon(polygon)
    if not shape.is_valid:
        shape = shape.buffer(0)
        if isinstance(shape, Polygon) and shape.is_valid and shape.area >= MIN_ROOM_AREA_M2:
            polygon = [[round(float(x), 4), round(float(z), 4)] for x, z in shape.exterior.coords[:-1]]
            diagnostics["notes"].append("polygon_repaired")
        else:
            diagnostics["notes"].append("invalid_polygon")
            return {"polygon": None, **diagnostics}

    final_shape = Polygon(polygon)
    final_area = float(final_shape.area)
    # Compare the polygon against its OWN convex hull. Comparing against the hull
    # of the raw points instead would be meaningless, because that hull is
    # inflated by the very outliers this extractor exists to reject, and would
    # flag every room as non-convex.
    hull_area = float(final_shape.convex_hull.area) or 1.0

    diagnostics.update(
        {
            "method": "DENSITY_RASTER_MANHATTAN",
            "areaM2": round(final_area, 3),
            "vertexCount": len(polygon),
            # Below 1.0 means the room is genuinely non-convex, i.e. the shape a
            # convex hull would have thrown away.
            "convexityRatio": round(final_area / hull_area, 3),
            "rasterCells": int(width * depth),
        }
    )
    if diagnostics["convexityRatio"] < 0.97:
        diagnostics["notes"].append("non_convex_room_detected")
    return {"polygon": polygon, **diagnostics}


def polygon_dimensions(polygon: list[list[float]]) -> tuple[float, float]:
    """Length and width of the polygon's minimum-area oriented bounding box."""
    shape = Polygon(polygon).minimum_rotated_rectangle
    coords = list(shape.exterior.coords)[:-1]
    if len(coords) < 4:
        return 0.0, 0.0
    edges = sorted(
        math.dist(coords[index], coords[(index + 1) % len(coords)]) for index in range(len(coords))
    )
    return round(edges[-1], 3), round(edges[1], 3)
