-- ProgressionAi V1 Patch 02: resumable capture uploads.
-- Additive migration; apply after 20260911_progression_spatial_foundation.

CREATE TABLE "ResumableUpload" (
    "id" TEXT NOT NULL,
    "captureId" TEXT NOT NULL,
    "roomId" TEXT,
    "assetId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "totalSizeBytes" BIGINT NOT NULL,
    "chunkSizeBytes" INTEGER NOT NULL,
    "totalParts" INTEGER NOT NULL,
    "checksumSha256" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "uploadedBytes" BIGINT NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ResumableUpload_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResumableUploadPart" (
    "id" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "partNumber" INTEGER NOT NULL,
    "objectKey" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "checksumSha256" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ResumableUploadPart_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ResumableUpload_assetId_key" ON "ResumableUpload"("assetId");
CREATE UNIQUE INDEX "ResumableUpload_captureId_idempotencyKey_key" ON "ResumableUpload"("captureId", "idempotencyKey");
CREATE INDEX "ResumableUpload_captureId_status_idx" ON "ResumableUpload"("captureId", "status");
CREATE UNIQUE INDEX "ResumableUploadPart_objectKey_key" ON "ResumableUploadPart"("objectKey");
CREATE UNIQUE INDEX "ResumableUploadPart_uploadId_partNumber_key" ON "ResumableUploadPart"("uploadId", "partNumber");
CREATE INDEX "ResumableUploadPart_uploadId_status_idx" ON "ResumableUploadPart"("uploadId", "status");

ALTER TABLE "ResumableUpload" ADD CONSTRAINT "ResumableUpload_captureId_fkey"
    FOREIGN KEY ("captureId") REFERENCES "CaptureSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResumableUpload" ADD CONSTRAINT "ResumableUpload_roomId_fkey"
    FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ResumableUpload" ADD CONSTRAINT "ResumableUpload_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResumableUploadPart" ADD CONSTRAINT "ResumableUploadPart_uploadId_fkey"
    FOREIGN KEY ("uploadId") REFERENCES "ResumableUpload"("id") ON DELETE CASCADE ON UPDATE CASCADE;
