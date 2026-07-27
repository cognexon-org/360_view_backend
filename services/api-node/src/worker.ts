import { Worker } from 'bullmq';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { callVisionService } from './lib/vision-client.js';
import { config } from './config.js';
import { asJson } from './lib/json.js';

async function buildPayload(jobId: string) {
  const job = await prisma.processingJob.findUnique({
    where: { id: jobId },
    include: {
      asset: true,
      capture: { include: { rooms: { orderBy: { sortOrder: 'asc' } }, assets: true, connections: true } },
      designProject: true
    }
  });
  if (!job) throw new Error(`Processing job ${jobId} not found`);

  switch (job.type) {
    case 'PANORAMA_STITCH': {
      if (!job.capture) throw new Error('PANORAMA_STITCH requires a capture');
      const input = (job.input ?? {}) as { roomId?: string; assetIds?: string[] };
      if (!input.roomId || !Array.isArray(input.assetIds) || input.assetIds.length < 3) {
        throw new Error('PANORAMA_STITCH has invalid input');
      }
      const inputAssets = job.capture.assets.filter((asset) => input.assetIds!.includes(asset.id));
      if (inputAssets.length !== input.assetIds.length) throw new Error('Some stitch assets are missing');
      const outputKey = `org/${job.capture.unitId}/capture/${job.capture.id}/stitched/${input.roomId}-${job.id}.jpg`;
      return {
        job,
        request: {
          jobId: job.id,
          type: job.type,
          payload: {
            inputs: inputAssets.map((asset) => ({ bucket: config.MINIO_BUCKET_PRIVATE, objectKey: asset.objectKey })),
            outputBucket: config.MINIO_BUCKET_PRIVATE,
            outputKey
          }
        }
      };
    }
    case 'PANORAMA_QA': {
      if (!job.asset) throw new Error('PANORAMA_QA requires an asset');
      return {
        job,
        request: {
          jobId: job.id,
          type: job.type,
          payload: {
            bucket: config.MINIO_BUCKET_PRIVATE,
            objectKey: job.asset.objectKey,
            mimeType: job.asset.mimeType
          }
        }
      };
    }
    case 'PRIVACY_SCAN': {
      if (!job.asset) throw new Error('PRIVACY_SCAN requires an asset');
      return {
        job,
        request: {
          jobId: job.id,
          type: job.type,
          payload: { bucket: config.MINIO_BUCKET_PRIVATE, objectKey: job.asset.objectKey }
        }
      };
    }
    case 'CAPTURE_VALIDATION': {
      if (!job.capture) throw new Error('CAPTURE_VALIDATION requires a capture');
      const assetsById = new Map(job.capture.assets.map((asset) => [asset.id, asset]));
      return {
        job,
        request: {
          jobId: job.id,
          type: job.type,
          payload: {
            mode: job.capture.mode,
            rooms: job.capture.rooms.map((room) => {
              const panorama = room.panoramaAssetId ? assetsById.get(room.panoramaAssetId) : undefined;
              return {
                id: room.id,
                name: room.name,
                panoramaAssetId: room.panoramaAssetId,
                panoramaStatus: panorama?.status ?? null,
                ceilingHeightM: room.ceilingHeightM,
                floorPolygon: room.floorPolygon,
                measurements: room.measurements
              };
            }),
            connections: job.capture.connections.map((connection) => ({
              fromRoomId: connection.fromRoomId,
              toRoomId: connection.toRoomId
            })),
            assetKinds: job.capture.assets.map((asset) => asset.kind)
          }
        }
      };
    }
    case 'ROOM_SHELL': {
      if (!job.designProject) throw new Error('ROOM_SHELL requires a design project');
      const outputKey = `designs/${job.designProject.slug}/model-v${job.designProject.activeVersion}.glb`;
      return {
        job,
        request: {
          jobId: job.id,
          type: job.type,
          payload: {
            model: job.designProject.model,
            outputBucket: config.MINIO_BUCKET_PUBLIC,
            outputKey
          }
        }
      };
    }
    default:
      throw new Error(`Unsupported job type: ${String(job.type)}`);
  }
}

const worker = new Worker(
  'vision-jobs',
  async (queueJob) => {
    const jobId = String(queueJob.data.jobId);
    await prisma.processingJob.update({
      where: { id: jobId },
      data: { status: 'RUNNING', progress: 5, startedAt: new Date(), error: null }
    });

    try {
      const { job, request } = await buildPayload(jobId);
      const result = await callVisionService(request);
      const output = result.output ?? {};

      await prisma.$transaction(async (tx) => {
        if (job.type === 'PANORAMA_STITCH' && job.captureId) {
          const input = (job.input ?? {}) as { roomId?: string };
          const outputKey = typeof output.outputKey === 'string' ? output.outputKey : null;
          const mimeType = typeof output.mimeType === 'string' ? output.mimeType : 'image/jpeg';
          const sizeBytes = typeof output.sizeBytes === 'number' ? output.sizeBytes : 0;
          const qa = (output.qa ?? {}) as { approved?: boolean };
          if (!input.roomId || !outputKey || sizeBytes <= 0) throw new Error('Invalid panorama stitch result');
          const stitchedAsset = await tx.asset.create({
            data: {
              captureId: job.captureId,
              roomId: input.roomId,
              kind: 'PANORAMA',
              objectKey: outputKey,
              mimeType,
              sizeBytes: BigInt(sizeBytes),
              status: qa.approved === true ? 'APPROVED' : 'REJECTED',
              metadata: asJson(output)
            }
          });
          if (qa.approved === true) {
            await tx.room.update({ where: { id: input.roomId }, data: { panoramaAssetId: stitchedAsset.id } });
          }
        }

        if (job.type === 'PANORAMA_QA' && job.assetId) {
          const approved = output.approved === true;
          const updatedAsset = await tx.asset.update({
            where: { id: job.assetId },
            data: { status: approved ? 'APPROVED' : 'REJECTED', metadata: asJson(output) }
          });
          if (approved && updatedAsset.roomId) {
            await tx.room.update({ where: { id: updatedAsset.roomId }, data: { panoramaAssetId: updatedAsset.id } });
          }
        }

        if (job.type === 'CAPTURE_VALIDATION' && job.captureId) {
          const ready = output.ready === true;
          await tx.captureSession.update({
            where: { id: job.captureId },
            data: {
              status: ready ? 'READY' : 'RECAPTURE_REQUIRED',
              qualityReport: asJson(output)
            }
          });
        }

        if (job.type === 'ROOM_SHELL' && job.designProjectId) {
          const outputKey = typeof output.outputKey === 'string' ? output.outputKey : null;
          if (!outputKey) throw new Error('Vision service did not return outputKey');
          await tx.designProject.update({
            where: { id: job.designProjectId },
            data: { status: 'READY', generatedGlbKey: outputKey }
          });
        }

        await tx.processingJob.update({
          where: { id: jobId },
          data: { status: 'SUCCEEDED', progress: 100, output: asJson(output), completedAt: new Date() }
        });
      });
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.processingJob.update({
        where: { id: jobId },
        data: { status: 'FAILED', error: message, completedAt: new Date() }
      });
      throw error;
    }
  },
  { connection: redis, concurrency: 2 }
);

worker.on('completed', (job) => console.log(`Vision job ${job.id} completed`));
worker.on('failed', (job, error) => console.error(`Vision job ${job?.id ?? 'unknown'} failed`, error));

async function shutdown() {
  await worker.close();
  await redis.quit();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
