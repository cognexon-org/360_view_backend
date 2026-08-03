from __future__ import annotations

from io import BytesIO
from math import atan2, hypot
from typing import Any

import numpy as np
import trimesh
from shapely.geometry import Polygon

from ..storage import put_bytes


def _box_between(start: tuple[float, float], end: tuple[float, float], z_center: float, height: float, thickness: float) -> trimesh.Trimesh:
    sx, sy = start
    ex, ey = end
    length = hypot(ex - sx, ey - sy)
    if length <= 1e-6 or height <= 1e-6:
        raise ValueError("Wall segment has zero size")
    box = trimesh.creation.box(extents=(length, thickness, height))
    angle = atan2(ey - sy, ex - sx)
    transform = trimesh.transformations.euler_matrix(0.0, 0.0, angle)
    transform[:3, 3] = [(sx + ex) / 2.0, (sy + ey) / 2.0, z_center]
    box.apply_transform(transform)
    return box


def _point_on_wall(start: tuple[float, float], end: tuple[float, float], distance: float) -> tuple[float, float]:
    sx, sy = start
    ex, ey = end
    length = hypot(ex - sx, ey - sy)
    ratio = distance / length
    return sx + (ex - sx) * ratio, sy + (ey - sy) * ratio


def _wall_meshes(wall: dict[str, Any], room_height: float) -> list[trimesh.Trimesh]:
    start = tuple(float(value) for value in wall["start"])
    end = tuple(float(value) for value in wall["end"])
    thickness = float(wall.get("thicknessM", 0.12))
    length = hypot(end[0] - start[0], end[1] - start[1])
    openings = sorted(wall.get("openings", []), key=lambda item: float(item["offsetM"]))

    last = 0.0
    meshes: list[trimesh.Trimesh] = []
    for opening in openings:
        offset = float(opening["offsetM"])
        width = float(opening["widthM"])
        height = float(opening["heightM"])
        bottom = float(opening.get("bottomM", opening.get("sillM", 0.0)))
        if offset < last - 1e-6 or offset + width > length + 1e-6:
            raise ValueError(f"Opening {opening.get('id')} is outside or overlaps another opening")

        if offset > last:
            a = _point_on_wall(start, end, last)
            b = _point_on_wall(start, end, offset)
            meshes.append(_box_between(a, b, room_height / 2.0, room_height, thickness))

        opening_start = _point_on_wall(start, end, offset)
        opening_end = _point_on_wall(start, end, offset + width)
        if bottom > 0:
            meshes.append(_box_between(opening_start, opening_end, bottom / 2.0, bottom, thickness))
        top_height = room_height - (bottom + height)
        if top_height > 1e-6:
            meshes.append(_box_between(opening_start, opening_end, bottom + height + top_height / 2.0, top_height, thickness))
        last = offset + width

    if last < length:
        a = _point_on_wall(start, end, last)
        meshes.append(_box_between(a, end, room_height / 2.0, room_height, thickness))
    return meshes


def generate_room_shell(payload: dict[str, Any]) -> dict[str, Any]:
    model = payload["model"]
    rooms = model.get("rooms", [])
    if not rooms:
        raise ValueError("Model must contain at least one room")

    scene = trimesh.Scene()
    room_summaries: list[dict[str, Any]] = []
    for room_index, room in enumerate(rooms):
        room_id = str(room["id"])
        room_height = float(room["heightM"])
        polygon_points = [(float(x), float(y)) for x, y in room["floorPolygon"]]
        polygon = Polygon(polygon_points)
        if not polygon.is_valid or polygon.area <= 0.01:
            raise ValueError(f"Room {room_id} has an invalid floor polygon")

        floor = trimesh.creation.extrude_polygon(polygon, height=0.03)
        floor.apply_translation((0.0, 0.0, -0.03))
        scene.add_geometry(floor, node_name=f"{room_id}-floor")

        ceiling = trimesh.creation.extrude_polygon(polygon, height=0.02)
        ceiling.apply_translation((0.0, 0.0, room_height))
        scene.add_geometry(ceiling, node_name=f"{room_id}-ceiling")

        wall_count = 0
        for wall in room.get("walls", []):
            for segment_index, mesh in enumerate(_wall_meshes(wall, room_height)):
                scene.add_geometry(mesh, node_name=f"{room_id}-{wall['id']}-{segment_index}")
                wall_count += 1

        object_count = 0
        for obj in room.get("objects", []):
            size = obj.get("size") or obj.get("dimensionsM") or [0.8, 0.8, 0.8]
            position = obj.get("position") or [0.0, 0.0, float(size[2] if len(size) > 2 else 0.8) / 2.0]
            try:
                width, depth, object_height = [max(0.02, float(value)) for value in list(size)[:3]]
                if len(position) >= 3:
                    px, py, pz = float(position[0]), float(position[1]), float(position[2])
                else:
                    px, py, pz = float(position[0]), float(position[1]), object_height / 2.0
                mesh = trimesh.creation.box(extents=(width, depth, object_height))
                mesh.apply_translation((px, py, pz if pz > 0 else object_height / 2.0))
                scene.add_geometry(mesh, node_name=f"{room_id}-object-{obj.get('id', object_count + 1)}")
                object_count += 1
            except Exception:
                continue

        room_summaries.append({
            "id": room_id,
            "name": room.get("name", room_id),
            "areaM2": round(float(polygon.area), 3),
            "heightM": room_height,
            "wallSegments": wall_count,
            "objects": object_count,
        })

    glb = scene.export(file_type="glb")
    if not isinstance(glb, (bytes, bytearray)):
        buffer = BytesIO()
        glb.write(buffer)
        glb = buffer.getvalue()

    output_bucket = str(payload["outputBucket"])
    output_key = str(payload["outputKey"])
    put_bytes(output_bucket, output_key, bytes(glb), "model/gltf-binary")
    return {
        "outputBucket": output_bucket,
        "outputKey": output_key,
        "rooms": room_summaries,
        "geometryCount": len(scene.geometry),
        "sizeBytes": len(glb),
        "quality": str(payload.get("quality", "GLB")),
        "warning": "Generated geometry is a design draft. Verify dimensions and structural changes before construction.",
    }
