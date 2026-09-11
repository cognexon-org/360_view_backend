import { describe, expect, it } from 'vitest';
import { buildProgressReport } from '../progress-report.js';

describe('buildProgressReport', () => {
  it('separates verified and proposed truth states', () => {
    const report = buildProgressReport({
      project: { id: 'p1', name: 'Tower A' },
      snapshots: [{ id: 's1', capturedAt: '2026-09-01T00:00:00Z', sourceType: 'PROPERTY_TOUR', status: 'PUBLISHED' }],
      issues: [
        { id: 'i1', title: 'Opening shift', status: 'IN_REVIEW', severity: 'HIGH', verification: 'VERIFIED', updatedAt: '2026-09-02T00:00:00Z' },
        { id: 'i2', title: 'Check finish', status: 'OPEN', severity: 'LOW', verification: 'UNVERIFIED', updatedAt: '2026-09-03T00:00:00Z' }
      ],
      observations: [
        { id: 'o1', observationType: 'FLOORING_ADDED', status: 'PROPOSED', confidence: 0.91, createdAt: '2026-09-03T00:00:00Z' },
        { id: 'o2', observationType: 'WALL_INSTALLED', status: 'CONFIRMED', confidence: 0.96, createdAt: '2026-09-04T00:00:00Z' }
      ]
    });
    expect(report.counts.openIssues).toBe(2);
    expect(report.counts.verifiedIssues).toBe(1);
    expect(report.counts.proposedObservations).toBe(1);
    expect(report.counts.verifiedObservations).toBe(1);
    expect(report.proposedObservations[0].id).toBe('o1');
    expect(report.verifiedObservations[0].id).toBe('o2');
    expect(report.reportBoundary).toContain('NOT_ENGINEERING_CERTIFICATION');
  });

  it('does not place arbitrary evidence payloads into the share-safe summary', () => {
    const report = buildProgressReport({
      project: { id: 'p1', name: 'Tower A' },
      snapshots: [],
      issues: [{ id: 'i1', title: 'Test', status: 'OPEN', severity: 'INFO', updatedAt: '2026-09-01T00:00:00Z', evidenceRefs: ['capture:s1', 123, { secret: true }] }],
      observations: []
    });
    expect(report.issues[0].evidenceRefs).toEqual(['capture:s1']);
    expect(JSON.stringify(report)).not.toContain('secret');
  });
});
