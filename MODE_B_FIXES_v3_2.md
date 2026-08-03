# Mode B — how it works, and what I fixed (v3.2)

## Part 1: How Mode B actually produces a 3D model

Mode B is **not** photogrammetry and it does not build a textured mesh of your
furniture. It builds a **parametric room shell**: walls, floor, ceiling, doors
and windows as editable objects with real dimensions. That is what an interior
designer needs, and it is what your pipeline was already aiming at.

The chain, end to end:

```
1. ARCore scan (phone)
   Every ~0.6 s, if you have moved 18 cm or turned 11°, the app saves a KEYFRAME:
     keyframes/0007/rgb.jpg              the photo
     keyframes/0007/depth_raw.depth16    per-pixel distance, uint16 millimetres
     keyframes/0007/confidence...        per-pixel trust
     keyframes/0007/metadata.json        camera POSE + intrinsics at that instant
   Capped at 60 keyframes per room.

2. Field markup (phone) — this is the "floor / ceiling / door / window" screen
   You are NOT scanning those. You are TAGGING them: tap a wall, say "there is a
   door here, 0.9 m wide". These become operator opening proposals with
   confidence 1.0, and they beat anything the server guesses.

3. Package + upload
   The whole directory is zipped into Capture Package v2 with a SHA-256 manifest.

4. Server: depth -> point cloud
   Each depth pixel is unprojected through the camera intrinsics and placed in
   world space using that keyframe's ARCore pose. 60 keyframes fuse into a single
   cloud of ~240k points. ARCore's pose is metrically accurate, so this cloud is
   already in real metres — no scale guessing needed.

5. Server: point cloud -> floor plan        <-- THIS IS WHAT I REWROTE
   Slice the wall band, rasterise density, find the room outline.

6. Server: floor plan -> canonical model
   Polygon becomes walls; walls get height from the cloud; openings get attached;
   your tape/laser measurements override the sensor where they disagree.

7. Server: canonical model -> GLB / SVG / DXF / PDF
   trimesh extrudes the shell; exports.py draws the 2D plan.

8. Designer Studio corrects and confirms. Nothing is auto-published.
```

**Why it looked like nothing happened:** step 3 never completed. See Fix 2.

---

## Part 2: The three bugs

### Fix 1 — The 429 "Rate limit exceeded"

`MainViewModel.uploadArEvidence` walked the evidence directory and uploaded
**every file individually**. A 60-keyframe room is ~310 files (rgb + metadata +
two depth maps + confidence per keyframe). Each upload is **two** API calls
(presign + complete), so one room fired **~620 requests in a burst** against a
flat `max: 300, timeWindow: '1 minute'`. It died around file 150, every time.

The loop was also **completely redundant** — it then zipped the same directory
and uploaded the archive too, so every byte went to MinIO twice.

**Fixed:** upload only `manifest.json` + the archive. **620 requests → 4.**
Less data transferred too, because the zip is compressed.

Also made the limiter sane in `server.ts`:
- keyed per **authenticated user**, not per IP (your whole office shared one
  bucket behind NAT)
- upload/polling routes get a separate, much larger budget
- `/health` is never limited
- all three values are now env-configurable (`RATE_LIMIT_MAX`,
  `RATE_LIMIT_WINDOW`, `RATE_LIMIT_UPLOAD_MAX`)

### Fix 2 — Capture packages were never registered (the real reason no model appeared)

The backend contract requires `POST /v2/captures/:captureId/packages/finalize`
to pair the manifest asset with the archive asset. **That endpoint was never
called from the Android app — it did not exist in `ApiService.kt` at all.**

So even on a successful upload, the archive sat in object storage as an unlinked
blob. `load_capture_packages()` found nothing, geometry generation had no input,
and you got no model and no error explaining why.

**Fixed:** added `finalizeCapturePackages` to `ApiService`, `ApiModels`,
`BackendRepository`, and called it at the end of `uploadArEvidence`.

### Fix 3 — Every room came out a box or a blob

`_room_sensor_proposal` took the **convex hull** of the XZ projection, and fell
back to `minimum_rotated_rectangle` whenever the hull had >10 vertices (i.e.
almost always, since noise guarantees it).

Three fatal problems:
1. **A convex hull cannot represent a non-convex room.** L-shaped living rooms,
   alcoves, bay windows, chimney breasts, closet recesses — the hull spans
   straight across every one.
2. **A hull is defined by its outliers.** One stray point off a mirror or through
   an open doorway drags an entire edge out by half a metre.
3. **The fallback discarded shape entirely**, emitting an oriented bounding box.

**Fixed** with a new `app/processors/floorplan.py`:
density raster → dominant-axis (Manhattan) detection → morphological close →
largest interior region → contour trace → Douglas-Peucker → axis snapping.

Measured against synthetic ground-truth rooms (rotated 17°, with outliers):

| room | old IoU | **new IoU** |
|---|---|---|
| rectangular 5×4 | 0.231 | **0.980** |
| L-shaped | 0.237 | **0.976** |
| alcove / bay | 0.246 | **0.973** |
| T-shaped | 0.195 | **0.973** |

Walls come out square (every corner within 6° of 90°) and dimensions land within
25 cm. Non-convex rooms keep their concave corners. The oriented bounding box
survives only as an explicitly flagged last resort, capped at 0.45 confidence.

---

## Part 3: The viewer

`modeb_layout_viewer.html` — standalone, no build step. Drop a canonical model
JSON on it, or use the built-in demo flat. Walls with real door and window
cutouts, per-room area, wall-length dimensions, toggleable floor/ceiling, and
amber highlighting for anything still needing designer review.

Fetch a model to feed it with:
```
GET /v1/design-projects/{projectId}    ->  .model
```

---

## Testing

```bash
cd services/vision-python
VISION_SHARED_SECRET=xxxxxxxxxx python -m pytest tests/ -q      # 31 passed
```

`tests/test_modeb_floorplan.py` is new: it builds a real Capture Package v2 zip
(raycast depth maps, poses, checksums), runs it through the actual pipeline, and
asserts the recovered layout against ground truth.

---

## What is still worth doing

- **Depth range is the hard limit.** ARCore depth is trustworthy to ~5 m and the
  code clips at 8 m. Rooms wider than ~10 m need scanning from two positions;
  there is no multi-origin merge yet.
- **Opening detection is a rectangle heuristic** (`_image_opening_proposals`,
  capped at confidence 0.62). Your operator markup is far more reliable — keep
  tagging doors and windows in the app.
- **Furniture is not reconstructed.** The shell is walls/floor/ceiling/openings
  only. Interior objects come from the catalogue, placed in Designer Studio.
- **Mode A is untouched.** I verified `stitch.py`, `alignment.py` and
  `compositor.py` are byte-identical to v2.2.

---

## Fix 4 — Prisma build failure: duplicate `measurements` field on `Room`

```
Error code: P1012
error: Field "measurements" is already defined on model "Room".
  -->  prisma/schema.prisma:252
```

This is a **merge artefact**, not a runtime bug — it blocked `npm run build`, so
the api and worker images never got built at all.

`model Room` declared the name twice, and **both are genuinely used**:

| line | field | who uses it |
|---|---|---|
| 243 | `measurements Json?` | Mode A / legacy inline `{lengthM, widthM}` blob. Written by `routes/captures.ts`, read by `worker.ts` and `routes/design.ts` (`asRecord(room.measurements)`). |
| 252 | `measurements Measurement[]` | Mode B relation. Required as the back-reference for `Measurement.room`, used by `routes/modeb.ts`. |

Neither could simply be deleted: dropping the Json field breaks the capture
routes, and dropping the relation makes `Measurement.room` invalid, which is a
different P1012.

**Fix:** renamed the *relation* field to `measurementRecords`.

```prisma
incomingHotspots   Hotspot[]     @relation("HotspotTo")
measurementRecords Measurement[]
```

### Two things worth knowing

**No database migration is needed.** A list relation field on the "one" side of a
one-to-many has **no column in the database** — the actual foreign key is
`Measurement.roomId`, which is untouched. This is a rename in the generated
client only.

**No TypeScript changes were needed.** Every existing reference
(`worker.ts:158`, `worker.ts:233`, `design.ts:78`) reads the *Json* field, which
kept its name. Nothing anywhere did `include: { measurements: true }` on Room.

### Verification

I could not run `prisma validate` here — the CLI downloads engines from
`binaries.prisma.sh`, which this environment blocks. Instead I wrote a static
validator over the schema that checks the exact rules P1012 covers:

```
models=29 enums=11
duplicate fields:        0
unknown field types:     0
missing back-relations:  0
```

Run the real thing on your machine before rebuilding:

```bash
cd services/api-node
npx prisma validate
npm run build
```
