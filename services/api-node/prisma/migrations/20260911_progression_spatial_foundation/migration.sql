-- ProgressionAi spatial-temporal foundation.
-- Additive migration: legacy Mode A/Mode B tables are preserved.

ALTER TABLE "Room" ADD COLUMN IF NOT EXISTS "spatialRoomId" TEXT;
ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "spatialRoomId" TEXT;
ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "coordinateFrame" JSONB;
ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "spatialTransform" JSONB;
ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "spatialVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "quality" JSONB;
ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "provenance" JSONB;
ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "visibility" TEXT NOT NULL DEFAULT 'PRIVATE';

CREATE TABLE IF NOT EXISTS "ProgressProject" (
  "id" TEXT NOT NULL,
  "unitId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "captureCadence" TEXT,
  "projectFrame" JSONB,
  "progressPolicy" JSONB,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProgressProject_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SpatialFloor" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "level" INTEGER,
  "elevationM" DOUBLE PRECISION,
  "transform" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SpatialFloor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SpatialRoom" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "floorId" TEXT,
  "name" TEXT NOT NULL,
  "roomType" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "canonicalFrame" JSONB,
  "canonicalGeometry" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SpatialRoom_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CaptureSnapshot" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "captureId" TEXT NOT NULL,
  "floorId" TEXT,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'CAPTURING',
  "spatialScope" JSONB,
  "localCoordinateFrame" JSONB,
  "projectTransform" JSONB,
  "qualityReport" JSONB,
  "processingVersion" TEXT,
  "reconstructionVersion" TEXT,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CaptureSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CaptureRegistration" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "sourceSnapshotId" TEXT NOT NULL,
  "targetSnapshotId" TEXT NOT NULL,
  "transform" JSONB NOT NULL,
  "overlap" DOUBLE PRECISION,
  "confidence" DOUBLE PRECISION NOT NULL,
  "method" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PROPOSED',
  "verifiedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CaptureRegistration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ProjectIssue" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "spatialRoomId" TEXT,
  "captureSnapshotId" TEXT,
  "spatialRef" JSONB,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "severity" TEXT NOT NULL DEFAULT 'INFO',
  "assigneeId" TEXT,
  "verification" TEXT,
  "evidenceRefs" JSONB,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectIssue_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AiObservation" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "sourceSnapshotId" TEXT,
  "targetSnapshotId" TEXT,
  "spatialRoomId" TEXT,
  "observationType" TEXT NOT NULL,
  "spatialRef" JSONB,
  "structuredEvidence" JSONB NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "modelVersion" TEXT,
  "policyVersion" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PROPOSED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiObservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ObservationDecision" (
  "id" TEXT NOT NULL,
  "observationId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "decision" TEXT NOT NULL,
  "correctedValue" JSONB,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ObservationDecision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CaptureSnapshot_captureId_key" ON "CaptureSnapshot"("captureId");
CREATE UNIQUE INDEX IF NOT EXISTS "CaptureRegistration_sourceSnapshotId_targetSnapshotId_version_key" ON "CaptureRegistration"("sourceSnapshotId", "targetSnapshotId", "version");
CREATE INDEX IF NOT EXISTS "ProgressProject_unitId_idx" ON "ProgressProject"("unitId");
CREATE INDEX IF NOT EXISTS "ProgressProject_createdById_idx" ON "ProgressProject"("createdById");
CREATE INDEX IF NOT EXISTS "SpatialFloor_projectId_idx" ON "SpatialFloor"("projectId");
CREATE INDEX IF NOT EXISTS "SpatialRoom_projectId_idx" ON "SpatialRoom"("projectId");
CREATE INDEX IF NOT EXISTS "SpatialRoom_floorId_idx" ON "SpatialRoom"("floorId");
CREATE INDEX IF NOT EXISTS "SpatialRoom_projectId_name_idx" ON "SpatialRoom"("projectId", "name");
CREATE INDEX IF NOT EXISTS "Room_spatialRoomId_idx" ON "Room"("spatialRoomId");
CREATE INDEX IF NOT EXISTS "Asset_spatialRoomId_idx" ON "Asset"("spatialRoomId");
CREATE INDEX IF NOT EXISTS "CaptureSnapshot_projectId_capturedAt_idx" ON "CaptureSnapshot"("projectId", "capturedAt");
CREATE INDEX IF NOT EXISTS "CaptureSnapshot_floorId_idx" ON "CaptureSnapshot"("floorId");
CREATE INDEX IF NOT EXISTS "CaptureRegistration_projectId_idx" ON "CaptureRegistration"("projectId");
CREATE INDEX IF NOT EXISTS "ProjectIssue_projectId_status_idx" ON "ProjectIssue"("projectId", "status");
CREATE INDEX IF NOT EXISTS "ProjectIssue_spatialRoomId_idx" ON "ProjectIssue"("spatialRoomId");
CREATE INDEX IF NOT EXISTS "AiObservation_projectId_status_idx" ON "AiObservation"("projectId", "status");
CREATE INDEX IF NOT EXISTS "AiObservation_spatialRoomId_idx" ON "AiObservation"("spatialRoomId");
CREATE INDEX IF NOT EXISTS "ObservationDecision_observationId_idx" ON "ObservationDecision"("observationId");
CREATE INDEX IF NOT EXISTS "ObservationDecision_actorId_idx" ON "ObservationDecision"("actorId");

DO $$ BEGIN
  ALTER TABLE "ProgressProject" ADD CONSTRAINT "ProgressProject_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "SpatialFloor" ADD CONSTRAINT "SpatialFloor_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ProgressProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "SpatialRoom" ADD CONSTRAINT "SpatialRoom_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ProgressProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "SpatialRoom" ADD CONSTRAINT "SpatialRoom_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "SpatialFloor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Room" ADD CONSTRAINT "Room_spatialRoomId_fkey" FOREIGN KEY ("spatialRoomId") REFERENCES "SpatialRoom"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Asset" ADD CONSTRAINT "Asset_spatialRoomId_fkey" FOREIGN KEY ("spatialRoomId") REFERENCES "SpatialRoom"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CaptureSnapshot" ADD CONSTRAINT "CaptureSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ProgressProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CaptureSnapshot" ADD CONSTRAINT "CaptureSnapshot_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "CaptureSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CaptureSnapshot" ADD CONSTRAINT "CaptureSnapshot_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "SpatialFloor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CaptureRegistration" ADD CONSTRAINT "CaptureRegistration_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ProgressProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CaptureRegistration" ADD CONSTRAINT "CaptureRegistration_sourceSnapshotId_fkey" FOREIGN KEY ("sourceSnapshotId") REFERENCES "CaptureSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CaptureRegistration" ADD CONSTRAINT "CaptureRegistration_targetSnapshotId_fkey" FOREIGN KEY ("targetSnapshotId") REFERENCES "CaptureSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ProjectIssue" ADD CONSTRAINT "ProjectIssue_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ProgressProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ProjectIssue" ADD CONSTRAINT "ProjectIssue_spatialRoomId_fkey" FOREIGN KEY ("spatialRoomId") REFERENCES "SpatialRoom"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ProjectIssue" ADD CONSTRAINT "ProjectIssue_captureSnapshotId_fkey" FOREIGN KEY ("captureSnapshotId") REFERENCES "CaptureSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "AiObservation" ADD CONSTRAINT "AiObservation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ProgressProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "AiObservation" ADD CONSTRAINT "AiObservation_sourceSnapshotId_fkey" FOREIGN KEY ("sourceSnapshotId") REFERENCES "CaptureSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "AiObservation" ADD CONSTRAINT "AiObservation_targetSnapshotId_fkey" FOREIGN KEY ("targetSnapshotId") REFERENCES "CaptureSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "AiObservation" ADD CONSTRAINT "AiObservation_spatialRoomId_fkey" FOREIGN KEY ("spatialRoomId") REFERENCES "SpatialRoom"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ObservationDecision" ADD CONSTRAINT "ObservationDecision_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "AiObservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
