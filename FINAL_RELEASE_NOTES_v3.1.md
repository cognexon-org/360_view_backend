# PropertyTour360 Unified Backend v3.1.0 — Release Notes

## Release purpose

Provide one backend for the unchanged working Mode A product and the new complete Mode B mobile/Studio workflow.

## Major additions

- Unified Mode A + Mode B job orchestration
- Android Capture Package v2.1 ingestion
- Typed RGB-D evidence and package checksum verification
- Depth16/confidence decoding and world-space evidence generation
- Capture-derived canonical room models
- Geometry proposals, confidence, provenance and QA
- Measurement records and review decisions
- Design options, versions, comments and approvals
- Catalogue/product/material foundations
- Private working assets and explicit public promotion
- Confirmation-gated design publication
- Render and professional export job families
- Expiring/revocable client share links
- SSE geometry progress

## Mode A

No intentional behavioral change was made to the critical panorama stitch, projection, blend, QA, tour route or manifest implementation. See `MODE_A_PRESERVATION.md`.

## Database

The API container runs `prisma db push` on local startup. For production, create reviewed Prisma migrations before deployment and back up the existing database first.

## Deployment sequence

1. Back up PostgreSQL and object storage.
2. Copy `.env.example` to `.env` and replace development secrets.
3. Build API and vision images.
4. Apply reviewed schema migration.
5. Start PostgreSQL, Redis, MinIO and vision.
6. Start API, then worker.
7. Run Mode A smoke regression.
8. Run Android v3.1 Mode B capture and draft-generation smoke test.
9. Verify private draft generation, confirmation gate and public promotion.

## Known deployment validation requirement

The source was validated without external package installation or Docker execution. Run `npm ci`, Prisma validation/generation, TypeScript build, Docker Compose startup and end-to-end device tests in CI or the deployment workstation before production use.
