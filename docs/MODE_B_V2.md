# Mode B Backend v3.1.0

The public API keeps the `/v2` prefix, while the coordinated backend release is v3.1.0.

This release provides Android v3.1 capture-package validation, RGB-D evidence decoding and world-space fusion, conservative geometry proposals, measurement-aware canonical model schema 2.1 drafts, geometry QA and review, private working assets, confirmation-gated publishing, catalogue/material endpoints, design options, comments, approvals, share links, exports and server rendering jobs.

The reconstruction pipeline is deliberately evidence-preserving: sensor proposals do not silently replace operator-confirmed geometry. See `MODE_B_PIPELINE.md`, `API_V2.md`, and the root implementation matrix for exact coverage and deployment limitations.
