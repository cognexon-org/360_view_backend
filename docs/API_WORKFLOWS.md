# API workflows

The live OpenAPI interface is available at `http://localhost:3000/docs` after startup.

## 1. Development login

```bash
curl -s -X POST http://localhost:3000/v1/auth/otp/request \
  -H 'content-type: application/json' \
  -d '{"phone":"+919999999999"}'
```

When `DEV_OTP_EXPOSE=true`, copy `developmentOtp` into:

```bash
curl -s -X POST http://localhost:3000/v1/auth/otp/verify \
  -H 'content-type: application/json' \
  -d '{"phone":"+919999999999","code":"123456","name":"Demo Owner"}'
```

Use the returned JWT as `Authorization: Bearer TOKEN`.

## 2. Create property and unit

```bash
curl -X POST http://localhost:3000/v1/properties \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Demo PG","address":"Bengaluru","propertyType":"PG"}'

curl -X POST http://localhost:3000/v1/properties/PROPERTY_ID/units \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"label":"Room 101","bedrooms":1,"bathrooms":1}'
```

## 3. Mode A — property-tour capture

Create the capture and room nodes:

```bash
curl -X POST http://localhost:3000/v1/captures \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"unitId":"UNIT_ID","mode":"PROPERTY_TOUR","platform":"ANDROID","deviceMetadata":{"model":"demo"}}'

curl -X POST http://localhost:3000/v1/captures/CAPTURE_ID/rooms \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Entry","sortOrder":0}'
```

For an already-created 2:1 equirectangular panorama:

1. Request `/assets/upload-url` with `kind=PANORAMA` and a `roomId`.
2. HTTP `PUT` the bytes to `uploadUrl` using the returned content type.
3. Call `/assets/{assetId}/complete`.
4. Poll `/v1/jobs/{jobId}` or the capture endpoint until QA finishes.

For guided overlapping photos:

1. Upload three or more `PHOTO` assets against the same room.
2. Call `/rooms/{roomId}/stitch-panorama` with their asset IDs.
3. Poll the returned job. The baseline OpenCV stitcher creates and validates a panorama.

Connect rooms through `/v1/captures/{captureId}/connections`, then call `/submit`. After the capture becomes `READY`, create a tour, add yaw/pitch hotspots and publish it.

## 4. Mode B — design scan

Create a `DESIGN_SCAN` capture. Store source evidence through the same asset APIs:

- Android: `AR_POSES`, `CAMERA_INTRINSICS`, `DEPTH_MAP`, `DEPTH_CONFIDENCE`, panoramas and photos.
- iOS: `ROOMPLAN_USDZ`, panoramas and photos.
- All devices: confirmed dimensions in each room's `measurements`, `floorPolygon` and `ceilingHeightM`.

Create `/v1/design-projects` with the clean parametric model. See `examples/design-model.json`. Every update creates an immutable version. `/generate-shell` asks the Python service to produce a public GLB. `/publish` exposes a design-concept manifest.

## 5. Public delivery

```text
GET  /v1/public/tours/{slug}/manifest
POST /v1/public/tours/{slug}/leads
GET  /v1/public/designs/{slug}/manifest
```
