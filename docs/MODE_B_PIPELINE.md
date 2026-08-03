# Mode B Processing Pipeline

## 1. Package validation

The worker opens the per-room evidence ZIP, limits individual archive entries, reads `manifest.json`, `capture_summary.json`, `keyframes.jsonl` and `checksums.sha256`, and verifies every listed file.

## 2. Keyframe processing

For each keyframe with fresh depth:

1. Decode little-endian UInt16 depth using row and pixel strides.
2. Decode UInt8 confidence where available.
3. Reject invalid ranges and low confidence.
4. Scale camera intrinsics from CPU-image dimensions to depth dimensions.
5. Convert pixels to camera points.
6. Apply the ARCore camera quaternion and translation.
7. Downsample evidence to bounded memory.

## 3. Draft inference

The worker estimates floor and ceiling levels from point-height percentiles and proposes an XZ room boundary. A trusted field polygon remains authoritative. If only a sensor polygon and trusted length/width are available, the proposal is scaled to those measurements.

## 4. Openings

Operator-marked door/window/passage records become unplaced semantic proposals. RGB keyframes also receive a conservative rectangular-contour pass. Image candidates remain low-confidence and unplaced until a designer attaches them to a wall.

## 5. QA

Blocking checks include invalid polygons and openings outside or overlapping on a wall. Warnings include measurement contradictions and implausible heights. QA is stored against the project and checked before confirmation.

## 6. Derived outputs

The canonical JSON remains the editable source. Point clouds, GLB, plans, schedules and renders are reproducible derived assets tied to a model version and processor version.
