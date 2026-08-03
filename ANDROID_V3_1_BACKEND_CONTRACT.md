# Android v3.1 ↔ Unified Backend Contract

## Existing shared routes

The Android application continues to use the existing organisation, property, capture, room and upload routes.

### Capture asset kinds accepted

```text
PANORAMA
PHOTO
VIDEO
THUMBNAIL
AR_POSES
CAMERA_INTRINSICS
DEPTH_MAP
DEPTH_CONFIDENCE
ROOMPLAN_USDZ
FLOORPLAN
GLB
DESIGN_PREVIEW
RGB_KEYFRAME
AR_PLANES
CAPTURE_MANIFEST
MODEL_EVIDENCE
FLOORPLAN_SVG
DESIGN_RENDER
DESIGN_EXPORT
OTHER
```

The backend records the original filename in asset metadata. Only a ZIP `MODEL_EVIDENCE` asset is treated as the room evidence archive; individual JSON evidence assets remain independently queryable.

## Capture Package v2.1

Per-room packages can contain:

```text
manifest.json
capture_summary.json
checksums.sha256
poses.jsonl
planes.jsonl
intrinsics.json
measurements.json
operator-markups.json
keyframes/<id>/rgb.jpg
keyframes/<id>/depth_dense.depth16
keyframes/<id>/depth_raw.depth16
keyframes/<id>/confidence.confidence8
keyframes/<id>/metadata.json
```

The backend supports typed individual uploads plus the immutable package ZIP. It validates archive paths, entry sizes, checksums and manifest schema.

## Room updates

Room PATCH accepts:

- `floorPolygon`
- object or array `measurements`
- `openings`
- `roomPlacement`
- complete `roomModel`
- `ceilingHeightM`

Openings and room placement are retained in the room model when the client sends them separately.

## Project handoff

```http
POST /v1/design-projects
```

Request:

```json
{
  "captureId": "...",
  "name": "Design project name",
  "model": { "schemaVersion": "2.1", "rooms": [] },
  "generateGeometry": true
}
```

Response includes the created project, draft verification state and queued geometry job information. The project is not published automatically.

## Publication safety

Android submission creates a draft. Publication requires:

1. Geometry generation/QA
2. Designer correction
3. `DESIGNER_CONFIRMED` or `SITE_VERIFIED`
4. Private GLB generation
5. Explicit publish request

The backend rejects publication when confirmation or a ready private GLB is absent.
