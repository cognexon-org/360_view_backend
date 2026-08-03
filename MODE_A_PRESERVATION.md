# Mode A Preservation Record

## Baseline

This release was created from the user's latest working Mode A backend archive, `360_view_backend-main (1).zip`.

## Byte-identical critical files

The release packaging process compared SHA-256 hashes for:

```text
services/vision-python/app/processors/stitch.py
services/vision-python/app/processors/alignment.py
services/vision-python/app/processors/compositor.py
services/vision-python/app/processors/panorama.py
services/api-node/src/routes/tours.ts
services/api-node/src/lib/manifest.ts
```

All six match the supplied baseline.

## Shared files changed only where required

- `captures.ts`: accepts new Mode B asset kinds and capture-package registration. Existing Mode A upload completion, panorama QA queueing and stitch APIs remain.
- `worker.ts`: adds Mode B payloads and completion handling. The Mode A panorama request and completion logic was retained.
- `capture_validation.py`: Mode B package checks are conditional on `DESIGN_SCAN`; Mode A validation remains on its original path.
- Prisma schema: adds Mode B entities and enum values without deleting Mode A tables, fields or enum values.
- `server.ts`: registers Mode B routes in addition to all existing routes.

## Mode A regression expectations

The following remain supported without a client contract change:

- OTP authentication
- Property/unit/room creation
- Guided panorama frame uploads
- Pose-aware stitch requests
- Quick Room View and Full Room Sphere
- Panorama QA
- Imported equirectangular panorama path
- Room graph validation
- Tour/hotspot creation
- Immutable public tour manifests
- Lead events

Run the existing Android Mode A flow and `scripts/smoke-test.sh` after deployment as the final environment-level regression check.
