import { describe, expect, it } from 'vitest';
import { buildEvidenceInventoryDiff } from '../progress-comparison.js';

describe('buildEvidenceInventoryDiff', () => {
  it('scopes evidence by spatial room and never calls inventory delta progress', () => {
    const source = { id: 'a', capturedAt: '2026-01-01', sourceType: 'PROPERTY_TOUR', capture: { rooms: [{ id: 'r1', name: 'Living', spatialRoomId: 's1', panoramaAssetId: 'p1' }], assets: [{ id: 'p1', spatialRoomId: 's1', kind: 'PANORAMA', status: 'APPROVED' }] } };
    const target = { id: 'b', capturedAt: '2026-01-08', sourceType: 'PROPERTY_TOUR', capture: { rooms: [{ id: 'r2', name: 'Living', spatialRoomId: 's1', panoramaAssetId: 'p2' }], assets: [{ id: 'p2', spatialRoomId: 's1', kind: 'PANORAMA', status: 'APPROVED' }, { id: 'm1', spatialRoomId: 's1', kind: 'MODEL_EVIDENCE', status: 'APPROVED' }] } };
    const diff = buildEvidenceInventoryDiff(source, target, 's1');
    expect(diff.boundary).toBe('INVENTORY_ONLY');
    expect(diff.roomEvidence.targetPanoramas).toBe(1);
    expect(diff.assetKindDelta.find((row) => row.kind === 'MODEL_EVIDENCE')?.delta).toBe(1);
  });
});
