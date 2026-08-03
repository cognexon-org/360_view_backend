# Mode B Backend Implementation Matrix

| Improvement-report area | Backend v3.1 status | Implementation |
|---|---|---|
| Capture Package v2 | Implemented | Typed assets, ZIP/manifest records, checksum and archive validation |
| Adaptive keyframe storage | Implemented contract | Backend consumes app-selected fresh keyframes and records provenance |
| RGB-D normalization | Implemented | Depth16/confidence decode, intrinsics scaling, pose transformation |
| Point-cloud fusion evidence | Implemented MVP | Bounded world-space point accumulation and PLY evidence output |
| TSDF evidence mesh | Not included | Point evidence is implemented; production TSDF remains an optional future processor |
| Parametric room proposal | Implemented MVP | Field polygon priority plus sensor hull/plane proposal |
| Measurement constraints | Implemented | Trusted dimensions scale/validate draft and produce contradiction warnings |
| Opening inference | Implemented conservatively | Operator markups and low-confidence image candidates remain unplaced until review |
| Geometry QA | Implemented | Polygon, dimensions, openings, evidence and confidence checks |
| Canonical model v2 | Implemented as schema 2.1 | Structure metadata, floors, rooms, walls, openings, objects, measurements, provenance |
| Immutable versions | Implemented | DesignVersion and optimistic expected-version checks |
| Design options | Implemented | Named option models and statuses |
| Private/public asset rule | Implemented | Working outputs private; approved publication copies to public bucket |
| Confirmation gate | Implemented | Designer-confirmed/site-verified required before publication |
| Catalogue/material backend | Implemented foundation | CatalogueAsset, Product, ProductVariant and Material APIs/models |
| Render jobs | Implemented | Preview/final image/panorama/walkthrough job contract with Blender/fallback processor |
| Export jobs | Implemented | JSON, GLB, SVG, DXF, PDF, CSV/XLSX and report contracts/processors |
| Collaboration | Implemented | Comments, resolution, approvals, reviews and share links |
| Live progress | Implemented for geometry | SSE endpoint plus existing polling-compatible job endpoint |
| RoomPlan | Implemented ingestion contract | Source import and canonical conversion payload path; iOS client remains separate |
| AI layout/concept generation | Not included | Outside the requested deterministic Mode B backend foundation |

## Reconstruction note

The included geometry worker performs real Depth16 decoding and world-space unprojection. Its automatic topology stage is intentionally conservative and proposal-based. It does not silently replace operator-confirmed polygons, dimensions or openings. Production pilots should determine whether to add TSDF, learned opening detection and stronger multi-room registration after device-specific accuracy measurement.
