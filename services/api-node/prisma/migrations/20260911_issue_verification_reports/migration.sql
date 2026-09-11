-- Patch 06: Issues + Human Verification + Reports v1
ALTER TABLE "ProjectIssue"
  ADD COLUMN "dueAt" TIMESTAMP(3),
  ADD COLUMN "resolvedAt" TIMESTAMP(3),
  ADD COLUMN "closedById" TEXT,
  ALTER COLUMN "verification" SET DEFAULT 'UNVERIFIED';

UPDATE "ProjectIssue" SET "verification" = 'UNVERIFIED' WHERE "verification" IS NULL;
ALTER TABLE "ProjectIssue" ALTER COLUMN "verification" SET NOT NULL;

CREATE TABLE "IssueEvent" (
  "id" TEXT NOT NULL,
  "issueId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "fromStatus" TEXT,
  "toStatus" TEXT,
  "note" TEXT,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IssueEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectReport" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "reportType" TEXT NOT NULL DEFAULT 'MILESTONE',
  "label" TEXT,
  "periodStart" TIMESTAMP(3),
  "periodEnd" TIMESTAMP(3),
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "disclaimerVersion" TEXT NOT NULL,
  "content" JSONB NOT NULL,
  "generatedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProjectIssue_projectId_assigneeId_idx" ON "ProjectIssue"("projectId", "assigneeId");
CREATE INDEX "IssueEvent_issueId_createdAt_idx" ON "IssueEvent"("issueId", "createdAt");
CREATE INDEX "IssueEvent_actorId_idx" ON "IssueEvent"("actorId");
CREATE INDEX "ProjectReport_projectId_createdAt_idx" ON "ProjectReport"("projectId", "createdAt");
CREATE INDEX "ProjectReport_projectId_periodStart_periodEnd_idx" ON "ProjectReport"("projectId", "periodStart", "periodEnd");

ALTER TABLE "IssueEvent" ADD CONSTRAINT "IssueEvent_issueId_fkey"
  FOREIGN KEY ("issueId") REFERENCES "ProjectIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectReport" ADD CONSTRAINT "ProjectReport_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "ProgressProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
