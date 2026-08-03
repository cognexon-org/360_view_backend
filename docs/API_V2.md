# Mode B API v2

All authenticated routes use a Bearer JWT and are organisation-scoped.

## Capture package

```http
POST /v2/captures/{captureId}/packages/finalize
GET  /v2/captures/{captureId}/packages
POST /v2/captures/{captureId}/roomplan-import
```

## Geometry and evidence

```http
POST /v2/captures/{captureId}/geometry-jobs
GET  /v2/geometry-jobs/{jobId}
GET  /v2/geometry-jobs/{jobId}/events
GET  /v2/design-projects/{projectId}/evidence
GET  /v2/models/{projectId}/proposals
POST /v2/models/{projectId}/proposals/{proposalId}/decision
POST /v2/models/{projectId}/measurements
GET  /v2/models/{projectId}/measurements
POST /v2/design-projects/{projectId}/model-qa
POST /v2/design-projects/{projectId}/reviews
```

## Design options and collaboration

```http
POST /v2/design-projects/{projectId}/options
GET  /v2/design-projects/{projectId}/options
GET  /v2/design-projects/{projectId}/comments
POST /v2/design-projects/{projectId}/comments/{commentId}/resolve
POST /v2/design-projects/{projectId}/share-links
POST /v2/design-projects/{projectId}/share-links/{linkId}/revoke
```

Public link actions:

```http
GET  /v2/public/design-links/{slug}
POST /v2/public/design-links/{slug}/comments
POST /v2/public/design-links/{slug}/approvals
```

## Renders and exports

```http
POST /v2/design-projects/{projectId}/renders
POST /v2/design-projects/{projectId}/exports
GET  /v2/design-projects/{projectId}/exports
GET  /v2/exports/{exportId}/download-url
```

Example render request:

```json
{
  "quality": "FINAL",
  "mode": "PANORAMA",
  "settings": { "width": 4096, "height": 2048 }
}
```

Example export request:

```json
{
  "format": "BOQ_XLSX",
  "version": 4
}
```

## Catalogue

```http
GET/POST /v2/catalogue/assets
GET/POST /v2/products
GET/POST /v2/materials
```
