# Mode A stitching v2.2 — perfect-alignment release

## The problem being fixed

Frames "collided" in the stitched 360°: doubled furniture edges, misaligned wall
corners, ghosted door frames wherever two photos overlapped. Root cause: the old
pipeline was **open-loop** — it placed frames using only the phone's IMU pose and
a nominal field of view, then *averaged* overlaps. Every degree of sensor error
and every percent of FOV error appeared directly as a double image (1° ≈ 11 px at
4096 px width), and averaging renders misaligned content twice by construction.

## What changed

### Backend (`services/vision-python`)

| File | Status | Role |
|---|---|---|
| `app/processors/alignment.py` | **new** | IMU-seeded feature matching + `BundleAdjusterRay`. Solves per-frame rotations **and** the true shared focal length from image content. Gravity-levels the result using the accelerometer (no `waveCorrect` guessing). Falls back to IMU poses per frame when a frame can't be matched (blank wall, dark ceiling). |
| `app/processors/compositor.py` | **new** | Replaces weighted averaging with the correct three stages: block-channel exposure compensation → graph-cut seam finding → multi-band blending. Every output pixel comes from exactly one photo, so residual misalignment is cut around, never doubled. Also repairs the 1-px tear at the ±180° wrap and reports an `overlapDisagreement` parallax metric. |
| `app/processors/stitch.py` | **rewritten** | Orchestrates load → refine → wrap-meridian placement → composite → hole fill → QA. Keeps the old pose-projection blend as an automatic fallback, so no capture that succeeded before fails now. Removes the old ±8° "clamped correction" that knowingly mis-placed off-target frames. |
| `tests/test_stitch_alignment.py` | **new** | 11 tests: pose round-trips, FOV recovery from a 20%-wrong estimate, sensor-noise correction, textureless fallback, wrap-edge continuity, graceful degradation. |

Two OpenCV pitfalls are worked around explicitly (documented in code):
`BestOf2NearestMatcher` zeroes confidence for pairs it deems "too similar",
which discards exactly the strongest links of a guided capture; and the
spherical warper under-covers the outermost canvas column at the antimeridian.

### Android app

| File | Change |
|---|---|
| `CameraFovEstimator.kt` | Ring step `hfov × 0.72 → 0.60` (28% → 40% overlap), frame cap 8–10 → 10–16. Measured: 28% overlap fragments the match graph in ~1 of 4 captures under real sensor noise; 40% never did. |
| `PanoramaCaptureScreen.kt` | Yaw/pitch tolerance 7° → 3.5°; AE + AWB now **lock after the first frame** (Camera2 interop) and unlock if the operator retakes back to zero, so all frames share one exposure and white balance; reticle full-scale 45° → 20° to match the tighter tolerance. |

No API contract changes: the existing `PANORAMA_STITCH` payload works as-is.
Optional new payload fields: `refineAlignment` (default `true`),
`radialDistortionK1` (per-device barrel-distortion coefficient if you ever
calibrate one). New response fields: `headingOffsetDegrees` (subtract in the
viewer to restore the capture start heading), `alignment` (solve diagnostics),
`composite` (overlap disagreement metrics).

## Measured result (synthetic ground truth, 12-frame ring, true FOV 46°, reported 52°, ±5° pose noise)

|  | MAE ↓ | PSNR ↑ |
|---|---|---|
| old averaging | 43.8 | 12.6 dB |
| new pipeline | **20.4** | **19.3 dB** |

The bundle adjuster recovered the true FOV as 46.0° from the wrong 52° estimate.

## New QA issue codes worth surfacing in the app

- `overlap_mismatch_parallax_suspected` — frames disagree after alignment;
  operator likely rotated around their body instead of the lens. Warn.
- `severe_overlap_mismatch_recapture_required` — hard fail; re-shoot the room.
- `alignment_not_refined_from_images` — solve fell back to IMU-only (very dark
  or textureless room); result will look like the old pipeline's output.

## What still cannot be fixed in software

Parallax. If the phone orbits the operator's body, near objects genuinely move
between frames and no stitcher can reconcile them. The disagreement metric now
detects this **before the operator leaves the property** — that, plus the
"pivot around the lens" instruction in `CAPTURE_PROTOCOL.md`, is the fix.

## Running the tests

```bash
cd services/vision-python
pip install -r requirements.txt
VISION_SHARED_SECRET=x python -m pytest tests/ -q
```
