import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getCaptureForOrganization, getProgressProjectForOrganization, getUnitForOrganization } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { asJson } from '../lib/json.js';
import { badRequest, notFound } from '../lib/http.js';

const captureMode = z.enum(['PROPERTY_TOUR', 'DESIGN_SCAN']);
const capturePlatform = z.enum(['ANDROID', 'IOS', 'WEB']);

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
    issues: { orderBy: { updatedAt: 'desc' as const }, take: 100 },
    observations: { orderBy: { createdAt: 'desc' as const }, take: 100 }
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
        _count: { select: { snapshots: true, issues: true, observations: true } }
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
        spatialScope: z.record(z.unknown()).optional()
      }).parse(request.body);
      if (body.floorId) {
        const floor = await prisma.spatialFloor.findFirst({ where: { id: body.floorId, projectId } });
        if (!floor) return notFound(reply, 'Floor');
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
        payload: { projectId, captureId: result.capture.id, mode: body.mode }
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
    const { projectId } = request.params as { projectId: string };
    const project = await getProgressProjectForOrganization(projectId, request.user.organizationId);
    if (!project) return notFound(reply, 'Progress project');
    return prisma.captureSnapshot.findMany({
      where: { projectId },
      orderBy: { capturedAt: 'desc' },
      include: {
        floor: true,
        capture: {
          include: {
            rooms: { orderBy: { sortOrder: 'asc' }, include: { spatialRoom: true } },
            assets: { select: { id: true, roomId: true, spatialRoomId: true, kind: true, status: true, metadata: true, quality: true, createdAt: true } },
            resumableUploads: {
              select: {
                id: true, roomId: true, assetId: true, filename: true, kind: true, status: true,
                uploadedBytes: true, totalSizeBytes: true, totalParts: true, completedAt: true, updatedAt: true
              },
              orderBy: { createdAt: 'desc' }, take: 20
            },
            jobs: { orderBy: { createdAt: 'desc' }, take: 5 },
            designProjects: { select: { id: true, name: true, status: true, slug: true, activeVersion: true, updatedAt: true } }
          }
        }
      }
    });
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

  app.post('/v2/progress-projects/:projectId/issues', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const project = await getProgressProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Progress project');
      const body = z.object({
        spatialRoomId: z.string().optional(), captureSnapshotId: z.string().optional(), spatialRef: z.record(z.unknown()).optional(),
        title: z.string().min(1).max(180), description: z.string().max(4000).optional(), severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('INFO'),
        assigneeId: z.string().optional(), evidenceRefs: z.array(z.string()).optional()
      }).parse(request.body);
      if (body.spatialRoomId) {
        const room = await prisma.spatialRoom.findFirst({ where: { id: body.spatialRoomId, projectId } });
        if (!room) return notFound(reply, 'Spatial room');
      }
      if (body.captureSnapshotId) {
        const snapshot = await prisma.captureSnapshot.findFirst({ where: { id: body.captureSnapshotId, projectId } });
        if (!snapshot) return notFound(reply, 'Capture snapshot');
      }
      const issue = await prisma.projectIssue.create({
        data: {
          projectId, spatialRoomId: body.spatialRoomId, captureSnapshotId: body.captureSnapshotId,
          spatialRef: body.spatialRef ? asJson(body.spatialRef) : undefined,
          title: body.title, description: body.description, severity: body.severity, assigneeId: body.assigneeId,
          evidenceRefs: body.evidenceRefs ? asJson(body.evidenceRefs) : undefined, createdById: request.user.userId
        }
      });
      await prisma.progressProject.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
      return reply.code(201).send(issue);
    } catch (error) {
      return badRequest(reply, error);
    }
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
      return reply.code(201).send(result);
    } catch (error) {
      return badRequest(reply, error);
    }
  });
}
