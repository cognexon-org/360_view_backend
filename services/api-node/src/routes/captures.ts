import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { prisma } from '../lib/prisma.js';
import { minio, minioSigner } from '../lib/minio.js';
import { config } from '../config.js';
import { safeObjectName } from '../lib/security.js';
import { getCaptureForOrganization, getUnitForOrganization } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/http.js';
import { asJson } from '../lib/json.js';
import { visionQueue } from '../lib/queue.js';

export async function captureRoutes(app: FastifyInstance) {
  app.get('/v1/captures', { preHandler: [app.authenticate] }, async (request) => {
    return prisma.captureSession.findMany({
      where: { unit: { property: { organizationId: request.user.organizationId } } },
      include: {
        unit: { include: { property: true } },
        rooms: true,
        assets: true,
        connections: true,
        jobs: { orderBy: { createdAt: 'desc' }, take: 5 }
      },
      orderBy: { createdAt: 'desc' }
    });
  });

  app.post('/v1/captures', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const body = z
        .object({
          unitId: z.string().min(1),
          mode: z.enum(['PROPERTY_TOUR', 'DESIGN_SCAN']),
          platform: z.enum(['ANDROID', 'IOS', 'WEB']),
          deviceMetadata: z.record(z.unknown()).optional(),
          checklist: z.record(z.unknown()).optional()
        })
        .parse(request.body);
      const unit = await getUnitForOrganization(body.unitId, request.user.organizationId);
      if (!unit) return notFound(reply, 'Unit');

      const capture = await prisma.captureSession.create({
        data: {
          unitId: unit.id,
          createdById: request.user.userId,
          mode: body.mode,
          platform: body.platform,
          status: 'CAPTURING',
          startedAt: new Date(),
          deviceMetadata: body.deviceMetadata ? asJson(body.deviceMetadata) : undefined,
          checklist: body.checklist ? asJson(body.checklist) : undefined
        }
      });
      await audit({
        organizationId: request.user.organizationId,
        actorId: request.user.userId,
        entityType: 'CaptureSession',
        entityId: capture.id,
        action: 'CREATE',
        payload: { mode: capture.mode, platform: capture.platform }
      });
      return reply.code(201).send(capture);
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.get('/v1/captures/:captureId', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { captureId } = request.params as { captureId: string };
    const capture = await prisma.captureSession.findFirst({
      where: { id: captureId, unit: { property: { organizationId: request.user.organizationId } } },
      include: {
        unit: { include: { property: true } },
        rooms: { orderBy: { sortOrder: 'asc' } },
        assets: true,
        connections: true,
        jobs: { orderBy: { createdAt: 'desc' } }
      }
    });
    return capture ? reply.send(capture) : notFound(reply, 'Capture');
  });

  app.post('/v1/captures/:captureId/rooms', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { captureId } = request.params as { captureId: string };
      const capture = await getCaptureForOrganization(captureId, request.user.organizationId);
      if (!capture) return notFound(reply, 'Capture');
      const body = z
        .object({
          name: z.string().min(1).max(100),
          sortOrder: z.number().int().min(0).optional(),
          ceilingHeightM: z.number().positive().max(20).optional(),
          floorPolygon: z.array(z.tuple([z.number(), z.number()])).min(3).optional(),
          measurements: z.record(z.unknown()).optional(),
          roomModel: z.record(z.unknown()).optional()
        })
        .parse(request.body);
      const room = await prisma.room.create({
        data: {
          captureId,
          name: body.name,
          sortOrder: body.sortOrder ?? 0,
          ceilingHeightM: body.ceilingHeightM,
          floorPolygon: body.floorPolygon ? asJson(body.floorPolygon) : undefined,
          measurements: body.measurements ? asJson(body.measurements) : undefined,
          roomModel: body.roomModel ? asJson(body.roomModel) : undefined
        }
      });
      return reply.code(201).send(room);
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.patch('/v1/captures/:captureId/rooms/:roomId', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { captureId, roomId } = request.params as { captureId: string; roomId: string };
      const capture = await getCaptureForOrganization(captureId, request.user.organizationId);
      if (!capture) return notFound(reply, 'Capture');
      const existing = await prisma.room.findFirst({ where: { id: roomId, captureId } });
      if (!existing) return notFound(reply, 'Room');
      const body = z
        .object({
          name: z.string().min(1).max(100).optional(),
          sortOrder: z.number().int().min(0).optional(),
          ceilingHeightM: z.number().positive().max(20).nullable().optional(),
          floorPolygon: z.array(z.tuple([z.number(), z.number()])).min(3).nullable().optional(),
          measurements: z.union([z.record(z.unknown()), z.array(z.record(z.unknown()))]).nullable().optional(),
          openings: z.array(z.record(z.unknown())).nullable().optional(),
          roomPlacement: z.record(z.unknown()).nullable().optional(),
          roomModel: z.record(z.unknown()).nullable().optional(),
          panoramaAssetId: z.string().nullable().optional()
        })
        .parse(request.body);
      const existingModel = existing.roomModel && typeof existing.roomModel === 'object' && !Array.isArray(existing.roomModel)
        ? existing.roomModel as Record<string, unknown>
        : {};
      const mergedRoomModel = body.roomModel === null
        ? undefined
        : body.roomModel
          ? body.roomModel
          : (body.openings !== undefined || body.roomPlacement !== undefined)
            ? {
                ...existingModel,
                ...(body.openings === null ? {} : body.openings !== undefined ? { mobileOpenings: body.openings } : {}),
                ...(body.roomPlacement === null ? {} : body.roomPlacement !== undefined ? { roomPlacement: body.roomPlacement } : {})
              }
            : undefined;
      const room = await prisma.room.update({
        where: { id: roomId },
        data: {
          name: body.name,
          sortOrder: body.sortOrder,
          ceilingHeightM: body.ceilingHeightM,
          floorPolygon: body.floorPolygon === null ? undefined : body.floorPolygon ? asJson(body.floorPolygon) : undefined,
          measurements: body.measurements === null ? undefined : body.measurements ? asJson(body.measurements) : undefined,
          roomModel: mergedRoomModel ? asJson(mergedRoomModel) : undefined,
          panoramaAssetId: body.panoramaAssetId
        }
      });
      return reply.send(room);
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.post('/v1/captures/:captureId/connections', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { captureId } = request.params as { captureId: string };
      const capture = await getCaptureForOrganization(captureId, request.user.organizationId);
      if (!capture) return notFound(reply, 'Capture');
      const body = z
        .object({ fromRoomId: z.string(), toRoomId: z.string(), label: z.string().max(100).optional() })
        .refine((value) => value.fromRoomId !== value.toRoomId, 'Rooms must differ')
        .parse(request.body);
      const rooms = await prisma.room.count({
        where: { id: { in: [body.fromRoomId, body.toRoomId] }, captureId }
      });
      if (rooms !== 2) return reply.code(400).send({ error: 'ROOMS_NOT_IN_CAPTURE' });
      const connection = await prisma.captureConnection.upsert({
        where: { captureId_fromRoomId_toRoomId: { captureId, fromRoomId: body.fromRoomId, toRoomId: body.toRoomId } },
        update: { label: body.label },
        create: { captureId, fromRoomId: body.fromRoomId, toRoomId: body.toRoomId, label: body.label }
      });
      return reply.code(201).send(connection);
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.post('/v1/captures/:captureId/assets/upload-url', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { captureId } = request.params as { captureId: string };
      const capture = await getCaptureForOrganization(captureId, request.user.organizationId);
      if (!capture) return notFound(reply, 'Capture');
      const body = z
        .object({
          roomId: z.string().optional(),
          kind: z.enum([
            'PANORAMA', 'PHOTO', 'VIDEO', 'THUMBNAIL', 'AR_POSES', 'CAMERA_INTRINSICS', 'DEPTH_MAP',
            'DEPTH_CONFIDENCE', 'ROOMPLAN_USDZ', 'FLOORPLAN', 'GLB', 'DESIGN_PREVIEW', 'RGB_KEYFRAME', 'AR_PLANES', 'CAPTURE_MANIFEST', 'MODEL_EVIDENCE', 'FLOORPLAN_SVG', 'DESIGN_RENDER', 'DESIGN_EXPORT', 'OTHER'
          ]),
          filename: z.string().min(1).max(255),
          mimeType: z.string().min(3).max(150),
          sizeBytes: z.number().int().positive().max(8 * 1024 * 1024 * 1024)
        })
        .parse(request.body);
      if (body.roomId) {
        const room = await prisma.room.findFirst({ where: { id: body.roomId, captureId } });
        if (!room) return notFound(reply, 'Room');
      }
      const objectKey = `org/${request.user.organizationId}/capture/${captureId}/${nanoid(12)}-${safeObjectName(body.filename)}`;
      const asset = await prisma.asset.create({
        data: {
          captureId,
          roomId: body.roomId,
          kind: body.kind,
          objectKey,
          mimeType: body.mimeType,
          sizeBytes: BigInt(body.sizeBytes),
          status: 'PENDING',
          metadata: asJson({ originalFilename: body.filename })
        }
      });
      const uploadUrl = await minioSigner.presignedPutObject(config.MINIO_BUCKET_PRIVATE, objectKey, 60 * 60);
      return reply.code(201).send({ assetId: asset.id, objectKey, uploadUrl, expiresInSeconds: 3600 });
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.post('/v1/captures/:captureId/assets/:assetId/complete', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { captureId, assetId } = request.params as { captureId: string; assetId: string };
      const capture = await getCaptureForOrganization(captureId, request.user.organizationId);
      if (!capture) return notFound(reply, 'Capture');
      const asset = await prisma.asset.findFirst({ where: { id: assetId, captureId } });
      if (!asset) return notFound(reply, 'Asset');
      const body = z.object({ checksumSha256: z.string().length(64).optional() }).parse(request.body ?? {});
      try {
        await minio.statObject(config.MINIO_BUCKET_PRIVATE, asset.objectKey);
      } catch {
        return reply.code(400).send({ error: 'OBJECT_NOT_UPLOADED' });
      }
      const updated = await prisma.asset.update({
        where: { id: asset.id },
        data: { status: 'UPLOADED', checksumSha256: body.checksumSha256 }
      });

      const originalFilename = String(((asset.metadata ?? {}) as Record<string, unknown>).originalFilename ?? '');
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
          data: { type: 'PANORAMA_QA', assetId: asset.id, captureId, status: 'QUEUED' }
        });
        await visionQueue.add('PANORAMA_QA', { jobId: job.id }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
      }
      return reply.send(updated);
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  /**
   * Signed GET for any capture asset the caller's organisation owns.
   *
   * Designer Studio needs this to display Mode A panoramas: without it the
   * stitched equirectangular JPEGs sit in private object storage with no way for
   * an authenticated browser to read them. Scoped by organisation and short
   * lived, the same way export downloads work.
   */
  app.get('/v1/captures/:captureId/assets/:assetId/download-url', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { captureId, assetId } = request.params as { captureId: string; assetId: string };
    const capture = await getCaptureForOrganization(captureId, request.user.organizationId);
    if (!capture) return reply.code(404).send({ error: 'CAPTURE_NOT_FOUND' });
    const asset = await prisma.asset.findFirst({ where: { id: assetId, captureId } });
    if (!asset || !asset.objectKey) return reply.code(404).send({ error: 'ASSET_NOT_FOUND' });
    const url = await minioSigner.presignedGetObject(config.MINIO_BUCKET_PRIVATE, asset.objectKey, 30 * 60);
    return reply.send({ url, expiresInSeconds: 1800, kind: asset.kind, mimeType: asset.mimeType ?? null, roomId: asset.roomId ?? null });
  });

  /**
   * Every finished Mode A panorama in the organisation, newest first.
   *
   * Powers the Studio "360 library": a designer browses all captured panoramas
   * across properties and attaches one to a room of a design project.
   */
  app.get('/v1/panoramas', { preHandler: [app.authenticate] }, async (request) => {
    const assets = await prisma.asset.findMany({
      where: {
        kind: 'PANORAMA',
        status: { in: ['UPLOADED', 'APPROVED'] },
        capture: { unit: { property: { organizationId: request.user.organizationId } } }
      },
      include: { room: true, capture: { include: { unit: { include: { property: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 200
    });
    return assets.map((asset) => {
      const meta = (asset.metadata ?? {}) as { qa?: { qualityScore?: number }; qualityScore?: number };
      return {
        assetId: asset.id,
        captureId: asset.captureId,
        roomId: asset.roomId ?? null,
        roomName: asset.room?.name ?? null,
        propertyName: asset.capture?.unit?.property?.name ?? null,
        unitLabel: asset.capture?.unit?.label ?? null,
        status: asset.status,
        mimeType: asset.mimeType,
        qaScore: meta.qa?.qualityScore ?? meta.qualityScore ?? null,
        createdAt: asset.createdAt
      };
    });
  });

  app.post('/v1/captures/:captureId/assets/:assetId/privacy-scan', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { captureId, assetId } = request.params as { captureId: string; assetId: string };
    const capture = await getCaptureForOrganization(captureId, request.user.organizationId);
    if (!capture) return notFound(reply, 'Capture');
    const asset = await prisma.asset.findFirst({ where: { id: assetId, captureId, status: { in: ['UPLOADED', 'APPROVED'] } } });
    if (!asset) return notFound(reply, 'Asset');
    const job = await prisma.processingJob.create({
      data: { type: 'PRIVACY_SCAN', assetId, captureId, status: 'QUEUED' }
    });
    await visionQueue.add('PRIVACY_SCAN', { jobId: job.id }, { attempts: 2, backoff: { type: 'exponential', delay: 5000 } });
    return reply.code(202).send({ jobId: job.id });
  });

  app.post('/v1/captures/:captureId/rooms/:roomId/stitch-panorama', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { captureId, roomId } = request.params as { captureId: string; roomId: string };
      const capture = await getCaptureForOrganization(captureId, request.user.organizationId);
      if (!capture) return notFound(reply, 'Capture');
      const room = await prisma.room.findFirst({ where: { id: roomId, captureId } });
      if (!room) return notFound(reply, 'Room');
      const body = z.object({
        assetIds: z.array(z.string()).min(3).max(80),
        capturePattern: z.enum([
          'QUICK_CENTRAL_RING',
          'FULL_TWO_RINGS_WITH_CAPS',
          'LEGACY_GUIDED'
        ]).default('LEGACY_GUIDED'),
        frames: z.array(z.object({
          assetId: z.string(),
          fileName: z.string().min(1).max(255),
          targetYawDegrees: z.number().min(-720).max(720),
          targetPitchDegrees: z.number().min(-90).max(90),
          measuredYawDegrees: z.number().min(-720).max(720),
          measuredPitchDegrees: z.number().min(-90).max(90),
          measuredRollDegrees: z.number().min(-180).max(180),
          capturedAtEpochMs: z.number().int().positive()
        })).optional(),
        horizontalFovDegrees: z.number().min(30).max(110).optional(),
        verticalFovDegrees: z.number().min(40).max(130).optional(),
        minPitchDegrees: z.number().min(-90).max(90).optional(),
        maxPitchDegrees: z.number().min(-90).max(90).optional(),
        manifestAssetId: z.string().optional()
      }).parse(request.body);

      const expectedRange = body.capturePattern === 'QUICK_CENTRAL_RING'
        ? { min: 8, max: 12 }
        : body.capturePattern === 'FULL_TWO_RINGS_WITH_CAPS'
          ? { min: 18, max: 24 }
          : { min: 3, max: 80 };
      if (body.assetIds.length < expectedRange.min || body.assetIds.length > expectedRange.max) {
        return reply.code(400).send({
          error: 'INVALID_FRAME_COUNT_FOR_CAPTURE_PATTERN',
          capturePattern: body.capturePattern,
          expected: expectedRange,
          received: body.assetIds.length
        });
      }
      if (body.frames) {
        const frameAssetIds = body.frames.map((frame) => frame.assetId);
        const uniqueFrameIds = new Set(frameAssetIds);
        if (
          body.frames.length !== body.assetIds.length ||
          uniqueFrameIds.size !== body.assetIds.length ||
          body.assetIds.some((assetId) => !uniqueFrameIds.has(assetId))
        ) {
          return reply.code(400).send({ error: 'FRAME_METADATA_DOES_NOT_MATCH_ASSETS' });
        }
      }
      if (
        body.minPitchDegrees !== undefined &&
        body.maxPitchDegrees !== undefined &&
        body.minPitchDegrees >= body.maxPitchDegrees
      ) {
        return reply.code(400).send({ error: 'INVALID_PITCH_LIMITS' });
      }

      const assets = await prisma.asset.findMany({
        where: { id: { in: body.assetIds }, captureId, roomId, kind: 'PHOTO', status: { in: ['UPLOADED', 'APPROVED'] } }
      });
      if (assets.length !== body.assetIds.length) {
        return reply.code(400).send({ error: 'INVALID_STITCH_INPUT_ASSETS' });
      }
      if (body.manifestAssetId) {
        const manifest = await prisma.asset.findFirst({
          where: {
            id: body.manifestAssetId,
            captureId,
            roomId,
            kind: 'OTHER',
            status: { in: ['UPLOADED', 'APPROVED'] }
          }
        });
        if (!manifest) return reply.code(400).send({ error: 'INVALID_CAPTURE_MANIFEST_ASSET' });
      }
      const job = await prisma.processingJob.create({
        data: {
          type: 'PANORAMA_STITCH',
          captureId,
          status: 'QUEUED',
          input: asJson({ roomId, ...body })
        }
      });
      await visionQueue.add('PANORAMA_STITCH', { jobId: job.id }, { attempts: 2, backoff: { type: 'exponential', delay: 5000 } });
      return reply.code(202).send({ jobId: job.id });
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.post('/v1/captures/:captureId/submit', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { captureId } = request.params as { captureId: string };
    const capture = await getCaptureForOrganization(captureId, request.user.organizationId);
    if (!capture) return notFound(reply, 'Capture');
    const unfinishedPanoramas = await prisma.asset.count({
      where: { captureId, kind: 'PANORAMA', status: { in: ['PENDING', 'UPLOADED', 'PROCESSING'] } }
    });
    if (unfinishedPanoramas > 0) {
      return reply.code(409).send({ error: 'PANORAMA_QA_STILL_RUNNING', unfinishedPanoramas });
    }
    const job = await prisma.processingJob.create({
      data: { type: 'CAPTURE_VALIDATION', captureId, status: 'QUEUED' }
    });
    await prisma.captureSession.update({ where: { id: captureId }, data: { status: 'PROCESSING', completedAt: new Date() } });
    await visionQueue.add('CAPTURE_VALIDATION', { jobId: job.id }, { attempts: 2, backoff: { type: 'exponential', delay: 5000 } });
    return reply.code(202).send({ jobId: job.id, status: job.status });
  });
}
