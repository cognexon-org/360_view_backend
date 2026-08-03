import { Worker } from 'bullmq';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { callVisionService } from './lib/vision-client.js';
import { config } from './config.js';
import { asJson } from './lib/json.js';

const GEOMETRY_TYPES = new Set([
  'KEYFRAME_PROCESS',
  'DEPTH_FUSE',
  'SURFACE_EXTRACT',
  'ROOM_MODEL_INFER',
  'OPENING_INFER',
  'MODEL_OPTIMIZE',
  'MODEB_GEOMETRY'
]);
const EXPORT_TYPES = new Set(['EXPORT_MODEL', 'EXPORT_PLAN', 'EXPORT_SCHEDULE']);
const GLB_TYPES = new Set(['EXPORT_PARAMETRIC_SHELL_GLB', 'ROOM_SHELL', 'SCENE_ASSEMBLE']);
const RENDER_TYPES = new Set(['RENDER_PREVIEW', 'RENDER_FINAL']);

function extensionFor(format: string): string {
  const extensions: Record<string, string> = {
    CANONICAL_JSON: 'json',
    GLB: 'glb',
    GLB_LOW: 'glb',
    GLB_FULL: 'glb',
    SVG: 'svg',
    DXF: 'dxf',
    PDF: 'pdf',
    PNG: 'png',
    JPEG: 'jpg',
    CSV: 'csv',
    XLSX: 'xlsx',
    BOQ_CSV: 'csv',
    BOQ_XLSX: 'xlsx',
    MEASUREMENT_REPORT: 'csv',
    DOOR_WINDOW_SCHEDULE: 'csv',
    MATERIAL_SCHEDULE: 'csv'
  };
  return extensions[format] ?? 'bin';
}

async function buildPayload(jobId: string) {
  const job = await prisma.processingJob.findUnique({
    where: { id: jobId },
    include: {
      asset: true,
      capture: {
        include: {
          rooms: { orderBy: { sortOrder: 'asc' } },
          assets: true,
          connections: true,
          capturePackages: true
        }
      },
      designProject: true
    }
  });
  if (!job) throw new Error(`Processing job ${jobId} not found`);

  switch (job.type) {
    // Mode A payload is intentionally preserved from the supplied working backend.
    case 'PANORAMA_STITCH': {
      if (!job.capture) throw new Error('PANORAMA_STITCH requires a capture');
      const input = (job.input ?? {}) as {
        roomId?: string;
        assetIds?: string[];
        capturePattern?: string;
        frames?: Array<{
          assetId: string;
          fileName: string;
          targetYawDegrees: number;
          targetPitchDegrees: number;
          measuredYawDegrees: number;
          measuredPitchDegrees: number;
          measuredRollDegrees: number;
          capturedAtEpochMs: number;
        }>;
        horizontalFovDegrees?: number;
        verticalFovDegrees?: number;
        minPitchDegrees?: number;
        maxPitchDegrees?: number;
      };
      if (!input.roomId || !Array.isArray(input.assetIds) || input.assetIds.length < 3) {
        throw new Error('PANORAMA_STITCH has invalid input');
      }
      const assetsById = new Map(job.capture.assets.map((asset) => [asset.id, asset]));
      const frameByAssetId = new Map((input.frames ?? []).map((frame) => [frame.assetId, frame]));
      const inputAssets = input.assetIds.map((assetId) => {
        const asset = assetsById.get(assetId);
        if (!asset) throw new Error(`Stitch asset ${assetId} is missing`);
        const frame = frameByAssetId.get(assetId);
        return {
          bucket: config.MINIO_BUCKET_PRIVATE,
          objectKey: asset.objectKey,
          ...(frame ?? {})
        };
      });
      const outputKey = `org/${job.capture.unitId}/capture/${job.capture.id}/stitched/${input.roomId}-${job.id}.jpg`;
      return {
        job,
        request: {
          jobId: job.id,
          type: job.type,
          payload: {
            inputs: inputAssets,
            capturePattern: input.capturePattern ?? 'LEGACY_GUIDED',
            horizontalFovDegrees: input.horizontalFovDegrees,
            verticalFovDegrees: input.verticalFovDegrees,
            minPitchDegrees: input.minPitchDegrees,
            maxPitchDegrees: input.maxPitchDegrees,
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
      const basePayload = {
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
      };
      const payload = job.capture.mode === 'DESIGN_SCAN'
        ? {
            ...basePayload,
            assets: job.capture.assets.map((asset) => ({
              id: asset.id,
              roomId: asset.roomId,
              kind: asset.kind,
              bucket: config.MINIO_BUCKET_PRIVATE,
              objectKey: asset.objectKey,
              mimeType: asset.mimeType,
              metadata: asset.metadata
            }))
          }
        : basePayload;
      return {
        job,
        request: { jobId: job.id, type: job.type, payload }
      };
    }
    case 'CAPTURE_PACKAGE_VALIDATE': {
      if (!job.capture) throw new Error('CAPTURE_PACKAGE_VALIDATE requires a capture');
      return {
        job,
        request: {
          jobId: job.id,
          type: job.type,
          payload: {
            rooms: job.capture.rooms.map((room) => ({ id: room.id, name: room.name })),
            assets: job.capture.assets.map((asset) => ({
              id: asset.id,
              roomId: asset.roomId,
              kind: asset.kind,
              bucket: config.MINIO_BUCKET_PRIVATE,
              objectKey: asset.objectKey,
              mimeType: asset.mimeType,
              metadata: asset.metadata
            }))
          }
        }
      };
    }
    case 'KEYFRAME_PROCESS':
    case 'DEPTH_FUSE':
    case 'SURFACE_EXTRACT':
    case 'ROOM_MODEL_INFER':
    case 'OPENING_INFER':
    case 'MODEL_OPTIMIZE':
    case 'MODEB_GEOMETRY': {
      if (!job.capture || !job.designProject) {
        throw new Error(`${job.type} requires a capture and design project`);
      }
      const input = (job.input ?? {}) as Record<string, unknown>;
      const evidencePointCloudKey = `designs/${job.designProject.slug}/working/evidence-v${job.designProject.activeVersion + 1}-${job.id}.ply`;
      return {
        job,
        request: {
          jobId: job.id,
          type: job.type,
          payload: {
            projectId: job.designProject.id,
            currentModel: job.designProject.model,
            rooms: job.capture.rooms.map((room) => ({
              id: room.id,
              name: room.name,
              ceilingHeightM: room.ceilingHeightM,
              floorPolygon: room.floorPolygon,
              measurements: room.measurements,
              roomModel: room.roomModel
            })),
            connections: job.capture.connections,
            assets: job.capture.assets.map((asset) => ({
              id: asset.id,
              roomId: asset.roomId,
              kind: asset.kind,
              bucket: config.MINIO_BUCKET_PRIVATE,
              objectKey: asset.objectKey,
              mimeType: asset.mimeType,
              metadata: asset.metadata
            })),
            outputBucket: config.MINIO_BUCKET_PRIVATE,
            evidencePointCloudKey,
            requestedStages: input.requestedStages
          }
        }
      };
    }
    case 'MODEL_QA': {
      if (!job.designProject) throw new Error('MODEL_QA requires a design project');
      return {
        job,
        request: {
          jobId: job.id,
          type: job.type,
          payload: { model: job.designProject.model }
        }
      };
    }
    case 'ROOM_SHELL':
    case 'EXPORT_PARAMETRIC_SHELL_GLB':
    case 'SCENE_ASSEMBLE': {
      if (!job.designProject) throw new Error(`${job.type} requires a design project`);
      const input = (job.input ?? {}) as Record<string, unknown>;
      const exportRecordId = typeof input.exportRecordId === 'string' ? input.exportRecordId : null;
      const exportRecord = exportRecordId
        ? await prisma.exportRecord.findUnique({ where: { id: exportRecordId } })
        : null;
      const designOption = exportRecord?.designOptionId
        ? await prisma.designOption.findUnique({ where: { id: exportRecord.designOptionId } })
        : null;
      const format = String(input.format ?? exportRecord?.format ?? 'GLB');
      const outputKey = exportRecord
        ? `designs/${job.designProject.slug}/exports/${exportRecord.id}.${extensionFor(format)}`
        : `designs/${job.designProject.slug}/working/model-v${job.designProject.activeVersion}.glb`;
      return {
        job,
        exportRecord,
        request: {
          jobId: job.id,
          type: job.type,
          payload: {
            model: designOption?.model ?? job.designProject.model,
            outputBucket: config.MINIO_BUCKET_PRIVATE,
            outputKey,
            quality: format
          }
        }
      };
    }
    case 'RENDER_PREVIEW':
    case 'RENDER_FINAL': {
      if (!job.designProject) throw new Error(`${job.type} requires a design project`);
      const input = (job.input ?? {}) as Record<string, unknown>;
      const exportRecordId = String(input.exportRecordId ?? '');
      const exportRecord = await prisma.exportRecord.findUnique({ where: { id: exportRecordId } });
      if (!exportRecord || exportRecord.projectId !== job.designProject.id) {
        throw new Error('Render export record is missing or belongs to another project');
      }
      const designOption = exportRecord.designOptionId
        ? await prisma.designOption.findUnique({ where: { id: exportRecord.designOptionId } })
        : null;
      const settings = (input.settings ?? {}) as Record<string, unknown>;
      const extension = settings.renderMode === 'WALKTHROUGH' ? 'mp4' : 'png';
      const outputKey = `designs/${job.designProject.slug}/renders/${exportRecord.id}.${extension}`;
      return {
        job,
        exportRecord,
        request: {
          jobId: job.id,
          type: job.type,
          payload: {
            model: designOption?.model ?? job.designProject.model,
            settings,
            sourceGlb: job.designProject.generatedGlbKey
              ? { bucket: config.MINIO_BUCKET_PRIVATE, objectKey: job.designProject.generatedGlbKey }
              : null,
            outputBucket: config.MINIO_BUCKET_PRIVATE,
            outputKey
          }
        }
      };
    }
    case 'EXPORT_MODEL':
    case 'EXPORT_PLAN':
    case 'EXPORT_SCHEDULE': {
      if (!job.designProject) throw new Error(`${job.type} requires a design project`);
      const input = (job.input ?? {}) as Record<string, unknown>;
      const exportRecordId = String(input.exportRecordId ?? '');
      const exportRecord = await prisma.exportRecord.findUnique({ where: { id: exportRecordId } });
      if (!exportRecord || exportRecord.projectId !== job.designProject.id) {
        throw new Error('Export record is missing or belongs to another project');
      }
      const designOption = exportRecord.designOptionId
        ? await prisma.designOption.findUnique({ where: { id: exportRecord.designOptionId } })
        : null;
      const format = String(input.format ?? exportRecord.format);
      const outputKey = `designs/${job.designProject.slug}/exports/${exportRecord.id}.${extensionFor(format)}`;
      return {
        job,
        exportRecord,
        request: {
          jobId: job.id,
          type: job.type,
          payload: {
            model: designOption?.model ?? job.designProject.model,
            format,
            settings: input.settings ?? {},
            outputBucket: config.MINIO_BUCKET_PRIVATE,
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
      const built = await buildPayload(jobId);
      const { job, request } = built;
      const result = await callVisionService(request);
      const output = result.output ?? {};

      await prisma.$transaction(async (tx) => {
        // Mode A completion logic is intentionally preserved from the supplied backend.
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
          if (job.capture?.mode === 'DESIGN_SCAN') {
            const packageReports = ((output.capturePackages ?? {}) as { packages?: Array<Record<string, unknown>> }).packages ?? [];
            for (const report of packageReports) {
              const roomId = String(report.roomId ?? '');
              if (!roomId) continue;
              await tx.capturePackage.updateMany({
                where: { captureId: job.captureId, roomId },
                data: {
                  status: report.valid === true ? 'VALID' : 'INVALID',
                  checksumVerified: report.checksumVerified === true,
                  keyframeCount: Number(report.keyframeCount ?? 0),
                  quality: asJson(report)
                }
              });
            }
          }
        }

        if (job.type === 'CAPTURE_PACKAGE_VALIDATE' && job.captureId) {
          const reports = Array.isArray(output.packages)
            ? output.packages as Array<Record<string, unknown>>
            : [];
          for (const report of reports) {
            const roomId = String(report.roomId ?? '');
            if (!roomId) continue;
            await tx.capturePackage.updateMany({
              where: { captureId: job.captureId, roomId },
              data: {
                status: report.valid === true ? 'VALID' : 'INVALID',
                checksumVerified: report.checksumVerified === true,
                keyframeCount: Number(report.keyframeCount ?? 0),
                quality: asJson(report)
              }
            });
          }
        }

        if (GEOMETRY_TYPES.has(job.type) && job.designProjectId) {
          const model = output.model;
          if (!model || typeof model !== 'object') {
            throw new Error('Geometry service did not return a canonical model');
          }
          const project = await tx.designProject.findUniqueOrThrow({ where: { id: job.designProjectId } });
          const nextVersion = project.activeVersion + 1;
          const createdById = job.capture?.createdById;
          if (!createdById) throw new Error('Geometry job capture owner is missing');
          await tx.designVersion.create({
            data: {
              projectId: project.id,
              version: nextVersion,
              model: asJson(model),
              notes: 'RGB-D and measurement-constrained geometry draft',
              label: 'Geometry draft',
              createdById
            }
          });
          await tx.designProject.update({
            where: { id: project.id },
            data: {
              model: asJson(model),
              activeVersion: nextVersion,
              status: 'DRAFT_MODEL_READY',
              geometryStatus: 'DRAFT_MODEL_READY',
              verificationStatus: 'UNCONFIRMED',
              geometryReport: asJson(output.report ?? {}),
              generatedGlbKey: null
            }
          });
          const proposals = Array.isArray(output.proposals)
            ? output.proposals as Array<Record<string, unknown>>
            : [];
          for (const proposal of proposals) {
            const roomId = String(proposal.roomId ?? '');
            if (!roomId) continue;
            await tx.geometryProposal.create({
              data: {
                roomId,
                proposalType: String(proposal.proposalType ?? 'UNKNOWN'),
                geometry: asJson(proposal.geometry ?? {}),
                confidence: Number(proposal.confidence ?? 0),
                uncertaintyM: proposal.uncertaintyM == null ? null : Number(proposal.uncertaintyM),
                evidenceRefs: asJson(proposal.evidenceRefs ?? []),
                processorVersion: String(proposal.processorVersion ?? 'unknown')
              }
            });
          }
          const evidence = output.evidencePointCloud as Record<string, unknown> | undefined;
          if (evidence?.objectKey && job.captureId) {
            await tx.asset.create({
              data: {
                captureId: job.captureId,
                kind: 'MODEL_EVIDENCE',
                objectKey: String(evidence.objectKey),
                mimeType: String(evidence.mimeType ?? 'application/octet-stream'),
                sizeBytes: BigInt(Number(evidence.sizeBytes ?? 0)),
                status: 'APPROVED',
                metadata: asJson({
                  type: 'FUSED_POINT_CLOUD',
                  pointCount: evidence.pointCount,
                  processorVersion: (output.report as Record<string, unknown> | undefined)?.processorVersion
                })
              }
            });
          }
        }

        if (job.type === 'MODEL_QA' && job.designProjectId) {
          await tx.designProject.update({
            where: { id: job.designProjectId },
            data: { geometryReport: asJson(output) }
          });
        }

        if (GLB_TYPES.has(job.type) && job.designProjectId) {
          const outputKey = typeof output.outputKey === 'string' ? output.outputKey : null;
          if (!outputKey) throw new Error('GLB exporter returned no output key');
          const exportRecord = 'exportRecord' in built ? built.exportRecord : null;
          if (exportRecord) {
            await tx.exportRecord.update({
              where: { id: exportRecord.id },
              data: {
                status: 'SUCCEEDED',
                privateObjectKey: outputKey,
                mimeType: 'model/gltf-binary',
                sizeBytes: BigInt(Number(output.sizeBytes ?? 0)),
                metadata: asJson(output),
                completedAt: new Date()
              }
            });
          } else {
            await tx.designProject.update({
              where: { id: job.designProjectId },
              data: { status: 'READY', generatedGlbKey: outputKey }
            });
          }
        }

        if (RENDER_TYPES.has(job.type) && job.designProjectId) {
          const exportRecord = 'exportRecord' in built ? built.exportRecord : null;
          if (!exportRecord) throw new Error('Render record unavailable');
          await tx.exportRecord.update({
            where: { id: exportRecord.id },
            data: {
              status: 'SUCCEEDED',
              privateObjectKey: String(output.outputKey),
              mimeType: String(output.mimeType ?? 'image/png'),
              sizeBytes: BigInt(Number(output.sizeBytes ?? 0)),
              metadata: asJson(output),
              completedAt: new Date()
            }
          });
        }

        if (EXPORT_TYPES.has(job.type) && job.designProjectId) {
          const exportRecord = 'exportRecord' in built ? built.exportRecord : null;
          if (!exportRecord) throw new Error('Export record unavailable');
          await tx.exportRecord.update({
            where: { id: exportRecord.id },
            data: {
              status: 'SUCCEEDED',
              privateObjectKey: String(output.outputKey),
              mimeType: String(output.mimeType ?? 'application/octet-stream'),
              sizeBytes: BigInt(Number(output.sizeBytes ?? 0)),
              metadata: asJson(output),
              completedAt: new Date()
            }
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
      const failedJob = await prisma.processingJob.update({
        where: { id: jobId },
        data: { status: 'FAILED', error: message, completedAt: new Date() }
      });
      const input = (failedJob.input ?? {}) as Record<string, unknown>;
      if (typeof input.exportRecordId === 'string') {
        await prisma.exportRecord.updateMany({
          where: { id: input.exportRecordId },
          data: { status: 'FAILED', error: message, completedAt: new Date() }
        });
      }
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
