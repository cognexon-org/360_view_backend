export type ReportSnapshot = {
  id: string;
  capturedAt: Date | string;
  sourceType: string;
  status: string;
};

export type ReportIssue = {
  id: string;
  title: string;
  status: string;
  severity: string;
  verification?: string | null;
  spatialRoomId?: string | null;
  assigneeId?: string | null;
  dueAt?: Date | string | null;
  evidenceRefs?: unknown;
  updatedAt: Date | string;
};

export type ReportObservation = {
  id: string;
  observationType: string;
  status: string;
  confidence: number;
  spatialRoomId?: string | null;
  sourceSnapshotId?: string | null;
  targetSnapshotId?: string | null;
  structuredEvidence?: unknown;
  createdAt: Date | string;
};

export type ProgressReportInput = {
  project: { id: string; name: string; unitLabel?: string; propertyName?: string };
  periodStart?: Date | string | null;
  periodEnd?: Date | string | null;
  label?: string | null;
  snapshots: ReportSnapshot[];
  issues: ReportIssue[];
  observations: ReportObservation[];
};

function iso(value?: Date | string | null) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function safeEvidenceRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').slice(0, 25);
}

export function buildProgressReport(input: ProgressReportInput) {
  const openStatuses = new Set(['OPEN', 'IN_REVIEW']);
  const verifiedIssues = input.issues.filter((row) => row.verification === 'VERIFIED');
  const proposedObservations = input.observations.filter((row) => row.status === 'PROPOSED');
  const verifiedObservations = input.observations.filter((row) => ['CONFIRMED', 'CORRECTED'].includes(row.status));
  const rejectedObservations = input.observations.filter((row) => row.status === 'REJECTED');

  const severityOrder = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
  const issueSummary = input.issues
    .slice()
    .sort((a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity))
    .map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      severity: row.severity,
      verification: row.verification ?? 'UNVERIFIED',
      spatialRoomId: row.spatialRoomId ?? null,
      assigneeId: row.assigneeId ?? null,
      dueAt: iso(row.dueAt),
      evidenceRefs: safeEvidenceRefs(row.evidenceRefs),
      updatedAt: iso(row.updatedAt)
    }));

  const verifiedObservationSummary = verifiedObservations.map((row) => ({
    id: row.id,
    observationType: row.observationType,
    status: row.status,
    confidence: row.confidence,
    spatialRoomId: row.spatialRoomId ?? null,
    sourceSnapshotId: row.sourceSnapshotId ?? null,
    targetSnapshotId: row.targetSnapshotId ?? null,
    createdAt: iso(row.createdAt)
  }));

  const proposedObservationSummary = proposedObservations.map((row) => ({
    id: row.id,
    observationType: row.observationType,
    confidence: row.confidence,
    spatialRoomId: row.spatialRoomId ?? null,
    sourceSnapshotId: row.sourceSnapshotId ?? null,
    targetSnapshotId: row.targetSnapshotId ?? null,
    createdAt: iso(row.createdAt)
  }));

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    reportBoundary: 'PROJECT_REVIEW_AID_NOT_ENGINEERING_CERTIFICATION',
    disclaimerVersion: 'progress-report-v1',
    disclaimer: 'This report summarizes captured project evidence and human-reviewed workflow state. Proposed AI observations are not certified engineering, safety, compliance, contractual or payment determinations.',
    project: input.project,
    period: { start: iso(input.periodStart), end: iso(input.periodEnd), label: input.label ?? null },
    counts: {
      snapshots: input.snapshots.length,
      issues: input.issues.length,
      openIssues: input.issues.filter((row) => openStatuses.has(row.status)).length,
      resolvedIssues: input.issues.filter((row) => row.status === 'RESOLVED').length,
      rejectedIssues: input.issues.filter((row) => row.status === 'REJECTED').length,
      verifiedIssues: verifiedIssues.length,
      verifiedObservations: verifiedObservations.length,
      proposedObservations: proposedObservations.length,
      rejectedObservations: rejectedObservations.length
    },
    captures: input.snapshots.map((row) => ({ id: row.id, capturedAt: iso(row.capturedAt), sourceType: row.sourceType, status: row.status })),
    issues: issueSummary,
    verifiedObservations: verifiedObservationSummary,
    proposedObservations: proposedObservationSummary
  };
}
