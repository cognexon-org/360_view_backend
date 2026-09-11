import { prisma } from './prisma.js';
import { asJson } from './json.js';
import { visionQueue } from './queue.js';

/**
 * Marks an already-present private object as uploaded and runs the same
 * post-upload side effects regardless of whether the bytes arrived through
 * the legacy single-PUT path or Patch 02's resumable chunk path.
 */
export async function finalizeCaptureAssetUpload(
  captureId: string,
  assetId: string,
  checksumSha256?: string
) {
  const asset = await prisma.asset.findFirst({ where: { id: assetId, captureId } });
  if (!asset) return null;

  const updated = await prisma.asset.update({
    where: { id: asset.id },
    data: { status: 'UPLOADED', checksumSha256: checksumSha256 ?? asset.checksumSha256 }
  });

  const metadata = asset.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata)
    ? asset.metadata as Record<string, unknown>
    : {};
  const originalFilename = String(metadata.originalFilename ?? '');
  const isCaptureManifest = asset.kind === 'CAPTURE_MANIFEST' && originalFilename === 'manifest.json';
  const isCaptureArchive = asset.kind === 'MODEL_EVIDENCE' && (
    asset.mimeType === 'application/zip' || originalFilename.toLowerCase().endsWith('.zip')
  );

  if (asset.roomId && (isCaptureManifest || isCaptureArchive)) {
    const packageId = `${captureId}:${asset.roomId}`;
    await prisma.capturePackage.upsert({
      where: { id: packageId },
      create: {
        id: packageId,
        captureId,
        roomId: asset.roomId,
        schemaVersion: '2.1',
        captureType: 'ANDROID_RGBD_ROOM_SCAN',
        status: 'UPLOADED',
        manifestAssetId: isCaptureManifest ? asset.id : undefined,
        archiveAssetId: isCaptureArchive ? asset.id : undefined
      },
      update: isCaptureManifest
        ? { manifestAssetId: asset.id, schemaVersion: '2.1', status: 'UPLOADED', checksumVerified: false }
        : { archiveAssetId: asset.id, schemaVersion: '2.1', status: 'UPLOADED', checksumVerified: false }
    });
  }

  if (asset.kind === 'PANORAMA') {
    const job = await prisma.processingJob.create({
      data: {
        type: 'PANORAMA_QA',
        assetId: asset.id,
        captureId,
        status: 'QUEUED',
        input: asJson({ source: 'asset-upload', checksumSha256: checksumSha256 ?? null })
      }
    });
    await visionQueue.add(
      'PANORAMA_QA',
      { jobId: job.id },
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, jobId: `panorama-qa-${asset.id}` }
    );
  }

  return updated;
}
