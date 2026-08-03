# Android v3.1 Integration Smoke Test

1. Start the Docker stack and sign in from Android.
2. Create a DESIGN_SCAN capture with two rooms.
3. Create one free polygon and one L-shaped room.
4. Add at least two openings and trusted measurements.
5. Scan one room with depth and upload all evidence.
6. Submit the capture; verify Capture Package checksum validation succeeds.
7. Create the design project and wait for the geometry job.
8. Confirm the project contains the submitted polygons, evidence references, sensor proposal and measurement residuals.
9. In Studio, correct a wall, save a version, run model QA and confirm the model.
10. Generate GLB, SVG, PDF, BOQ XLSX, still render and client share link.
11. Verify the client can comment and approve.
12. Revoke the link and verify it no longer opens.
