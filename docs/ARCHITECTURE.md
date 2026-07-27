# Architecture

## Runtime services

```text
Android app / iOS app / seller dashboard
                    |
                    v
       Node.js API :3000 (Fastify)
       - OTP/JWT auth
       - organisations, properties and units
       - captures, rooms, assets and measurements
       - panorama tours and public manifests
       - design projects and model versions
       - signed MinIO upload URLs
       - processing-job status
                    |
             Redis/BullMQ
                    |
                    v
       Node.js worker (asynchronous orchestration)
                    |
                    v
       Python vision service :8001 (FastAPI)
       - feature-based panorama stitching baseline
       - panorama QA
       - heuristic face/privacy scan
       - capture graph validation
       - parametric room-shell GLB generation

PostgreSQL stores product and workflow data.
MinIO stores private source evidence and public, versioned delivery assets.
```

## Why two backend servers

The Node service owns tenancy, authentication, listings, capture workflows, publishing and public APIs. The Python service owns image, geometry and future ML processing. This separation lets the Python image grow independently into GPU-backed reconstruction without moving business logic out of the main API.

## Storage boundaries

- `propertytour-private`: raw photos, videos, ARCore/ARKit poses, depth, RoomPlan USDZ and unpublished outputs.
- `propertytour-public`: approved panoramas, tour manifests and generated GLB design models.
- Public clients never receive private signed upload URLs or raw trajectory/depth data.

## Processing lifecycle

```text
QUEUED -> RUNNING -> SUCCEEDED
                   -> FAILED (BullMQ retries according to job policy)
```

Capture validation produces either `READY` or `RECAPTURE_REQUIRED`. Tour publication is blocked unless the capture is `READY` and every room has an approved panorama.
