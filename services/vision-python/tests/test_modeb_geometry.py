import hashlib
import io
import json
import zipfile

import numpy as np

from app.processors.modeb_pipeline import _decode_depth, generate_modeb_geometry, validate_capture_packages


def test_generates_canonical_manual_rooms_without_fabricated_openings():
    output = generate_modeb_geometry({
        "rooms": [
            {"id": "living", "name": "Living", "ceilingHeightM": 2.8, "floorPolygon": [[0, 0], [4, 0], [4, 3], [0, 3]], "measurements": {"lengthM": 4, "widthM": 3}},
            {"id": "bed", "name": "Bedroom", "ceilingHeightM": 2.7, "measurements": {"lengthM": 3.2, "widthM": 2.8}},
        ],
        "assets": [],
    })
    rooms = output["model"]["rooms"]
    assert output["model"]["schemaVersion"] == "2.1"
    assert len(rooms) == 2
    assert rooms[0]["sourceTier"] == "MANUAL_MEASURED_DRAFT"
    assert all(not wall["openings"] for room in rooms for wall in room["walls"])
    assert output["report"]["requiresDesignerCorrection"] is True


def test_depth16_stride_decoder():
    width, height, row_stride = 3, 2, 8
    rows = bytearray(row_stride * height)
    values = [[1000, 1500, 2000], [2500, 3000, 3500]]
    for y in range(height):
        for x in range(width):
            value = values[y][x]
            rows[y * row_stride + x * 2] = value & 0xFF
            rows[y * row_stride + x * 2 + 1] = value >> 8
    decoded = _decode_depth(bytes(rows), {"width": width, "height": height, "rowStride": row_stride, "pixelStride": 2})
    assert decoded.tolist() == values


def test_capture_package_checksum_validation(monkeypatch):
    manifest = json.dumps({"schemaVersion": "2.0", "captureType": "ANDROID_RGBD_ROOM_SCAN", "keyframeCount": 1}).encode()
    keyframe = json.dumps({"keyframeId": "kf-1", "trackingState": "TRACKING"}).encode() + b"\n"
    summary = json.dumps({"keyframeCount": 1}).encode()
    checksums = "".join([
        f"{hashlib.sha256(manifest).hexdigest()}  manifest.json\n",
        f"{hashlib.sha256(keyframe).hexdigest()}  keyframes.jsonl\n",
        f"{hashlib.sha256(summary).hexdigest()}  capture_summary.json\n",
    ]).encode()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("manifest.json", manifest)
        archive.writestr("keyframes.jsonl", keyframe)
        archive.writestr("capture_summary.json", summary)
        archive.writestr("checksums.sha256", checksums)
    from app.processors import modeb_pipeline
    monkeypatch.setattr(modeb_pipeline, "get_bytes", lambda _bucket, _key: buffer.getvalue())
    result = validate_capture_packages({
        "rooms": [{"id": "living"}],
        "assets": [{"id": "archive", "roomId": "living", "kind": "MODEL_EVIDENCE", "bucket": "private", "objectKey": "capture.zip"}],
    })
    assert result["valid"] is True
    assert result["packages"][0]["checksumVerified"] is True


def test_rgbd_archive_is_unprojected_into_evidence(monkeypatch):
    width, height = 8, 6
    depth = (np.full((height, width), 2000, dtype='<u2')).tobytes()
    metadata = {
        "schemaVersion": "2.0", "keyframeId": "kf-1", "relativeDirectory": "keyframes/kf-1",
        "trackingState": "TRACKING", "translationM": [0, 1.4, 0], "quaternionXYZW": [0, 0, 0, 1],
        "focalLength": [8, 8], "principalPoint": [4, 3], "intrinsicsImageDimensions": [8, 6],
        "newRawDepth": True,
        "depth": {"rawDepth": {"file": "depth_raw.depth16", "width": width, "height": height, "rowStride": width * 2, "pixelStride": 2, "unit": "millimeters_uint16_little_endian"}}
    }
    manifest = json.dumps({"schemaVersion": "2.0", "captureType": "ANDROID_RGBD_ROOM_SCAN", "keyframeCount": 1}).encode()
    keyframes = (json.dumps(metadata) + "\n").encode()
    summary = json.dumps({"keyframeCount": 1}).encode()
    files = {
        "manifest.json": manifest, "keyframes.jsonl": keyframes, "capture_summary.json": summary,
        "keyframes/kf-1/metadata.json": json.dumps(metadata).encode(), "keyframes/kf-1/depth_raw.depth16": depth,
    }
    files["checksums.sha256"] = "".join(f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in files.items()).encode()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in files.items(): archive.writestr(name, data)
    from app.processors import modeb_pipeline
    monkeypatch.setattr(modeb_pipeline, "get_bytes", lambda _bucket, _key: buffer.getvalue())
    output = generate_modeb_geometry({
        "rooms": [{"id": "living", "name": "Living", "ceilingHeightM": 2.8, "floorPolygon": [[0,0],[4,0],[4,3],[0,3]]}],
        "assets": [{"id": "archive", "roomId": "living", "kind": "MODEL_EVIDENCE", "bucket": "private", "objectKey": "capture.zip"}],
    })
    room = output["model"]["rooms"][0]
    assert room["sourceTier"] == "DEPTH_ASSISTED_DRAFT"
    assert room["sensorProposal"]["pointCount"] > 0
    assert room["evidenceRefs"] == ["archive"]
