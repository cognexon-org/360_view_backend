from collections import deque
from typing import Any


def _connected_room_ids(room_ids: set[str], connections: list[dict[str, Any]]) -> set[str]:
    if not room_ids:
        return set()
    graph: dict[str, set[str]] = {room_id: set() for room_id in room_ids}
    for edge in connections:
        source = str(edge.get("fromRoomId", ""))
        target = str(edge.get("toRoomId", ""))
        if source in graph and target in graph:
            graph[source].add(target)
            graph[target].add(source)
    start = next(iter(room_ids))
    visited = {start}
    queue = deque([start])
    while queue:
        current = queue.popleft()
        for neighbor in graph[current]:
            if neighbor not in visited:
                visited.add(neighbor)
                queue.append(neighbor)
    return visited


def validate_capture(payload: dict[str, Any]) -> dict[str, Any]:
    mode = str(payload.get("mode", "PROPERTY_TOUR"))
    rooms = list(payload.get("rooms", []))
    connections = list(payload.get("connections", []))
    asset_kinds = set(payload.get("assetKinds", []))

    issues: list[dict[str, Any]] = []
    if not rooms:
        issues.append({"code": "no_rooms", "message": "Add at least one room."})

    room_ids = {str(room.get("id")) for room in rooms}
    connected = _connected_room_ids(room_ids, connections)
    if len(rooms) > 1 and len(connected) != len(room_ids):
        missing = sorted(room_ids - connected)
        issues.append({"code": "room_graph_disconnected", "roomIds": missing, "message": "Connect every room through a doorway."})

    for room in rooms:
        if mode == "PROPERTY_TOUR" and room.get("panoramaStatus") != "APPROVED":
            issues.append({
                "code": "approved_panorama_missing",
                "roomId": room.get("id"),
                "roomName": room.get("name"),
                "message": "Capture or replace the room panorama.",
            })
        if mode == "DESIGN_SCAN":
            if not room.get("ceilingHeightM"):
                issues.append({"code": "ceiling_height_missing", "roomId": room.get("id")})
            if not room.get("floorPolygon") and not room.get("measurements"):
                issues.append({"code": "room_measurements_missing", "roomId": room.get("id")})

    if mode == "DESIGN_SCAN" and not ({"AR_POSES", "ROOMPLAN_USDZ"} & asset_kinds):
        issues.append({
            "code": "manual_scale_confirmation_required",
            "severity": "warning",
            "message": "No AR pose or RoomPlan asset found. Confirm at least one real-world measurement before modelling.",
        })

    blocking = [issue for issue in issues if issue.get("severity") != "warning"]
    score = max(0, 100 - 18 * len(blocking) - 5 * (len(issues) - len(blocking)))
    return {
        "ready": len(blocking) == 0,
        "qualityScore": score,
        "issues": issues,
        "roomCount": len(rooms),
        "connectedRoomCount": len(connected),
        "mode": mode,
    }
