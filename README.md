# PropertyTour360 Unified Backend v3.1.0

Unified backend source release for:

- **Mode A — Property Tour:** the supplied, working panorama capture, stitch, QA, room graph and tour-publication pipeline.
- **Mode B — Design Scan:** Android Capture Package v2.1 ingestion, RGB-D evidence processing, canonical parametric drafts, designer review, versioned editing, exports, renders, catalogue data, collaboration and confirmation-gated publication.

This release was rebased on the user's latest working `360_view_backend-main (1).zip`. Mode A's critical panorama implementation is intentionally retained rather than rewritten.

## Services

| Service | Stack | Port | Purpose |
|---|---|---:|---|
| API | Node.js 22, TypeScript, Fastify, Prisma | 3000 | Auth, properties, captures, Mode A tours, Mode B projects and public APIs |
| Worker | Node.js, BullMQ | — | Long-running panorama, geometry, render and export orchestration |
| Vision | Python, FastAPI, OpenCV, NumPy, Shapely, trimesh | 8001 | Mode A stitching/QA and Mode B evidence/geometry/export processing |
| PostgreSQL | PostgreSQL 16 | 5432 | Organisation-scoped product and workflow data |
| Redis | Redis 7 | 6379 | BullMQ jobs, retries and progress |
| Object storage | MinIO | 9000/9001 | Private originals/drafts and approved public derivatives |

## Start locally

Requirements:

- Docker Desktop or Docker Engine with Compose
- Approximately 6–8 GB free RAM
- Ports 3000, 5432, 6379, 8001, 9000 and 9001 available

```bash
cp .env.example .env
docker compose up --build
```

Open:

```text
API:           http://localhost:3000
API docs:      http://localhost:3000/docs
Vision docs:   http://localhost:8001/docs
MinIO console: http://localhost:9001
```

For a physical Android device, replace the presign/public `localhost` values in `.env` with the computer's LAN IP address.

## Mode A preservation

The following critical Mode A files are SHA-256 identical to the supplied working backend:

- `services/vision-python/app/processors/stitch.py`
- `services/vision-python/app/processors/alignment.py`
- `services/vision-python/app/processors/compositor.py`
- `services/vision-python/app/processors/panorama.py`
- `services/api-node/src/routes/tours.ts`
- `services/api-node/src/lib/manifest.ts`

The panorama request payload and successful-processing completion path in `worker.ts` were preserved while adding new Mode B job types around them.

## Mode B implemented

### Capture and evidence

- Android Capture Package v2.1 registration
- Typed RGB keyframe, dense/raw depth, confidence, pose, intrinsics, plane, manifest and evidence assets
- Archive and manifest checksum verification
- Stale-depth filtering and package quality reporting
- RoomPlan source import endpoint
- Private-by-default evidence storage

### Geometry and canonical model

- Depth16/confidence decoding
- Camera-intrinsic scaling and RGB-D unprojection
- Camera-to-world pose transformation
- Bounded point-cloud evidence generation
- Floor/ceiling and room-boundary proposals
- Trusted field polygon preservation
- Measurement-constrained draft adjustment
- Unplaced door/window/passage proposals
- Evidence references, confidence, uncertainty and processor provenance
- Geometry QA and proposal accept/reject APIs
- Canonical schema 2.1 with floors, rooms, walls, openings, objects and measurements

### Design lifecycle

```text
CAPTURE_READY
→ MODEL_GENERATING
→ DRAFT_MODEL_READY
→ DESIGNER_CORRECTION
→ DESIGNER_CONFIRMED / SITE_VERIFIED
→ CLIENT_PRESENTATION_READY
→ PUBLISHED
```

- Projects are created from actual capture rooms rather than sample data
- Immutable model versions with optimistic version conflict checks
- Designer-confirmed/site-verified state gates
- Private working GLBs and exports
- Approved-version copy to the public bucket only during publication
- Unpublish and share-link revocation paths

### Studio/backend capabilities

- Design options
- Comments and resolution
- Client approvals/change requests
- Expiring or revocable client share links
- Catalogue assets, products, variants and materials
- Preview/final render jobs
- Canonical JSON, GLB, SVG, DXF, PDF, CSV/XLSX schedule/BOQ and measurement-report job types
- Server-Sent Events endpoint for geometry-job progress

## Android v3.1 integration

The corrected Android v3.1 app uses the existing `/v1` capture and design-project routes for its primary handoff. The backend also exposes advanced `/v2` Mode B routes for the Designer Studio and future iOS/RoomPlan clients.

See:

- `ANDROID_V3_1_BACKEND_CONTRACT.md`
- `MODE_A_PRESERVATION.md`
- `MODE_B_BACKEND_IMPLEMENTATION_MATRIX.md`
- `docs/API_V2.md`
- `docs/MODE_B_PIPELINE.md`

## Accuracy boundary

The canonical model remains authoritative. Sensor-derived point clouds, planes, opening candidates and room polygons are proposals until reviewed. This system is for interior visualization and space planning, not legal survey, structural certification or fabrication without qualified site verification.

## Validation

See `RELEASE_VALIDATION.md`. The included Python test suite passed 23 tests, TypeScript source parsed without syntax errors, Docker Compose YAML parsed, Mode A critical hashes matched and ZIP integrity was verified. A complete Node/Prisma/Docker integration build still must be executed in the deployment environment because package installation and Docker were unavailable during packaging.
