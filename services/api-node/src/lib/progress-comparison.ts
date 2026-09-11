export interface SnapshotEvidenceLike {
  id: string;
  capturedAt: Date | string;
  sourceType: string;
  capture: {
    rooms: Array<{ id: string; spatialRoomId?: string | null; panoramaAssetId?: string | null; name: string }>;
    assets: Array<{ id: string; spatialRoomId?: string | null; kind: string; status: string }>;
  };
}

export function buildEvidenceInventoryDiff(source: SnapshotEvidenceLike, target: SnapshotEvidenceLike, spatialRoomId?: string) {
  const roomFilter = (room: { spatialRoomId?: string | null }) => !spatialRoomId || room.spatialRoomId === spatialRoomId;
  const assetFilter = (asset: { spatialRoomId?: string | null }) => !spatialRoomId || asset.spatialRoomId === spatialRoomId;

  const sourceRooms = source.capture.rooms.filter(roomFilter);
  const targetRooms = target.capture.rooms.filter(roomFilter);
  const sourceAssets = source.capture.assets.filter(assetFilter);
  const targetAssets = target.capture.assets.filter(assetFilter);

  const kinds = (rows: Array<{ kind: string; status: string }>) => rows.reduce<Record<string, number>>((acc, row) => {
    if (row.status === 'APPROVED' || row.status === 'UPLOADED') acc[row.kind] = (acc[row.kind] ?? 0) + 1;
    return acc;
  }, {});
  const sourceKinds = kinds(sourceAssets);
  const targetKinds = kinds(targetAssets);
  const kindNames = [...new Set([...Object.keys(sourceKinds), ...Object.keys(targetKinds)])].sort();

  return {
    sourceSnapshotId: source.id,
    targetSnapshotId: target.id,
    spatialRoomId: spatialRoomId ?? null,
    sourceCapturedAt: source.capturedAt,
    targetCapturedAt: target.capturedAt,
    sourceType: source.sourceType,
    targetType: target.sourceType,
    roomEvidence: {
      sourceRooms: sourceRooms.length,
      targetRooms: targetRooms.length,
      sourcePanoramas: sourceRooms.filter((room) => Boolean(room.panoramaAssetId)).length,
      targetPanoramas: targetRooms.filter((room) => Boolean(room.panoramaAssetId)).length
    },
    assetKindDelta: kindNames.map((kind) => ({ kind, source: sourceKinds[kind] ?? 0, target: targetKinds[kind] ?? 0, delta: (targetKinds[kind] ?? 0) - (sourceKinds[kind] ?? 0) })),
    boundary: 'INVENTORY_ONLY',
    disclaimer: 'This summary compares available evidence inventory only. It is not a geometric change/progress claim.'
  };
}
