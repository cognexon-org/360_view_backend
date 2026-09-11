import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getCaptureForOrganization, getProgressProjectForOrganization, getUnitForOrganization } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { asJson } from '../lib/json.js';
import { badRequest, notFound } from '../lib/http.js';
import { minioSigner } from '../lib/minio.js';
import { config } from '../config.js';
import { callRegistrationService } from '../lib/vision-client.js';
import { buildEvidenceInventoryDiff } from '../lib/progress-comparison.js';
import { buildDesignRealityDeviationReport, parsePolygon } from '../lib/design-reality-deviation.js';
import { buildProgressReport } from '../lib/progress-report.js';
import { visionQueue } from '../lib/queue.js';

const captureMode = z.enum(['PROPERTY_TOUR', 'DESIGN_SCAN']);
const capturePlatform = z.enum(['ANDROID', 'IOS', 'WEB']);

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function compactJson(value: Record<string, unknown>) {
  return asJson(JSON.parse(JSON.stringify(value)));
}

function projectInclude() {
  return {
    unit: { include: { property: true } },
    floors: { orderBy: [{ level: 'asc' as const }, { createdAt: 'asc' as const }] },
    rooms: { orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }] },
    snapshots: {
      orderBy: { capturedAt: 'desc' as const },
      take: 50,
      include: {
        capture: {
          include: {
            rooms: { orderBy: { sortOrder: 'asc' as const }, include: { spatialRoom: true } },
            assets: {
              select: {
                id: true, roomId: true, spatialRoomId: true, kind: true, mimeType: true,
                status: true, sizeBytes: true, metadata: true, quality: true, createdAt: true
              }
            },
            resumableUploads: {
              select: {
                id: true, roomId: true, assetId: true, filename: true, kind: true, status: true,
                uploadedBytes: true, totalSizeBytes: true, totalParts: true, completedAt: true, updatedAt: true
              },
              orderBy: { createdAt: 'desc' as const },
              take: 20
            },
            designProjects: {
              select: { id: true, name: true, status: true, slug: true, activeVersion: true, updatedAt: true }
            }
          }
        }
      }
    },
    registrations: { orderBy: { createdAt: 'desc' as const }, take: 50 },
    designRealityAlignments: {
      orderBy: { updatedAt: 'desc' as const }, take: 50,
      include: { evaluations: { orderBy: { createdAt: 'desc' as const }, take: 3 } }
    },
    issues: {
      orderBy: { updatedAt: 'desc' as const }, take: 100,
      include: { events: { orderBy: { createdAt: 'desc' as const }, take: 50 } }
    },
    observations: {
      orderBy: { createdAt: 'desc' as const }, take: 100,
      include: { decisions: { orderBy: { createdAt: 'desc' as const }, take: 20 } }
    },
    analysisRuns: {
      orderBy: { createdAt: 'desc' as const }, take: 25,
      include: { observations: { orderBy: { createdAt: 'asc' as const }, include: { decisions: { orderBy: { createdAt: 'desc' as const }, take: 20 } } } }
    },
    reports: { orderBy: { createdAt: 'desc' as const }, take: 25 }
  };
}

export async function progressRoutes(app: FastifyInstance) {
  app.get('/v2/progress-projects', { preHandler: [app.authenticate] }, async (request) => {
    return prisma.progressProject.findMany({
      where: { unit: { property: { organizationId: request.user.organizationId } } },
      include: {
        unit: { include: { property: true } },
        floors: { orderBy: [{ level: 'asc' }, { createdAt: 'asc' }] },
        rooms: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
        _count: { select: { snapshots: true, issues: true, observations: true, analysisRuns: true } }
      },
      orderBy: { updatedAt: 'desc' }
    });
  });

  app.post('/v2/progress-projects', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const body = z.object({
        unitId: z.string().min(1),
        name: z.string().min(2).max(160),
        captureCadence: z.string().max(50).optional(),
        projectFrame: z.record(z.unknown()).optional(),
        progressPolicy: z.record(z.unknown()).optional(),
        defaultFloorName: z.string().min(1).max(100).default('Ground / Default')
      }).parse(request.body);
      const unit = await getUnitForOrganization(body.unitId, request.user.organizationId);
      if (!unit) return notFound(reply, 'Unit');

      const project = await prisma.$transaction(async (tx) => {
        const created = await tx.progressProject.create({
          data: {
            unitId: unit.id,
            name: body.name,
            captureCadence: body.captureCadence,
            projectFrame: body.projectFrame ? asJson(body.projectFrame) : undefined,
            progressPolicy: body.progressPolicy ? asJson(body.progressPolicy) : undefined,
            createdById: request.user.userId
          }
        });
        await tx.spatialFloor.create({
          data: { projectId: created.id, name: body.defaultFloorName, level: 0, elevationM: 0 }
        });
        return created;
      });
      await audit({
        organizationId: request.user.organizationId,
        actorId: request.user.userId,
        entityType: 'ProgressProject', entityId: project.id, action: 'CREATE',
        payload: { unitId: unit.id }
      });
      const hydrated = await prisma.progressProject.findUnique({ where: { id: project.id }, include: projectInclude() });
      return reply.code(201).send(hydrated);
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.get('/v2/progress-projects/:projectId', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await prisma.progressProject.findFirst({
      where: { id: projectId, unit: { property: { organizationId: request.user.organizationId } } },
      include: projectInclude()
    });
    return project ? reply.send(project) : notFound(reply, 'Progress project');
  });

  app.post('/v2/progress-projects/:projectId/floors', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const project = await getProgressProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Progress project');
      const body = z.object({
        name: z.string().min(1).max(100), level: z.number().int().optional(), elevationM: z.number().optional(),
        transform: z.record(z.unknown()).optional()
      }).parse(request.body);
      const floor = await prisma.spatialFloor.create({
        data: { projectId, name: body.name, level: body.level, elevationM: body.elevationM, transform: body.transform ? asJson(body.transform) : undefined }
      });
      await prisma.progressProject.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
      return reply.code(201).send(floor);
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.post('/v2/progress-projects/:projectId/rooms', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const project = await getProgressProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Progress project');
      const body = z.object({
        floorId: z.string().optional(), name: z.string().min(1).max(100), roomType: z.string().max(80).optional(),
        sortOrder: z.number().int().min(0).default(0), canonicalFrame: z.record(z.unknown()).optional(),
        canonicalGeometry: z.record(z.unknown()).optional(), reuseByName: z.boolean().default(true)
      }).parse(request.body);
      if (body.floorId) {
        const floor = await prisma.spatialFloor.findFirst({ where: { id: body.floorId, projectId } });
        if (!floor) return notFound(reply, 'Floor');
      }
      if (body.reuseByName) {
        const existing = await prisma.spatialRoom.findFirst({
          where: { projectId, floorId: body.floorId ?? null, name: body.name }
        });
        if (existing) return reply.send(existing);
      }
      const room = await prisma.spatialRoom.create({
        data: {
          projectId, floorId: body.floorId, name: body.name, roomType: body.roomType, sortOrder: body.sortOrder,
          canonicalFrame: body.canonicalFrame ? asJson(body.canonicalFrame) : undefined,
          canonicalGeometry: body.canonicalGeometry ? asJson(body.canonicalGeometry) : undefined
        }
      });
      await prisma.progressProject.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
      return reply.code(201).send(room);
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.post('/v2/progress-projects/:projectId/captures', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const project = await getProgressProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Progress project');
      const body = z.object({
        mode: captureMode,
        platform: capturePlatform,
        floorId: z.string().optional(),
        capturedAt: z.string().datetime({ offset: true }).optional(),
        deviceMetadata: z.record(z.unknown()).optional(),
        checklist: z.record(z.unknown()).optional(),
        spatialScope: z.record(z.unknown()).optional(),
        designReferenceProjectId: z.string().optional(),
        designReferenceVersion: z.number().int().positive().optional()
      }).parse(request.body);
      if (body.floorId) {
        const floor = await prisma.spatialFloor.findFirst({ where: { id: body.floorId, projectId } });
        if (!floor) return notFound(reply, 'Floor');
      }
      if (body.designReferenceProjectId) {
        const designReference = await prisma.designProject.findFirst({
          where: { id: body.designReferenceProjectId, unitId: project.unitId },
          include: { versions: { where: body.designReferenceVersion ? { version: body.designReferenceVersion } : undefined, take: 1 } }
        });
        if (!designReference) return reply.code(400).send({ error: 'DESIGN_REFERENCE_NOT_IN_PROJECT_UNIT' });
        const requestedVersion = body.designReferenceVersion ?? designReference.activeVersion;
        if (requestedVersion !== designReference.activeVersion && designReference.versions.length === 0) {
          const exists = await prisma.designVersion.count({ where: { projectId: designReference.id, version: requestedVersion } });
          if (!exists) return reply.code(400).send({ error: 'DESIGN_REFERENCE_VERSION_NOT_FOUND' });
        }
        body.designReferenceVersion = requestedVersion;
      }
      const capturedAt = body.capturedAt ? new Date(body.capturedAt) : new Date();
      const result = await prisma.$transaction(async (tx) => {
        const capture = await tx.captureSession.create({
          data: {
            unitId: project.unitId,
            createdById: request.user.userId,
            mode: body.mode,
            platform: body.platform,
            status: 'CAPTURING', startedAt: capturedAt,
            deviceMetadata: body.deviceMetadata ? asJson(body.deviceMetadata) : undefined,
            checklist: body.checklist ? asJson(body.checklist) : undefined
          }
        });
        const snapshot = await tx.captureSnapshot.create({
          data: {
            projectId, captureId: capture.id, floorId: body.floorId, capturedAt,
            sourceType: body.mode,
            designReferenceProjectId: body.designReferenceProjectId,
            designReferenceVersion: body.designReferenceVersion,
            spatialScope: body.spatialScope ? asJson(body.spatialScope) : body.floorId ? asJson({ floorId: body.floorId }) : undefined
          }
        });
        await tx.progressProject.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
        return { capture, snapshot };
      });
      await audit({
        organizationId: request.user.organizationId,
        actorId: request.user.userId,
        entityType: 'CaptureSnapshot', entityId: result.snapshot.id, action: 'CREATE',
        payload: { projectId, captureId: result.capture.id, mode: body.mode, designReferenceProjectId: body.designReferenceProjectId ?? null, designReferenceVersion: body.designReferenceVersion ?? null }
      });
      return reply.code(201).send(result);
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.post('/v2/progress-captures/:captureId/quality-feedback', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { captureId } = request.params as { captureId: string };
      const capture = await prisma.captureSession.findFirst({
        where: { id: captureId, unit: { property: { organizationId: request.user.organizationId } } },
        include: { snapshot: true }
      });
      if (!capture) return notFound(reply, 'Capture');
      const body = z.object({
        scope: z.enum(['PREFLIGHT', 'ROOM', 'CAPTURE']).default('CAPTURE'),
        spatialRoomId: z.string().optional(),
        report: z.record(z.unknown()),
        deviceTelemetry: z.record(z.unknown()).optional()
      }).parse(request.body);

      if (body.scope === 'ROOM') {
        if (!body.spatialRoomId) return reply.code(400).send({ error: 'SPATIAL_ROOM_REQUIRED' });
        if (!capture.snapshot) return reply.code(409).send({ error: 'CAPTURE_NOT_LINKED_TO_PROGRESS_PROJECT' });
        const room = await prisma.spatialRoom.findFirst({ where: { id: body.spatialRoomId, projectId: capture.snapshot.projectId } });
        if (!room) return notFound(reply, 'Spatial room');
      }

      const existingQuality = jsonObject(capture.qualityReport);
      let qualityReport: Record<string, unknown>;
      if (body.scope === 'PREFLIGHT') {
        qualityReport = { ...existingQuality, preflight: body.report };
      } else if (body.scope === 'ROOM' && body.spatialRoomId) {
        const rooms = jsonObject(existingQuality.rooms);
        qualityReport = { ...existingQuality, rooms: { ...rooms, [body.spatialRoomId]: body.report } };
      } else {
        qualityReport = { ...existingQuality, capture: body.report };
      }
      const deviceMetadata = body.deviceTelemetry
        ? { ...jsonObject(capture.deviceMetadata), ...body.deviceTelemetry }
        : undefined;

      await prisma.$transaction(async (tx) => {
        await tx.captureSession.update({
          where: { id: captureId },
          data: {
            qualityReport: asJson(qualityReport),
            deviceMetadata: deviceMetadata ? asJson(deviceMetadata) : undefined
          }
        });
        if (capture.snapshot) {
          await tx.captureSnapshot.update({
            where: { id: capture.snapshot.id },
            data: { qualityReport: asJson(qualityReport) }
          });
        }
      });
      await audit({
        organizationId: request.user.organizationId, actorId: request.user.userId,
        entityType: 'CaptureSession', entityId: captureId, action: 'QUALITY_FEEDBACK',
        payload: { scope: body.scope, spatialRoomId: body.spatialRoomId ?? null }
      });
      return reply.send({ captureId, qualityReport });
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.post('/v2/progress-projects/:projectId/captures/:captureId/link', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId, captureId } = request.params as { projectId: string; captureId: string };
      const project = await getProgressProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Progress project');
      const capture = await getCaptureForOrganization(captureId, request.user.organizationId);
      if (!capture || capture.unitId !== project.unitId) return notFound(reply, 'Capture');
      const body = z.object({ floorId: z.string().optional(), capturedAt: z.string().datetime({ offset: true }).optional() }).parse(request.body ?? {});
      if (body.floorId) {
        const floor = await prisma.spatialFloor.findFirst({ where: { id: body.floorId, projectId } });
        if (!floor) return notFound(reply, 'Floor');
      }
      const existingSnapshot = await prisma.captureSnapshot.findUnique({ where: { captureId } });
      if (existingSnapshot && existingSnapshot.projectId !== projectId) {
        return reply.code(409).send({ error: 'CAPTURE_ALREADY_LINKED_TO_ANOTHER_PROJECT' });
      }
      const snapshot = await prisma.captureSnapshot.upsert({
        where: { captureId },
        create: {
          projectId, captureId, floorId: body.floorId,
          capturedAt: body.capturedAt ? new Date(body.capturedAt) : capture.startedAt ?? capture.createdAt,
          sourceType: capture.mode, status: capture.status
        },
        update: { floorId: body.floorId, sourceType: capture.mode, status: capture.status }
      });
      return reply.send(snapshot);
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.get('/v2/progress-projects/:projectId/timeline', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const project = await getProgressProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Progress project');
      const query = z.object({
        floorId: z.string().optional(), spatialRoomId: z.string().optional(), sourceType: captureMode.optional(),
        from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100)
      }).parse(request.query ?? {});
      return prisma.captureSnapshot.findMany({
        where: {
          projectId,
          ...(query.floorId ? { floorId: query.floorId } : {}),
          ...(query.sourceType ? { sourceType: query.sourceType } : {}),
          ...((query.from || query.to) ? { capturedAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } } : {}),
          ...(query.spatialRoomId ? { capture: { rooms: { some: { spatialRoomId: query.spatialRoomId } } } } : {})
        },
        orderBy: { capturedAt: 'desc' },
        take: query.limit,
        include: {
          floor: true,
          capture: { include: {
            rooms: { orderBy: { sortOrder: 'asc' }, include: { spatialRoom: true } },
            assets: { select: { id: true, roomId: true, spatialRoomId: true, kind: true, status: true, metadata: true, quality: true, createdAt: true } },
            resumableUploads: { select: { id: true, roomId: true, assetId: true, filename: true, kind: true, status: true, uploadedBytes: true, totalSizeBytes: true, totalParts: true, completedAt: true, updatedAt: true }, orderBy: { createdAt: 'desc' }, take: 20 },
            jobs: { orderBy: { createdAt: 'desc' }, take: 5 },
            designProjects: { select: { id: true, name: true, status: true, slug: true, activeVersion: true, updatedAt: true } }
          } }
        }
      });
    } catch (error) { return badRequest(reply, error); }
  });

  app.get('/v2/progress-snapshots/:snapshotId/viewer-manifest', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { snapshotId } = request.params as { snapshotId: string };
    const snapshot = await prisma.captureSnapshot.findFirst({
      where: { id: snapshotId, project: { unit: { property: { organizationId: request.user.organizationId } } } },
      include: { capture: { include: { rooms: { include: { spatialRoom: true } }, assets: true } }, floor: true }
    });
    if (!snapshot) return notFound(reply, 'Capture snapshot');
    const panoramas = new Map(snapshot.capture.assets.filter((asset) => asset.kind === 'PANORAMA' && asset.status === 'APPROVED').map((asset) => [asset.id, asset]));
    const rooms = await Promise.all(snapshot.capture.rooms.map(async (room) => {
      const panorama = room.panoramaAssetId ? panoramas.get(room.panoramaAssetId) : undefined;
      return {
        captureRoomId: room.id, spatialRoomId: room.spatialRoomId, name: room.spatialRoom?.name ?? room.name,
        panoramaAssetId: panorama?.id ?? null,
        panoramaUrl: panorama ? await minioSigner.presignedGetObject(config.MINIO_BUCKET_PRIVATE, panorama.objectKey, 15 * 60) : null
      };
    }));
    return reply.send({ snapshotId: snapshot.id, projectId: snapshot.projectId, capturedAt: snapshot.capturedAt, sourceType: snapshot.sourceType, floor: snapshot.floor, expiresInSeconds: 900, rooms });
  });

  app.get('/v2/progress-projects/:projectId/compare', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const project = await getProgressProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Progress project');
      const query = z.object({ sourceSnapshotId: z.string(), targetSnapshotId: z.string(), spatialRoomId: z.string().optional() }).parse(request.query);
      const snapshots = await prisma.captureSnapshot.findMany({
        where: { id: { in: [query.sourceSnapshotId, query.targetSnapshotId] }, projectId },
        include: { capture: { include: { rooms: true, assets: true } } }
      });
      if (snapshots.length !== 2) return reply.code(400).send({ error: 'SNAPSHOT_NOT_IN_PROJECT' });
      const source = snapshots.find((item) => item.id === query.sourceSnapshotId)!;
      const target = snapshots.find((item) => item.id === query.targetSnapshotId)!;
      const registration = await prisma.captureRegistration.findFirst({
        where: { projectId, OR: [{ sourceSnapshotId: source.id, targetSnapshotId: target.id }, { sourceSnapshotId: target.id, targetSnapshotId: source.id }] },
        orderBy: { updatedAt: 'desc' }
      });
      return reply.send({ diff: buildEvidenceInventoryDiff(source, target, query.spatialRoomId), registration });
    } catch (error) { return badRequest(reply, error); }
  });

  app.post('/v2/progress-projects/:projectId/registrations/assist', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const project = await getProgressProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Progress project');
      const anchor = z.object({ source: z.tuple([z.number(), z.number(), z.number()]), target: z.tuple([z.number(), z.number(), z.number()]) });
      const body = z.object({
        sourceSnapshotId: z.string(), targetSnapshotId: z.string(), anchors: z.array(anchor).min(1).max(50),
        overlap: z.number().min(0).max(1).optional(), version: z.string().min(1).max(50).default('anchor-v1')
      }).refine((value) => value.sourceSnapshotId !== value.targetSnapshotId, 'Snapshots must differ').parse(request.body);
      const count = await prisma.captureSnapshot.count({ where: { id: { in: [body.sourceSnapshotId, body.targetSnapshotId] }, projectId } });
      if (count !== 2) return reply.code(400).send({ error: 'SNAPSHOT_NOT_IN_PROJECT' });
      const estimated = await callRegistrationService({ anchors: body.anchors, overlap: body.overlap });
      const registration = await prisma.captureRegistration.upsert({
        where: { sourceSnapshotId_targetSnapshotId_version: { sourceSnapshotId: body.sourceSnapshotId, targetSnapshotId: body.targetSnapshotId, version: body.version } },
        create: { projectId, sourceSnapshotId: body.sourceSnapshotId, targetSnapshotId: body.targetSnapshotId, transform: asJson({ ...estimated.transform, diagnostics: estimated.diagnostics }), overlap: estimated.overlap, confidence: estimated.confidence, method: estimated.method, version: body.version, status: 'PROPOSED' },
        update: { transform: asJson({ ...estimated.transform, diagnostics: estimated.diagnostics }), overlap: estimated.overlap, confidence: estimated.confidence, method: estimated.method, status: 'PROPOSED', verifiedById: null }
      });
      await audit({ organizationId: request.user.organizationId, actorId: request.user.userId, entityType: 'CaptureRegistration', entityId: registration.id, action: 'ASSISTED_REGISTRATION', payload: { anchorCount: body.anchors.length, confidence: estimated.confidence } });
      return reply.code(201).send(registration);
    } catch (error) { return badRequest(reply, error); }
  });

  app.post('/v2/progress-registrations/:registrationId/decision', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { registrationId } = request.params as { registrationId: string };
      const registration = await prisma.captureRegistration.findFirst({ where: { id: registrationId, project: { unit: { property: { organizationId: request.user.organizationId } } } } });
      if (!registration) return notFound(reply, 'Capture registration');
      const body = z.object({ decision: z.enum(['VERIFIED', 'REJECTED']) }).parse(request.body);
      const updated = await prisma.captureRegistration.update({ where: { id: registrationId }, data: { status: body.decision, verifiedById: body.decision === 'VERIFIED' ? request.user.userId : null } });
      await audit({ organizationId: request.user.organizationId, actorId: request.user.userId, entityType: 'CaptureRegistration', entityId: registrationId, action: body.decision, payload: {} });
      return reply.send(updated);
    } catch (error) { return badRequest(reply, error); }
  });

  app.post('/v2/progress-projects/:projectId/registrations', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const project = await getProgressProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Progress project');
      const body = z.object({
        sourceSnapshotId: z.string(), targetSnapshotId: z.string(), transform: z.record(z.unknown()), overlap: z.number().min(0).max(1).optional(),
        confidence: z.number().min(0).max(1), method: z.string().min(1).max(100), version: z.string().min(1).max(50), status: z.string().max(50).default('PROPOSED')
      }).refine((value) => value.sourceSnapshotId !== value.targetSnapshotId, 'Snapshots must differ').parse(request.body);
      const count = await prisma.captureSnapshot.count({ where: { id: { in: [body.sourceSnapshotId, body.targetSnapshotId] }, projectId } });
      if (count !== 2) return reply.code(400).send({ error: 'SNAPSHOT_NOT_IN_PROJECT' });
      const registration = await prisma.captureRegistration.upsert({
        where: { sourceSnapshotId_targetSnapshotId_version: { sourceSnapshotId: body.sourceSnapshotId, targetSnapshotId: body.targetSnapshotId, version: body.version } },
        create: { projectId, ...body, transform: asJson(body.transform) },
        update: { transform: asJson(body.transform), overlap: body.overlap, confidence: body.confidence, method: body.method, status: body.status }
      });
      return reply.code(201).send(registration);
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.get('/v2/progress-projects/:projectId/design-intents', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await getProgressProjectForOrganization(projectId, request.user.organizationId);
    if (!project) return notFound(reply, 'Progress project');
    const rows = await prisma.designProject.findMany({
      where: { unitId: project.unitId },
      include: {
        versions: { orderBy: { version: 'desc' }, take: 20, select: { version: true, label: true, createdAt: true } },
        capture: { include: { rooms: { select: { id: true, name: true, spatialRoomId: true } } } }
      },
      orderBy: { updatedAt: 'desc' }
    });
    return reply.send(rows.map((row) => ({
      id: row.id, name: row.name, status: row.status, verificationStatus: row.verificationStatus,
      activeVersion: row.activeVersion, updatedAt: row.updatedAt,
      versions: row.versions,
      roomMappings: row.capture.rooms.filter((room) => room.spatialRoomId).map((room) => ({ captureRoomId: room.id, spatialRoomId: room.spatialRoomId, name: room.name }))
    })));
  });

  app.post('/v2/progress-projects/:projectId/design-reality-alignments/assist', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const project = await getProgressProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Progress project');
      const anchorSchema = z.object({ source: z.tuple([z.number(), z.number(), z.number()]), target: z.tuple([z.number(), z.number(), z.number()]) });
      const body = z.object({
        designProjectId: z.string(), designVersion: z.number().int().positive(), realitySnapshotId: z.string(), spatialRoomId: z.string(),
        anchors: z.array(anchorSchema).min(1).max(50), overlap: z.number().min(0).max(1).optional(), version: z.string().min(1).max(50).default('design-reality-anchor-v1')
      }).parse(request.body);
      const [designProject, realitySnapshot, spatialRoom] = await Promise.all([
        prisma.designProject.findFirst({ where: { id: body.designProjectId, unitId: project.unitId }, include: { capture: { include: { rooms: true } }, versions: { where: { version: body.designVersion }, take: 1 } } }),
        prisma.captureSnapshot.findFirst({ where: { id: body.realitySnapshotId, projectId }, include: { capture: { include: { rooms: true } } } }),
        prisma.spatialRoom.findFirst({ where: { id: body.spatialRoomId, projectId } })
      ]);
      if (!designProject || designProject.versions.length !== 1) return reply.code(400).send({ error: 'DESIGN_VERSION_NOT_IN_PROJECT_UNIT' });
      if (!realitySnapshot) return reply.code(400).send({ error: 'REALITY_SNAPSHOT_NOT_IN_PROJECT' });
      if (!spatialRoom) return reply.code(400).send({ error: 'SPATIAL_ROOM_NOT_IN_PROJECT' });
      if (!designProject.capture.rooms.some((room) => room.spatialRoomId === body.spatialRoomId)) return reply.code(409).send({ error: 'DESIGN_ROOM_NOT_LINKED_TO_SPATIAL_ROOM' });
      if (!realitySnapshot.capture.rooms.some((room) => room.spatialRoomId === body.spatialRoomId)) return reply.code(409).send({ error: 'REALITY_ROOM_NOT_LINKED_TO_SPATIAL_ROOM' });

      const estimated = await callRegistrationService({ anchors: body.anchors, overlap: body.overlap });
      const previous = await prisma.designRealityAlignment.findFirst({
        where: { projectId, designProjectId: body.designProjectId, designVersion: body.designVersion, realitySnapshotId: body.realitySnapshotId, spatialRoomId: body.spatialRoomId, version: body.version },
        orderBy: { updatedAt: 'desc' }
      });
      const data = {
        transform: asJson(estimated.transform), confidence: estimated.confidence, overlap: estimated.overlap,
        method: estimated.method, version: body.version, diagnostics: asJson(estimated.diagnostics), status: 'PROPOSED', verifiedById: null
      };
      const alignment = previous
        ? await prisma.designRealityAlignment.update({ where: { id: previous.id }, data })
        : await prisma.designRealityAlignment.create({ data: { projectId, designProjectId: body.designProjectId, designVersion: body.designVersion, realitySnapshotId: body.realitySnapshotId, spatialRoomId: body.spatialRoomId, ...data } });
      await audit({ organizationId: request.user.organizationId, actorId: request.user.userId, entityType: 'DesignRealityAlignment', entityId: alignment.id, action: 'ASSISTED_ALIGNMENT', payload: { anchorCount: body.anchors.length, confidence: estimated.confidence, designVersion: body.designVersion } });
      return reply.code(201).send(alignment);
    } catch (error) { return badRequest(reply, error); }
  });

  app.post('/v2/design-reality-alignments/:alignmentId/decision', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { alignmentId } = request.params as { alignmentId: string };
      const alignment = await prisma.designRealityAlignment.findFirst({ where: { id: alignmentId, project: { unit: { property: { organizationId: request.user.organizationId } } } } });
      if (!alignment) return notFound(reply, 'Design reality alignment');
      const body = z.object({ decision: z.enum(['VERIFIED', 'REJECTED']) }).parse(request.body);
      const updated = await prisma.designRealityAlignment.update({ where: { id: alignmentId }, data: { status: body.decision, verifiedById: body.decision === 'VERIFIED' ? request.user.userId : null } });
      await audit({ organizationId: request.user.organizationId, actorId: request.user.userId, entityType: 'DesignRealityAlignment', entityId: alignmentId, action: body.decision, payload: {} });
      return reply.send(updated);
    } catch (error) { return badRequest(reply, error); }
  });

  app.post('/v2/design-reality-alignments/:alignmentId/evaluate', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { alignmentId } = request.params as { alignmentId: string };
      const alignment = await prisma.designRealityAlignment.findFirst({
        where: { id: alignmentId, project: { unit: { property: { organizationId: request.user.organizationId } } } },
        include: {
          designProject: { include: { capture: { include: { rooms: true } }, versions: true } },
          realitySnapshot: { include: { capture: { include: { rooms: true } } } },
          spatialRoom: true
        }
      });
      if (!alignment) return notFound(reply, 'Design reality alignment');
      if (alignment.status !== 'VERIFIED') return reply.code(409).send({ error: 'ALIGNMENT_REQUIRES_HUMAN_VERIFICATION' });
      const body = z.object({ tolerances: z.object({ boundaryM: z.number().positive().max(1).optional(), areaRatio: z.number().positive().max(1).optional(), ceilingHeightM: z.number().positive().max(1).optional() }).optional() }).parse(request.body ?? {});
      const version = alignment.designProject.versions.find((row) => row.version === alignment.designVersion);
      if (!version) return reply.code(409).send({ error: 'DESIGN_VERSION_MISSING' });
      const model = jsonObject(version.model);
      const modelRooms = Array.isArray(model.rooms) ? model.rooms.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row)) : [];
      const designCaptureRoom = alignment.designProject.capture.rooms.find((room) => room.spatialRoomId === alignment.spatialRoomId);
      const realityRoom = alignment.realitySnapshot.capture.rooms.find((room) => room.spatialRoomId === alignment.spatialRoomId);
      if (!designCaptureRoom || !realityRoom) return reply.code(409).send({ error: 'SPATIAL_ROOM_MAPPING_MISSING' });
      const designRoomRaw = modelRooms.find((room) => String(room.id ?? '') === designCaptureRoom.id)
        ?? modelRooms.find((room) => String(room.name ?? '').toLowerCase() === designCaptureRoom.name.toLowerCase());
      if (!designRoomRaw) return reply.code(409).send({ error: 'DESIGN_MODEL_ROOM_NOT_FOUND' });
      const designPolygon = parsePolygon(designRoomRaw.floorPolygon);
      const realityPolygon = parsePolygon(realityRoom.floorPolygon);
      if (designPolygon.length < 3 || realityPolygon.length < 3) return reply.code(409).send({ error: 'GEOMETRY_REQUIRED_FOR_DEVIATION', designPolygonPoints: designPolygon.length, realityPolygonPoints: realityPolygon.length });
      const transform = jsonObject(alignment.transform);
      const report = buildDesignRealityDeviationReport({
        designRoom: { id: String(designRoomRaw.id ?? designCaptureRoom.id), name: String(designRoomRaw.name ?? designCaptureRoom.name), heightM: Number(designRoomRaw.heightM ?? 0) || undefined, floorPolygon: designPolygon },
        realityRoom: { id: realityRoom.id, name: realityRoom.name, ceilingHeightM: realityRoom.ceilingHeightM, floorPolygon: realityPolygon },
        transform,
        tolerances: body.tolerances,
        engineVersion: 'design-reality-v1'
      });
      const evaluation = await prisma.designRealityEvaluation.create({ data: { projectId: alignment.projectId, alignmentId: alignment.id, engineVersion: report.engineVersion, report: asJson(report), createdById: request.user.userId } });
      await audit({ organizationId: request.user.organizationId, actorId: request.user.userId, entityType: 'DesignRealityEvaluation', entityId: evaluation.id, action: 'EVALUATE', payload: { alignmentId, deviationCount: report.deviations.length } });
      return reply.code(201).send({ ...evaluation, report });
    } catch (error) { return badRequest(reply, error); }
  });

  app.post('/v2/progress-projects/:projectId/issues', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const project = await getProgressProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Progress project');
      const body = z.object({
        spatialRoomId: z.string().optional(), captureSnapshotId: z.string().optional(), spatialRef: z.record(z.unknown()).optional(),
        title: z.string().min(1).max(180), description: z.string().max(4000).optional(), severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('INFO'),
        assigneeId: z.string().optional(), dueAt: z.string().datetime().optional(), evidenceRefs: z.array(z.string()).max(50).optional()
      }).parse(request.body);
      if (body.spatialRoomId) {
        const room = await prisma.spatialRoom.findFirst({ where: { id: body.spatialRoomId, projectId } });
        if (!room) return notFound(reply, 'Spatial room');
      }
      if (body.captureSnapshotId) {
        const snapshot = await prisma.captureSnapshot.findFirst({ where: { id: body.captureSnapshotId, projectId } });
        if (!snapshot) return notFound(reply, 'Capture snapshot');
      }
      if (body.assigneeId) {
        const assignee = await prisma.user.findFirst({ where: { id: body.assigneeId, organizationId: request.user.organizationId } });
        if (!assignee) return reply.code(400).send({ error: 'ASSIGNEE_NOT_IN_ORGANIZATION' });
      }
      const issue = await prisma.$transaction(async (tx) => {
        const created = await tx.projectIssue.create({
          data: {
            projectId, spatialRoomId: body.spatialRoomId, captureSnapshotId: body.captureSnapshotId,
            spatialRef: body.spatialRef ? asJson(body.spatialRef) : undefined,
            title: body.title, description: body.description, severity: body.severity, assigneeId: body.assigneeId,
            dueAt: body.dueAt ? new Date(body.dueAt) : undefined,
            evidenceRefs: body.evidenceRefs ? asJson(body.evidenceRefs) : undefined, createdById: request.user.userId
          }
        });
        await tx.issueEvent.create({ data: { issueId: created.id, actorId: request.user.userId, eventType: 'CREATED', toStatus: created.status, payload: compactJson({ severity: created.severity, assigneeId: created.assigneeId }) } });
        await tx.progressProject.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
        return tx.projectIssue.findUniqueOrThrow({ where: { id: created.id }, include: { events: { orderBy: { createdAt: 'desc' } } } });
      });
      await audit({ organizationId: request.user.organizationId, actorId: request.user.userId, entityType: 'ProjectIssue', entityId: issue.id, action: 'CREATE', payload: { projectId, severity: issue.severity } });
      return reply.code(201).send(issue);
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.get('/v2/progress-projects/:projectId/analysis-runs', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const project = await getProgressProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Progress project');
      const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }).parse(request.query);
      return prisma.progressAnalysisRun.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        include: { observations: { orderBy: { createdAt: 'asc' }, include: { decisions: { orderBy: { createdAt: 'desc' } } } } }
      });
    } catch (error) { return badRequest(reply, error); }
  });

  app.get('/v2/progress-analysis-runs/:runId', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = await prisma.progressAnalysisRun.findFirst({
      where: { id: runId, project: { unit: { property: { organizationId: request.user.organizationId } } } },
      include: { observations: { orderBy: { createdAt: 'asc' }, include: { decisions: { orderBy: { createdAt: 'desc' } } } } }
    });
    if (!run) return notFound(reply, 'Progress analysis run');
    return run;
  });

  app.post('/v2/progress-projects/:projectId/analysis-runs', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const project = await getProgressProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Progress project');

      const regionSchema = z.object({
        id: z.string().min(1).max(120),
        changeType: z.enum(['ADDED', 'REMOVED', 'MOVED', 'SURFACE_CHANGED', 'APPEARANCE_CHANGED', 'GEOMETRY_CHANGED', 'UNCERTAIN']),
        semanticHint: z.enum(['WALL', 'PARTITION_WALL', 'FLOORING', 'CEILING', 'DOOR', 'WINDOW', 'ELECTRICAL', 'PLUMBING', 'FIXTURE', 'FURNITURE', 'SURFACE', 'OPENING', 'UNKNOWN']).default('UNKNOWN'),
        spatialRef: z.record(z.unknown()).optional(),
        magnitude: z.record(z.unknown()).optional(),
        geometricConfidence: z.number().min(0).max(1).default(0.7),
        semanticConfidence: z.number().min(0).max(1).optional(),
        evidenceRefs: z.array(z.string().max(300)).max(20).default([])
      });
      const body = z.object({
        sourceSnapshotId: z.string(), targetSnapshotId: z.string(), registrationId: z.string().optional(), spatialRoomId: z.string().optional(),
        regions: z.array(regionSchema).min(1).max(200),
        policy: z.object({ minConfidence: z.number().min(0).max(1).default(0.55), includeUncertainRegions: z.boolean().default(false) }).default({ minConfidence: 0.55, includeUncertainRegions: false }),
        engineVersion: z.string().min(1).max(80).default('progress-intelligence-v1'),
        modelVersion: z.string().min(1).max(120).default('bounded-taxonomy-v1'),
        policyVersion: z.string().min(1).max(120).default('progress-policy-v1')
      }).refine((value) => value.sourceSnapshotId !== value.targetSnapshotId, 'Snapshots must differ').parse(request.body);

      const snapshots = await prisma.captureSnapshot.findMany({
        where: { id: { in: [body.sourceSnapshotId, body.targetSnapshotId] }, projectId },
        include: { capture: { include: { rooms: true } } }
      });
      if (snapshots.length !== 2) return reply.code(400).send({ error: 'SNAPSHOT_NOT_IN_PROJECT' });
      if (body.spatialRoomId) {
        const room = await prisma.spatialRoom.findFirst({ where: { id: body.spatialRoomId, projectId } });
        if (!room) return reply.code(400).send({ error: 'SPATIAL_ROOM_NOT_IN_PROJECT' });
        if (snapshots.some((snapshot) => !snapshot.capture.rooms.some((captureRoom) => captureRoom.spatialRoomId === body.spatialRoomId))) {
          return reply.code(409).send({ error: 'ROOM_NOT_PRESENT_IN_BOTH_SNAPSHOTS' });
        }
      }

      const registration = body.registrationId
        ? await prisma.captureRegistration.findFirst({ where: { id: body.registrationId, projectId } })
        : await prisma.captureRegistration.findFirst({
            where: {
              projectId, status: 'VERIFIED',
              OR: [
                { sourceSnapshotId: body.sourceSnapshotId, targetSnapshotId: body.targetSnapshotId },
                { sourceSnapshotId: body.targetSnapshotId, targetSnapshotId: body.sourceSnapshotId }
              ]
            },
            orderBy: { updatedAt: 'desc' }
          });
      if (!registration) return reply.code(409).send({ error: 'VERIFIED_REGISTRATION_REQUIRED' });
      if (registration.status !== 'VERIFIED') return reply.code(409).send({ error: 'REGISTRATION_MUST_BE_VERIFIED' });
      const pairMatches = (
        (registration.sourceSnapshotId === body.sourceSnapshotId && registration.targetSnapshotId === body.targetSnapshotId) ||
        (registration.sourceSnapshotId === body.targetSnapshotId && registration.targetSnapshotId === body.sourceSnapshotId)
      );
      if (!pairMatches) return reply.code(409).send({ error: 'REGISTRATION_DOES_NOT_MATCH_CAPTURE_PAIR' });

      const created = await prisma.$transaction(async (tx) => {
        const run = await tx.progressAnalysisRun.create({
          data: {
            projectId, sourceSnapshotId: body.sourceSnapshotId, targetSnapshotId: body.targetSnapshotId,
            registrationId: registration.id, spatialRoomId: body.spatialRoomId, status: 'QUEUED',
            engineVersion: body.engineVersion, modelVersion: body.modelVersion, policyVersion: body.policyVersion,
            inputRegions: asJson(body.regions), createdById: request.user.userId
          }
        });
        const job = await tx.processingJob.create({
          data: { type: 'PROGRESS_INTELLIGENCE', status: 'QUEUED', progress: 0, input: asJson({ analysisRunId: run.id, policy: body.policy }) }
        });
        const linked = await tx.progressAnalysisRun.update({ where: { id: run.id }, data: { jobId: job.id } });
        await tx.progressProject.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
        return { run: linked, job };
      });

      try {
        await visionQueue.add('PROGRESS_INTELLIGENCE', { jobId: created.job.id }, { attempts: 2, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 200, removeOnFail: 500 });
      } catch (queueError) {
        const message = queueError instanceof Error ? queueError.message : String(queueError);
        await prisma.$transaction([
          prisma.processingJob.update({ where: { id: created.job.id }, data: { status: 'FAILED', error: message, completedAt: new Date() } }),
          prisma.progressAnalysisRun.update({ where: { id: created.run.id }, data: { status: 'FAILED', error: message, completedAt: new Date() } })
        ]);
        throw queueError;
      }

      await audit({ organizationId: request.user.organizationId, actorId: request.user.userId, entityType: 'ProgressAnalysisRun', entityId: created.run.id, action: 'QUEUE', payload: { sourceSnapshotId: body.sourceSnapshotId, targetSnapshotId: body.targetSnapshotId, registrationId: registration.id, regionCount: body.regions.length } });
      return reply.code(202).send({ ...created.run, observations: [], processingJobId: created.job.id });
    } catch (error) { return badRequest(reply, error); }
  });

  app.post('/v2/progress-projects/:projectId/observations', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const project = await getProgressProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Progress project');
      const body = z.object({
        sourceSnapshotId: z.string().optional(), targetSnapshotId: z.string().optional(), spatialRoomId: z.string().optional(),
        observationType: z.string().min(1).max(100), spatialRef: z.record(z.unknown()).optional(), structuredEvidence: z.record(z.unknown()),
        confidence: z.number().min(0).max(1), modelVersion: z.string().max(100).optional(), policyVersion: z.string().max(100).optional()
      }).parse(request.body);
      const snapshotIds = [body.sourceSnapshotId, body.targetSnapshotId].filter((value): value is string => Boolean(value));
      if (snapshotIds.length) {
        const snapshotCount = await prisma.captureSnapshot.count({ where: { id: { in: snapshotIds }, projectId } });
        if (snapshotCount !== new Set(snapshotIds).size) return reply.code(400).send({ error: 'SNAPSHOT_NOT_IN_PROJECT' });
      }
      if (body.spatialRoomId) {
        const room = await prisma.spatialRoom.findFirst({ where: { id: body.spatialRoomId, projectId } });
        if (!room) return reply.code(400).send({ error: 'SPATIAL_ROOM_NOT_IN_PROJECT' });
      }
      const observation = await prisma.aiObservation.create({
        data: {
          projectId, sourceSnapshotId: body.sourceSnapshotId, targetSnapshotId: body.targetSnapshotId, spatialRoomId: body.spatialRoomId,
          observationType: body.observationType, spatialRef: body.spatialRef ? asJson(body.spatialRef) : undefined,
          structuredEvidence: asJson(body.structuredEvidence), confidence: body.confidence,
          modelVersion: body.modelVersion, policyVersion: body.policyVersion
        }
      });
      return reply.code(201).send(observation);
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.post('/v2/progress-observations/:observationId/decision', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { observationId } = request.params as { observationId: string };
      const observation = await prisma.aiObservation.findFirst({
        where: { id: observationId, project: { unit: { property: { organizationId: request.user.organizationId } } } }
      });
      if (!observation) return notFound(reply, 'AI observation');
      const body = z.object({
        decision: z.enum(['CONFIRMED', 'REJECTED', 'CORRECTED']), correctedValue: z.record(z.unknown()).optional(), note: z.string().max(2000).optional()
      }).parse(request.body);
      const result = await prisma.$transaction(async (tx) => {
        const decision = await tx.observationDecision.create({
          data: { observationId, actorId: request.user.userId, decision: body.decision, correctedValue: body.correctedValue ? asJson(body.correctedValue) : undefined, note: body.note }
        });
        await tx.aiObservation.update({ where: { id: observationId }, data: { status: body.decision } });
        return decision;
      });
      await audit({ organizationId: request.user.organizationId, actorId: request.user.userId, entityType: 'AiObservation', entityId: observationId, action: 'DECIDE', payload: { decision: body.decision } });
      return reply.code(201).send(result);
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.get('/v2/progress-projects/:projectId/team', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await getProgressProjectForOrganization(projectId, request.user.organizationId);
    if (!project) return notFound(reply, 'Progress project');
    return prisma.user.findMany({
      where: { organizationId: request.user.organizationId },
      select: { id: true, name: true, phone: true, role: true },
      orderBy: [{ name: 'asc' }, { createdAt: 'asc' }]
    });
  });

  app.get('/v2/progress-projects/:projectId/issues', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const project = await getProgressProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Progress project');
      const query = z.object({
        status: z.string().max(40).optional(), severity: z.string().max(40).optional(), spatialRoomId: z.string().optional(), assigneeId: z.string().optional()
      }).parse(request.query);
      return prisma.projectIssue.findMany({
        where: {
          projectId,
          ...(query.status ? { status: query.status } : {}),
          ...(query.severity ? { severity: query.severity } : {}),
          ...(query.spatialRoomId ? { spatialRoomId: query.spatialRoomId } : {}),
          ...(query.assigneeId ? { assigneeId: query.assigneeId } : {})
        },
        include: { events: { orderBy: { createdAt: 'desc' }, take: 100 } },
        orderBy: [{ updatedAt: 'desc' }]
      });
    } catch (error) { return badRequest(reply, error); }
  });

  app.patch('/v2/progress-issues/:issueId', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { issueId } = request.params as { issueId: string };
      const issue = await prisma.projectIssue.findFirst({ where: { id: issueId, project: { unit: { property: { organizationId: request.user.organizationId } } } } });
      if (!issue) return notFound(reply, 'Project issue');
      const body = z.object({
        title: z.string().min(1).max(180).optional(), description: z.string().max(4000).nullable().optional(),
        severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
        status: z.enum(['OPEN', 'IN_REVIEW', 'RESOLVED', 'REJECTED']).optional(),
        assigneeId: z.string().nullable().optional(), dueAt: z.string().datetime().nullable().optional(), note: z.string().max(2000).optional()
      }).parse(request.body);
      if (body.assigneeId) {
        const assignee = await prisma.user.findFirst({ where: { id: body.assigneeId, organizationId: request.user.organizationId } });
        if (!assignee) return reply.code(400).send({ error: 'ASSIGNEE_NOT_IN_ORGANIZATION' });
      }
      const nextStatus = body.status ?? issue.status;
      const updated = await prisma.$transaction(async (tx) => {
        const next = await tx.projectIssue.update({
          where: { id: issueId },
          data: {
            title: body.title, description: body.description, severity: body.severity,
            status: body.status, assigneeId: body.assigneeId, dueAt: body.dueAt === undefined ? undefined : body.dueAt === null ? null : new Date(body.dueAt),
            resolvedAt: body.status === 'RESOLVED' ? new Date() : body.status && issue.status === 'RESOLVED' ? null : undefined,
            closedById: ['RESOLVED', 'REJECTED'].includes(nextStatus) ? request.user.userId : body.status ? null : undefined
          }
        });
        const changed = body.status && body.status !== issue.status;
        await tx.issueEvent.create({
          data: {
            issueId, actorId: request.user.userId, eventType: changed ? 'STATUS_CHANGED' : 'UPDATED',
            fromStatus: changed ? issue.status : undefined, toStatus: changed ? body.status : undefined,
            note: body.note,
            payload: compactJson({ severity: body.severity, assigneeId: body.assigneeId, dueAt: body.dueAt })
          }
        });
        return tx.projectIssue.findUniqueOrThrow({ where: { id: issueId }, include: { events: { orderBy: { createdAt: 'desc' } } } });
      });
      await audit({ organizationId: request.user.organizationId, actorId: request.user.userId, entityType: 'ProjectIssue', entityId: issueId, action: 'UPDATE', payload: { status: updated.status, severity: updated.severity } });
      return updated;
    } catch (error) { return badRequest(reply, error); }
  });

  app.post('/v2/progress-issues/:issueId/events', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { issueId } = request.params as { issueId: string };
      const issue = await prisma.projectIssue.findFirst({ where: { id: issueId, project: { unit: { property: { organizationId: request.user.organizationId } } } } });
      if (!issue) return notFound(reply, 'Project issue');
      const body = z.object({ eventType: z.enum(['COMMENT', 'RESOLUTION_NOTE', 'EVIDENCE_NOTE']), note: z.string().min(1).max(4000), payload: z.record(z.unknown()).optional() }).parse(request.body);
      const event = await prisma.issueEvent.create({ data: { issueId, actorId: request.user.userId, eventType: body.eventType, note: body.note, payload: body.payload ? asJson(body.payload) : undefined } });
      await prisma.progressProject.update({ where: { id: issue.projectId }, data: { updatedAt: new Date() } });
      return reply.code(201).send(event);
    } catch (error) { return badRequest(reply, error); }
  });

  app.post('/v2/progress-issues/:issueId/decision', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { issueId } = request.params as { issueId: string };
      const issue = await prisma.projectIssue.findFirst({ where: { id: issueId, project: { unit: { property: { organizationId: request.user.organizationId } } } } });
      if (!issue) return notFound(reply, 'Project issue');
      const body = z.object({ decision: z.enum(['VERIFIED', 'REJECTED', 'CORRECTED']), note: z.string().max(2000).optional(), correctedValue: z.record(z.unknown()).optional() }).parse(request.body);
      const updated = await prisma.$transaction(async (tx) => {
        const next = await tx.projectIssue.update({ where: { id: issueId }, data: { verification: body.decision } });
        await tx.issueEvent.create({ data: { issueId, actorId: request.user.userId, eventType: 'VERIFICATION_DECISION', note: body.note, payload: compactJson({ decision: body.decision, correctedValue: body.correctedValue }) } });
        return tx.projectIssue.findUniqueOrThrow({ where: { id: issueId }, include: { events: { orderBy: { createdAt: 'desc' } } } });
      });
      await audit({ organizationId: request.user.organizationId, actorId: request.user.userId, entityType: 'ProjectIssue', entityId: issueId, action: 'VERIFY', payload: { decision: body.decision } });
      return updated;
    } catch (error) { return badRequest(reply, error); }
  });

  app.get('/v2/progress-projects/:projectId/reports', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await getProgressProjectForOrganization(projectId, request.user.organizationId);
    if (!project) return notFound(reply, 'Progress project');
    return prisma.projectReport.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 100 });
  });

  app.post('/v2/progress-projects/:projectId/reports', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const project = await prisma.progressProject.findFirst({
        where: { id: projectId, unit: { property: { organizationId: request.user.organizationId } } },
        include: { unit: { include: { property: true } } }
      });
      if (!project) return notFound(reply, 'Progress project');
      const body = z.object({
        reportType: z.enum(['WEEKLY', 'MILESTONE', 'HANDOVER', 'CUSTOM']).default('MILESTONE'), label: z.string().max(160).optional(),
        periodStart: z.string().datetime().optional(), periodEnd: z.string().datetime().optional()
      }).parse(request.body);
      const start = body.periodStart ? new Date(body.periodStart) : undefined;
      const end = body.periodEnd ? new Date(body.periodEnd) : undefined;
      if (start && end && start > end) return reply.code(400).send({ error: 'REPORT_PERIOD_INVALID' });
      const dateWhere = start || end ? { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) } : undefined;
      const [snapshots, issues, observations] = await Promise.all([
        prisma.captureSnapshot.findMany({ where: { projectId, ...(dateWhere ? { capturedAt: dateWhere } : {}) }, orderBy: { capturedAt: 'asc' } }),
        prisma.projectIssue.findMany({ where: { projectId, ...(dateWhere ? { updatedAt: dateWhere } : {}) }, orderBy: { updatedAt: 'asc' } }),
        prisma.aiObservation.findMany({ where: { projectId, ...(dateWhere ? { createdAt: dateWhere } : {}) }, orderBy: { createdAt: 'asc' } })
      ]);
      const content = buildProgressReport({
        project: { id: project.id, name: project.name, unitLabel: project.unit.label, propertyName: project.unit.property.name },
        periodStart: start, periodEnd: end, label: body.label, snapshots, issues, observations
      });
      const report = await prisma.projectReport.create({ data: {
        projectId, reportType: body.reportType, label: body.label, periodStart: start, periodEnd: end,
        schemaVersion: content.schemaVersion, disclaimerVersion: content.disclaimerVersion, content: asJson(content), generatedById: request.user.userId
      } });
      await audit({ organizationId: request.user.organizationId, actorId: request.user.userId, entityType: 'ProjectReport', entityId: report.id, action: 'GENERATE', payload: { reportType: report.reportType, periodStart: report.periodStart, periodEnd: report.periodEnd } });
      return reply.code(201).send({ ...report, content });
    } catch (error) { return badRequest(reply, error); }
  });

  app.get('/v2/progress-reports/:reportId', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { reportId } = request.params as { reportId: string };
    const report = await prisma.projectReport.findFirst({ where: { id: reportId, project: { unit: { property: { organizationId: request.user.organizationId } } } } });
    if (!report) return notFound(reply, 'Progress report');
    return report;
  });

}
