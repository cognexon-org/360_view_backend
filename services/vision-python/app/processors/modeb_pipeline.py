from __future__ import annotations

import hashlib
import io
import json
import math
import zipfile
from collections import Counter, defaultdict
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Iterable

import numpy as np
import cv2
import trimesh
from shapely.geometry import MultiPoint, Polygon
from shapely.validation import explain_validity

from .floorplan import extract_floor_polygon
from ..storage import get_bytes, put_bytes

PROCESSOR_VERSION = "modeb-rgbd-3.1.0"


@dataclass
class CapturePackage:
    asset_id: str
    room_id: str
    manifest: dict[str, Any]
    summary: dict[str, Any]
    files: dict[str, bytes]
    checksum_ok: bool
    checksum_errors: list[str]


def _json(data: bytes | None, default: Any) -> Any:
    if not data:
        return default
    try:
        return json.loads(data.decode("utf-8"))
    except Exception:
        return default


def _jsonl(data: bytes | None) -> list[dict[str, Any]]:
    if not data:
        return []
    rows: list[dict[str, Any]] = []
    for line in data.decode("utf-8", errors="ignore").splitlines():
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                rows.append(value)
        except Exception:
            continue
    return rows


def _find(files: dict[str, bytes], suffix: str) -> bytes | None:
    suffix = suffix.replace("\\", "/")
    exact = files.get(suffix)
    if exact is not None:
        return exact
    candidates = [value for name, value in files.items() if name.endswith("/" + suffix) or name == suffix]
    return candidates[0] if candidates else None


def _verify_checksums(files: dict[str, bytes]) -> tuple[bool, list[str]]:
    raw = _find(files, "checksums.sha256")
    if not raw:
        return False, ["checksums.sha256 is missing"]
    errors: list[str] = []
    for line in raw.decode("utf-8", errors="ignore").splitlines():
        if not line.strip():
            continue
        try:
            expected, name = line.split(None, 1)
            name = name.strip().lstrip("*").replace("\\", "/")
            payload = _find(files, name)
            if payload is None:
                errors.append(f"missing:{name}")
            elif hashlib.sha256(payload).hexdigest().lower() != expected.lower():
                errors.append(f"checksum:{name}")
        except ValueError:
            errors.append(f"invalid-line:{line[:80]}")
    return not errors, errors


def load_capture_packages(assets: list[dict[str, Any]]) -> list[CapturePackage]:
    packages: list[CapturePackage] = []
    for asset in assets:
        if str(asset.get("kind")) != "MODEL_EVIDENCE" or not asset.get("roomId"):
            continue
        metadata = asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}
        filename = str(metadata.get("originalFilename") or asset.get("objectKey") or "").lower()
        mime_type = str(asset.get("mimeType") or "").lower()
        if mime_type not in {"application/zip", "application/x-zip-compressed"} and not filename.endswith(".zip"):
            continue
        try:
            blob = get_bytes(str(asset.get("bucket")), str(asset.get("objectKey")))
            with zipfile.ZipFile(io.BytesIO(blob)) as archive:
                files = {
                    info.filename.replace("\\", "/").lstrip("./"): archive.read(info)
                    for info in archive.infolist()
                    if not info.is_dir() and info.file_size <= 256 * 1024 * 1024
                }
            manifest = _json(_find(files, "manifest.json"), {})
            summary = _json(_find(files, "capture_summary.json"), {})
            checksum_ok, errors = _verify_checksums(files)
            packages.append(CapturePackage(
                asset_id=str(asset.get("id")), room_id=str(asset.get("roomId")),
                manifest=manifest if isinstance(manifest, dict) else {},
                summary=summary if isinstance(summary, dict) else {}, files=files,
                checksum_ok=checksum_ok, checksum_errors=errors,
            ))
        except Exception as exc:
            packages.append(CapturePackage(
                asset_id=str(asset.get("id")), room_id=str(asset.get("roomId")),
                manifest={}, summary={}, files={}, checksum_ok=False,
                checksum_errors=[f"archive:{exc}"],
            ))
    return packages


def validate_capture_packages(payload: dict[str, Any]) -> dict[str, Any]:
    packages = load_capture_packages(payload.get("assets") or [])
    room_ids = {str(room.get("id")) for room in payload.get("rooms") or []}
    reports = []
    for package in packages:
        keyframes = _jsonl(_find(package.files, "keyframes.jsonl"))
        manifest_count = int(package.manifest.get("keyframeCount") or 0)
        summary_count = int(package.summary.get("keyframeCount") or 0)
        issues: list[dict[str, Any]] = []
        if package.room_id not in room_ids:
            issues.append({"code": "ROOM_NOT_IN_CAPTURE", "severity": "ERROR"})
        schema_version = str(package.manifest.get("schemaVersion") or "")
        if schema_version not in {"2.0", "2.1"}:
            issues.append({"code": "UNSUPPORTED_CAPTURE_PACKAGE_SCHEMA", "severity": "ERROR", "actual": schema_version, "supported": ["2.0", "2.1"]})
        if not package.checksum_ok:
            issues.append({"code": "CHECKSUM_VALIDATION_FAILED", "severity": "ERROR", "details": package.checksum_errors})
        if manifest_count != len(keyframes) or (summary_count and summary_count != len(keyframes)):
            issues.append({"code": "KEYFRAME_COUNT_MISMATCH", "severity": "ERROR", "manifest": manifest_count, "summary": summary_count, "actual": len(keyframes)})
        tracking = Counter(str(item.get("trackingState")) for item in keyframes)
        depth_frames = sum(1 for item in keyframes if item.get("newDenseDepth") or item.get("newRawDepth"))
        if len(keyframes) < 6:
            issues.append({"code": "TOO_FEW_KEYFRAMES", "severity": "WARNING", "actual": len(keyframes), "recommended": 12})
        if depth_frames == 0:
            issues.append({"code": "NO_DEPTH_FRAMES", "severity": "WARNING"})
        reports.append({
            "assetId": package.asset_id, "roomId": package.room_id,
            "captureType": package.manifest.get("captureType"),
            "schemaVersion": package.manifest.get("schemaVersion"),
            "checksumVerified": package.checksum_ok,
            "keyframeCount": len(keyframes), "depthKeyframeCount": depth_frames,
            "trackingStates": dict(tracking), "issues": issues,
            "valid": not any(item["severity"] == "ERROR" for item in issues),
        })
    covered = {report["roomId"] for report in reports if report["valid"]}
    return {
        "processorVersion": PROCESSOR_VERSION,
        "valid": bool(reports) and all(report["valid"] for report in reports),
        "packages": reports,
        "roomsWithoutValidPackage": sorted(room_ids - covered),
    }


def _decode_depth(blob: bytes, desc: dict[str, Any]) -> np.ndarray:
    width = int(desc.get("width") or 0); height = int(desc.get("height") or 0)
    row_stride = int(desc.get("rowStride") or width * 2); pixel_stride = int(desc.get("pixelStride") or 2)
    if width <= 0 or height <= 0 or row_stride <= 0:
        raise ValueError("Invalid depth descriptor")
    raw = np.frombuffer(blob, dtype=np.uint8)
    required = row_stride * height
    if raw.size < required:
        raise ValueError("Depth payload is shorter than rowStride*height")
    rows = raw[:required].reshape(height, row_stride)
    if pixel_stride == 2:
        values = rows[:, :width * 2].copy().view("<u2").reshape(height, width)
    else:
        values = np.empty((height, width), dtype=np.uint16)
        for y in range(height):
            for x in range(width):
                offset = x * pixel_stride
                values[y, x] = int(rows[y, offset]) | (int(rows[y, offset + 1]) << 8)
    return values


def _decode_confidence(blob: bytes, desc: dict[str, Any]) -> np.ndarray:
    width = int(desc.get("width") or 0); height = int(desc.get("height") or 0)
    row_stride = int(desc.get("rowStride") or width); pixel_stride = int(desc.get("pixelStride") or 1)
    raw = np.frombuffer(blob, dtype=np.uint8)
    required = row_stride * height
    if raw.size < required:
        raise ValueError("Confidence payload is shorter than rowStride*height")
    rows = raw[:required].reshape(height, row_stride)
    return rows[:, :width * pixel_stride:pixel_stride].copy()


def _quat_matrix(q: Iterable[float]) -> np.ndarray:
    x, y, z, w = [float(v) for v in list(q)[:4]]
    norm = math.sqrt(x*x+y*y+z*z+w*w) or 1.0
    x, y, z, w = x/norm, y/norm, z/norm, w/norm
    return np.array([
        [1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
        [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
        [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)],
    ], dtype=np.float64)


def _unproject_keyframe(package: CapturePackage, meta: dict[str, Any], max_points: int = 18000) -> np.ndarray:
    rel = str(meta.get("relativeDirectory") or f"keyframes/{meta.get('keyframeId')}").strip("/")
    depth_block = meta.get("depth") if isinstance(meta.get("depth"), dict) else {}
    depth_desc = depth_block.get("rawDepth") or depth_block.get("denseDepth")
    if not isinstance(depth_desc, dict):
        return np.empty((0, 3), dtype=np.float32)
    depth_blob = _find(package.files, f"{rel}/{depth_desc.get('file')}")
    if depth_blob is None:
        return np.empty((0, 3), dtype=np.float32)
    depth = _decode_depth(depth_blob, depth_desc).astype(np.float32) / 1000.0
    confidence_desc = depth_block.get("confidence") if isinstance(depth_block.get("confidence"), dict) else None
    confidence = None
    if confidence_desc:
        confidence_blob = _find(package.files, f"{rel}/{confidence_desc.get('file')}")
        if confidence_blob is not None:
            confidence = _decode_confidence(confidence_blob, confidence_desc)
    h, w = depth.shape
    fx, fy = [float(v) for v in (meta.get("focalLength") or [w, w])[:2]]
    cx, cy = [float(v) for v in (meta.get("principalPoint") or [w/2, h/2])[:2]]
    iw, ih = [float(v) for v in (meta.get("intrinsicsImageDimensions") or [w, h])[:2]]
    fx *= w / max(iw, 1.0); fy *= h / max(ih, 1.0); cx *= w / max(iw, 1.0); cy *= h / max(ih, 1.0)
    step = max(1, int(math.sqrt((w*h)/max_points)))
    vv, uu = np.mgrid[0:h:step, 0:w:step]
    dd = depth[0:h:step, 0:w:step]
    valid = np.isfinite(dd) & (dd >= 0.2) & (dd <= 8.0)
    if confidence is not None:
        cc = confidence[0:h:step, 0:w:step]
        valid &= cc >= 96
    if not valid.any():
        return np.empty((0, 3), dtype=np.float32)
    d = dd[valid]; u = uu[valid].astype(np.float32); v = vv[valid].astype(np.float32)
    local = np.column_stack(((u-cx)*d/fx, -(v-cy)*d/fy, -d))
    rotation = _quat_matrix(meta.get("quaternionXYZW") or [0,0,0,1])
    translation = np.asarray((meta.get("translationM") or [0,0,0])[:3], dtype=np.float64)
    return (local @ rotation.T + translation).astype(np.float32)


def _polygon_points(value: Any) -> list[list[float]] | None:
    if not isinstance(value, list) or len(value) < 3:
        return None
    try:
        points = [[float(p[0]), float(p[1])] for p in value]
        poly = Polygon(points)
        if not poly.is_valid or poly.area < 0.25:
            return None
        return points
    except Exception:
        return None


def _walls(room_id: str, polygon: list[list[float]], height: float, evidence_refs: list[str], confidence: float) -> list[dict[str, Any]]:
    return [{
        "id": f"{room_id}-wall-{idx+1}", "start": polygon[idx], "end": polygon[(idx+1)%len(polygon)],
        "heightM": height, "thicknessM": 0.12, "material": "Warm White", "structuralStatus": "UNKNOWN",
        "confidence": confidence, "uncertaintyM": round(max(0.02, 0.18*(1-confidence)), 3),
        "source": "DEPTH_INFERENCE", "evidenceRefs": evidence_refs, "verificationStatus": "DESIGNER_REVIEW_REQUIRED", "openings": []
    } for idx in range(len(polygon))]


def _room_sensor_proposal(package: CapturePackage) -> dict[str, Any]:
    keyframes = _jsonl(_find(package.files, "keyframes.jsonl"))
    chunks: list[np.ndarray] = []
    keyframe_errors: list[str] = []
    for meta in keyframes:
        try:
            points = _unproject_keyframe(package, meta)
            if len(points):
                chunks.append(points)
        except Exception as exc:
            keyframe_errors.append(f"{meta.get('keyframeId')}:{exc}")
    if not chunks:
        return {"pointCount": 0, "polygon": None, "heightM": None, "confidence": 0.0, "keyframeErrors": keyframe_errors}
    points = np.concatenate(chunks, axis=0)
    finite = np.isfinite(points).all(axis=1)
    points = points[finite]
    if len(points) > 240000:
        indices = np.linspace(0, len(points)-1, 240000, dtype=int)
        points = points[indices]
    y_low, y_high = np.quantile(points[:,1], [0.02, 0.98])
    height = float(np.clip(y_high-y_low, 1.8, 5.5))

    # Floor plan from a density raster with Manhattan regularisation. This
    # replaces a convex hull, which could not represent L-shaped rooms, alcoves
    # or any other non-convex plan, and which was defined by its worst outlier.
    plan = extract_floor_polygon(points, float(y_low), float(y_high))
    polygon = plan.get("polygon")

    if polygon is None:
        # Last resort only: an oriented bounding box of the wall band. Flagged so
        # the designer knows the shape was assumed, not measured.
        wall_band = points[(points[:,1] > y_low+0.15) & (points[:,1] < y_high-0.15)]
        xz = wall_band[:, [0,2]] if len(wall_band) >= 100 else points[:, [0,2]]
        if len(xz) > 60000:
            xz = xz[np.linspace(0, len(xz)-1, 60000, dtype=int)]
        hull = MultiPoint(xz.tolist()).convex_hull
        if isinstance(hull, Polygon) and hull.area >= 0.5:
            box = hull.minimum_rotated_rectangle
            polygon = [[round(float(x),4), round(float(z),4)] for x,z in list(box.exterior.coords)[:-1]]
            plan = {**plan, "method": "ORIENTED_BOUNDING_BOX_FALLBACK"}
            plan.setdefault("notes", []).append("shape_is_assumed_rectangular")

    confidence = min(0.92, 0.35 + min(0.28, len(keyframes)*0.012) + min(0.22, len(points)/250000) + (0.07 if package.checksum_ok else 0))
    if plan.get("method") == "ORIENTED_BOUNDING_BOX_FALLBACK":
        confidence = min(confidence, 0.45)
    return {
        "pointCount": int(len(points)), "keyframeCount": len(keyframes), "polygon": polygon,
        "heightM": round(height,3), "floorElevationM": round(float(y_low),3),
        "confidence": round(confidence,3), "uncertaintyM": round(max(0.03, 0.22*(1-confidence)),3),
        "bounds": {"min": points.min(axis=0).round(4).tolist(), "max": points.max(axis=0).round(4).tolist()},
        "keyframeErrors": keyframe_errors[:20], "points": points,
        "floorPlan": {k: v for k, v in plan.items() if k != "polygon"},
    }



def _measurement_dimensions(room_input: dict[str, Any], source: dict[str, Any]) -> tuple[float | None, float | None]:
    candidates = [room_input.get("measurements"), source.get("measurements")]
    length = width = None
    for value in candidates:
        if isinstance(value, dict):
            length = length or (float(value.get("lengthM")) if value.get("lengthM") is not None else None)
            width = width or (float(value.get("widthM")) if value.get("widthM") is not None else None)
        elif isinstance(value, list):
            for item in value:
                if not isinstance(item, dict) or item.get("valueM") is None:
                    continue
                label = str(item.get("label") or "").lower()
                if "length" in label and length is None: length = float(item["valueM"])
                if "width" in label and width is None: width = float(item["valueM"])
    return length, width


def _constrain_polygon(polygon: list[list[float]], length: float | None, width: float | None) -> tuple[list[list[float]], dict[str, Any]]:
    xs=[p[0] for p in polygon]; zs=[p[1] for p in polygon]
    minx,maxx,minz,maxz=min(xs),max(xs),min(zs),max(zs)
    current_length=maxx-minx; current_width=maxz-minz
    sx=(length/current_length) if length and current_length>1e-6 else 1.0
    sz=(width/current_width) if width and current_width>1e-6 else 1.0
    constrained=[[round(minx+(x-minx)*sx,4),round(minz+(z-minz)*sz,4)] for x,z in polygon]
    return constrained, {"applied": bool(length or width), "targetLengthM": length, "targetWidthM": width, "sourceLengthM": round(current_length,4), "sourceWidthM": round(current_width,4), "scaleX": round(sx,5), "scaleZ": round(sz,5), "constraintPriority": "TRUSTED_MEASUREMENT"}


def _measurement_residuals(room: dict[str, Any]) -> list[dict[str, Any]]:
    residuals: list[dict[str, Any]] = []
    polygon = _polygon_points(room.get("floorPolygon")) or []
    for measurement in room.get("measurements") or []:
        if not isinstance(measurement, dict):
            continue
        start, end = measurement.get("start"), measurement.get("end")
        value = measurement.get("valueM")
        if isinstance(start, list) and isinstance(end, list) and value is not None:
            calculated = math.dist([float(start[0]), float(start[1])], [float(end[0]), float(end[1])])
            residuals.append({"measurementId": measurement.get("id"), "expectedM": float(value), "modelM": round(calculated,4), "residualM": round(calculated-float(value),4), "withinTolerance": abs(calculated-float(value)) <= float(measurement.get("toleranceM") or 0.03)})
    if polygon:
        for idx, wall in enumerate(room.get("walls") or []):
            if isinstance(wall, dict) and wall.get("start") and wall.get("end"):
                wall["lengthM"] = round(math.dist(wall["start"], wall["end"]),4)
    return residuals



def _image_opening_proposals(package: CapturePackage) -> list[dict[str, Any]]:
    proposals: list[dict[str, Any]] = []
    for meta in _jsonl(_find(package.files, "keyframes.jsonl")):
        rel = str(meta.get("relativeDirectory") or f"keyframes/{meta.get('keyframeId')}").strip("/")
        rgb = _find(package.files, f"{rel}/{meta.get('rgbFile', 'rgb.jpg')}")
        if not rgb:
            continue
        image = cv2.imdecode(np.frombuffer(rgb, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None or image.size == 0:
            continue
        h, w = image.shape[:2]
        small = cv2.resize(image, (min(960, w), max(1, int(h * min(960, w) / w)))) if w > 960 else image
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (5, 5), 0)
        edges = cv2.Canny(gray, 60, 160)
        contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        sh, sw = gray.shape[:2]
        candidates: list[tuple[float, int, int, int, int]] = []
        for contour in contours:
            perimeter = cv2.arcLength(contour, True)
            approx = cv2.approxPolyDP(contour, 0.025 * perimeter, True)
            if len(approx) != 4 or not cv2.isContourConvex(approx):
                continue
            x, y, cw, ch = cv2.boundingRect(approx)
            area_ratio = (cw * ch) / max(1, sw * sh)
            aspect = ch / max(1, cw)
            if area_ratio < 0.025 or area_ratio > 0.65 or aspect < 0.65 or aspect > 4.5:
                continue
            rectangularity = cv2.contourArea(approx) / max(1, cw * ch)
            if rectangularity < 0.65:
                continue
            score = area_ratio * rectangularity
            candidates.append((score, x, y, cw, ch))
        candidates.sort(reverse=True)
        kept: list[tuple[int, int, int, int]] = []
        for score, x, y, cw, ch in candidates:
            box = (x, y, cw, ch)
            if any(abs(x-kx) < 0.08*sw and abs(y-ky) < 0.08*sh and abs(cw-kw) < 0.12*sw and abs(ch-kh) < 0.12*sh for kx,ky,kw,kh in kept):
                continue
            kept.append(box)
            touches_floor = y + ch >= sh * 0.88
            kind = "DOOR" if touches_floor and ch / max(1, cw) >= 1.35 else "WINDOW"
            proposals.append({
                "id": f"image-opening-{meta.get('keyframeId')}-{len(kept)}", "type": kind,
                "placementStatus": "UNPLACED", "confidence": round(min(0.62, 0.28 + score), 3),
                "source": "IMAGE_RECTANGLE_HEURISTIC", "evidenceRefs": [package.asset_id],
                "keyframeId": meta.get("keyframeId"),
                "normalizedBoundingBox": [round(x/sw,4), round(y/sh,4), round(cw/sw,4), round(ch/sh,4)],
                "requiresDesignerReview": True,
            })
            if len(kept) >= 3:
                break
    return proposals[:18]


def _operator_opening_proposals(package: CapturePackage) -> list[dict[str, Any]]:
    proposals = []
    for markup in _jsonl(_find(package.files, "operator-markups.jsonl")):
        kind = str(markup.get("type") or "").upper()
        if kind not in {"DOOR", "WINDOW", "OPENING", "PASSAGE"}:
            continue
        proposals.append({
            "id": str(markup.get("id") or f"proposal-{len(proposals)+1}"),
            "type": "OPENING" if kind in {"PASSAGE", "OPENING"} else kind,
            "placementStatus": "UNPLACED", "confidence": 0.45,
            "source": "OPERATOR_MARKUP", "evidenceRefs": [package.asset_id],
            "cameraTranslationM": markup.get("cameraTranslationM"), "capturedAtEpochMs": markup.get("capturedAtEpochMs")
        })
    return proposals


def _qa_room(room: dict[str, Any]) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    polygon = _polygon_points(room.get("floorPolygon"))
    if not polygon:
        return [{"code":"INVALID_ROOM_POLYGON","severity":"ERROR","roomId":room.get("id")}]
    poly = Polygon(polygon)
    if not poly.is_valid:
        issues.append({"code":"SELF_INTERSECTING_POLYGON","severity":"ERROR","details":explain_validity(poly)})
    if float(room.get("heightM") or 0) < 1.8:
        issues.append({"code":"IMPLAUSIBLE_CEILING_HEIGHT","severity":"WARNING"})
    for wall in room.get("walls") or []:
        length = math.dist(wall.get("start") or [0,0], wall.get("end") or [0,0])
        occupied: list[tuple[float,float,str]] = []
        for opening in wall.get("openings") or []:
            start = float(opening.get("offsetM") or 0); end = start + float(opening.get("widthM") or 0)
            if start < 0 or end > length + 1e-6:
                issues.append({"code":"OPENING_OUTSIDE_WALL","severity":"ERROR","wallId":wall.get("id"),"openingId":opening.get("id")})
            for a,b,oid in occupied:
                if max(a,start) < min(b,end)-1e-6:
                    issues.append({"code":"OPENING_OVERLAP","severity":"ERROR","wallId":wall.get("id"),"openingIds":[oid,opening.get("id")]})
            occupied.append((start,end,str(opening.get("id"))))
    for residual in room.get("measurementResiduals") or []:
        if not residual.get("withinTolerance"):
            issues.append({"code":"MEASUREMENT_CONTRADICTION","severity":"WARNING",**residual})
    return issues


def generate_modeb_geometry(payload: dict[str, Any]) -> dict[str, Any]:
    rooms_input = payload.get("rooms") or []
    current_model = deepcopy(payload.get("currentModel") if isinstance(payload.get("currentModel"), dict) else {})
    current_by_id = {str(room.get("id")): room for room in current_model.get("rooms") or [] if isinstance(room, dict) and room.get("id")}
    packages = load_capture_packages(payload.get("assets") or [])
    package_by_room = {package.room_id: package for package in packages}
    rooms: list[dict[str, Any]] = []
    proposals: list[dict[str, Any]] = []
    all_issues: list[dict[str, Any]] = []
    point_clouds: list[np.ndarray] = []

    for room_input in rooms_input:
        room_id = str(room_input.get("id"))
        source = deepcopy(current_by_id.get(room_id) or room_input.get("roomModel") or {})
        package = package_by_room.get(room_id)
        sensor = _room_sensor_proposal(package) if package else {"pointCount":0,"polygon":None,"heightM":None,"confidence":0.0}
        if isinstance(sensor.get("points"), np.ndarray):
            point_clouds.append(sensor.pop("points"))
        manual_polygon = _polygon_points(source.get("floorPolygon")) or _polygon_points(room_input.get("floorPolygon"))
        sensor_polygon = _polygon_points(sensor.get("polygon"))
        measured_length, measured_width = _measurement_dimensions(room_input, source)
        constraint_optimization: dict[str, Any] = {"applied": False}
        if manual_polygon:
            polygon = manual_polygon
            if sensor_polygon:
                manual_shape, sensor_shape = Polygon(manual_polygon), Polygon(sensor_polygon)
                constraint_optimization = {"applied": True, "strategy": "OPERATOR_CONFIRMED_POLYGON_OVERRIDES_SENSOR", "manualAreaM2": round(manual_shape.area,4), "sensorAreaM2": round(sensor_shape.area,4), "hausdorffDistanceM": round(manual_shape.hausdorff_distance(sensor_shape),4), "constraintPriority": "OPERATOR_CONFIRMED_GEOMETRY"}
        elif sensor_polygon:
            polygon, constraint_optimization = _constrain_polygon(sensor_polygon, measured_length, measured_width)
            constraint_optimization["strategy"] = "SENSOR_POLYGON_SCALED_TO_TRUSTED_DIMENSIONS"
        else:
            polygon = None
        if not polygon:
            length = measured_length or 3.5; width = measured_width or 3.0
            polygon = [[0,0],[length,0],[length,width],[0,width]]
            constraint_optimization = {"applied": True, "strategy": "RECTANGLE_FROM_TRUSTED_DIMENSIONS", "targetLengthM": length, "targetWidthM": width, "constraintPriority": "TRUSTED_MEASUREMENT"}
            all_issues.append({"roomId":room_id,"code":"POLYGON_FALLBACK_FROM_DIMENSIONS","severity":"WARNING"})
        height = float(source.get("heightM") or room_input.get("ceilingHeightM") or sensor.get("heightM") or 2.8)
        confidence = float(sensor.get("confidence") or (0.58 if manual_polygon else 0.35))
        evidence_refs = [package.asset_id] if package else []
        walls = deepcopy(source.get("walls")) if isinstance(source.get("walls"), list) and source.get("walls") else _walls(room_id, polygon, height, evidence_refs, confidence)
        room = {
            **source, "id":room_id, "name":str(room_input.get("name") or source.get("name") or "Room"),
            "floorId":str(source.get("floorId") or "floor-1"), "heightM":height,
            "floorPolygon":polygon, "walls":walls, "objects":source.get("objects") if isinstance(source.get("objects"),list) else [],
            "measurements":source.get("measurements") if isinstance(source.get("measurements"),list) else [],
            "scaleStatus":"MEASURED_DRAFT" if (source.get("measurements") or room_input.get("measurements")) else "UNSCALED_DRAFT",
            "verificationStatus":"DESIGNER_REVIEW_REQUIRED", "confidence":round(max(float(source.get("confidence") or 0), confidence),3),
            "sourceTier":"DEPTH_ASSISTED_DRAFT" if sensor.get("pointCount") else ("AR_ASSISTED_DRAFT" if package else "MANUAL_MEASURED_DRAFT"),
            "evidenceRefs":list(dict.fromkeys((source.get("evidenceRefs") or []) + evidence_refs)),
            "sensorProposal":sensor, "constraintOptimization": constraint_optimization,
            "unplacedOpeningProposals":((_operator_opening_proposals(package) + _image_opening_proposals(package)) if package else []),
        }
        room["measurementResiduals"] = _measurement_residuals(room)
        issues = _qa_room(room)
        room["quality"] = {"issues":issues,"requiresDesignerCorrection":True,"estimatedUncertaintyM":sensor.get("uncertaintyM")}
        all_issues.extend({"roomId":room_id,**issue} for issue in issues)
        rooms.append(room)
        if sensor_polygon:
            proposals.append({"roomId":room_id,"proposalType":"ROOM_POLYGON","geometry":{"floorPolygon":sensor_polygon,"heightM":sensor.get("heightM")},"confidence":sensor.get("confidence"),"uncertaintyM":sensor.get("uncertaintyM"),"evidenceRefs":evidence_refs,"processorVersion":PROCESSOR_VERSION})
        for opening in room["unplacedOpeningProposals"]:
            proposals.append({"roomId":room_id,"proposalType":"OPENING","geometry":opening,"confidence":opening["confidence"],"evidenceRefs":opening["evidenceRefs"],"processorVersion":PROCESSOR_VERSION})

    floors = current_model.get("floors") if isinstance(current_model.get("floors"),list) else [{"id":"floor-1","name":"Floor 1","elevationM":0.0,"roomIds":[r["id"] for r in rooms]}]
    model = {
        **current_model, "schemaVersion":"2.1", "units":"meters", "coordinateSystem":"RIGHT_HANDED_Y_UP",
        "structure": current_model.get("structure") or {"id":"structure-1","globalOrientationDegrees":0.0,"captureSourceIds":[p.asset_id for p in packages]},
        "floors":floors, "rooms":rooms,
        "metadata": {**(current_model.get("metadata") or {}), "source":"modeb_rgbd_geometry_v3.1", "geometryStatus":"DRAFT_MODEL_READY", "verificationStatus":"DESIGNER_REVIEW_REQUIRED", "processorVersion":PROCESSOR_VERSION, "sourceEvidencePreserved":True, "structuralVerificationRequired":True, "roomConnections":payload.get("connections") or []}
    }
    evidence_output = None
    if point_clouds and payload.get("outputBucket") and payload.get("evidencePointCloudKey"):
        cloud = np.concatenate(point_clouds, axis=0)
        if len(cloud) > 300000:
            cloud = cloud[np.linspace(0,len(cloud)-1,300000,dtype=int)]
        mesh = trimesh.points.PointCloud(cloud)
        blob = mesh.export(file_type="ply")
        if isinstance(blob, str): blob = blob.encode()
        put_bytes(str(payload["outputBucket"]), str(payload["evidencePointCloudKey"]), blob, "application/octet-stream")
        evidence_output = {"objectKey":payload["evidencePointCloudKey"],"mimeType":"application/octet-stream","sizeBytes":len(blob),"pointCount":len(cloud)}
    report = {
        "status":"DRAFT_MODEL_READY", "processorVersion":PROCESSOR_VERSION, "roomCount":len(rooms),
        "issues":all_issues, "proposals":proposals,
        "capturePackages":[{"assetId":p.asset_id,"roomId":p.room_id,"checksumVerified":p.checksum_ok,"checksumErrors":p.checksum_errors,"schemaVersion":p.manifest.get("schemaVersion"),"keyframeCount":p.manifest.get("keyframeCount")} for p in packages],
        "requiresDesignerCorrection":True, "requiresSiteVerificationForFabrication":True,
    }
    return {"model":model,"report":report,"proposals":proposals,"evidencePointCloud":evidence_output}


def validate_model(payload: dict[str, Any]) -> dict[str, Any]:
    model = payload.get("model") if isinstance(payload.get("model"),dict) else {}
    issues=[]
    for room in model.get("rooms") or []:
        issues.extend({"roomId":room.get("id"),**item} for item in _qa_room(room))
    errors=sum(1 for i in issues if i.get("severity")=="ERROR")
    warnings=sum(1 for i in issues if i.get("severity")=="WARNING")
    return {"processorVersion":PROCESSOR_VERSION,"valid":errors==0,"errorCount":errors,"warningCount":warnings,"issues":issues,"verificationStatus":model.get("metadata",{}).get("verificationStatus")}
