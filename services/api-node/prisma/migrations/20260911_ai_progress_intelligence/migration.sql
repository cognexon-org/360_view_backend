-- Patch 07: AI Progress Intelligence v1
ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'PROGRESS_INTELLIGENCE';

CREATE TABLE "ProgressAnalysisRun" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "sourceSnapshotId" TEXT NOT NULL,
  "targetSnapshotId" TEXT NOT NULL,
  "registrationId" TEXT NOT NULL,
  "spatialRoomId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "engineVersion" TEXT NOT NULL,
  "modelVersion" TEXT,
  "policyVersion" TEXT NOT NULL,
  "inputRegions" JSONB NOT NULL,
  "diagnostics" JSONB,
  "jobId" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "error" TEXT,
  CONSTRAINT "ProgressAnalysisRun_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AiObservation" ADD COLUMN "analysisRunId" TEXT;

CREATE UNIQUE INDEX "ProgressAnalysisRun_jobId_key" ON "ProgressAnalysisRun"("jobId");
CREATE INDEX "ProgressAnalysisRun_projectId_createdAt_idx" ON "ProgressAnalysisRun"("projectId", "createdAt");
CREATE INDEX "ProgressAnalysisRun_sourceSnapshotId_targetSnapshotId_idx" ON "ProgressAnalysisRun"("sourceSnapshotId", "targetSnapshotId");
CREATE INDEX "ProgressAnalysisRun_registrationId_idx" ON "ProgressAnalysisRun"("registrationId");
CREATE INDEX "ProgressAnalysisRun_spatialRoomId_idx" ON "ProgressAnalysisRun"("spatialRoomId");
CREATE INDEX "AiObservation_analysisRunId_idx" ON "AiObservation"("analysisRunId");

ALTER TABLE "ProgressAnalysisRun" ADD CONSTRAINT "ProgressAnalysisRun_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "ProgressProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProgressAnalysisRun" ADD CONSTRAINT "ProgressAnalysisRun_sourceSnapshotId_fkey"
  FOREIGN KEY ("sourceSnapshotId") REFERENCES "CaptureSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProgressAnalysisRun" ADD CONSTRAINT "ProgressAnalysisRun_targetSnapshotId_fkey"
  FOREIGN KEY ("targetSnapshotId") REFERENCES "CaptureSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProgressAnalysisRun" ADD CONSTRAINT "ProgressAnalysisRun_registrationId_fkey"
  FOREIGN KEY ("registrationId") REFERENCES "CaptureRegistration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProgressAnalysisRun" ADD CONSTRAINT "ProgressAnalysisRun_spatialRoomId_fkey"
  FOREIGN KEY ("spatialRoomId") REFERENCES "SpatialRoom"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProgressAnalysisRun" ADD CONSTRAINT "ProgressAnalysisRun_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "ProcessingJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiObservation" ADD CONSTRAINT "AiObservation_analysisRunId_fkey"
  FOREIGN KEY ("analysisRunId") REFERENCES "ProgressAnalysisRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
