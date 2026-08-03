import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getCaptureForOrganization, getDesignProjectForOrganization } from '../lib/access.js';
import { badRequest, notFound } from '../lib/http.js';
import { asJson } from '../lib/json.js';
import { makeSlug } from '../lib/slug.js';
import { visionQueue } from '../lib/queue.js';
import { minioSigner } from '../lib/minio.js';
import { config } from '../config.js';

const point = z.tuple([z.number(), z.number()]);
const measurementSchema = z.object({
  label: z.string().min(1).max(120), valueM: z.number().positive(), startPoint: point.optional(), endPoint: point.optional(),
  method: z.enum(['TAPE','LASER','AR_HIT_TEST','ROOMPLAN','DEPTH_DERIVED','DESIGNER_CORRECTION','SITE_VERIFICATION','ANDROID_FIELD_CONFIRMATION']),
  toleranceM: z.number().nonnegative().max(1).optional(), verificationStatus: z.enum(['UNVERIFIED','OPERATOR_CONFIRMED','DESIGNER_CONFIRMED','SITE_VERIFIED']).default('UNVERIFIED'),
  evidenceRefs: z.array(z.string()).default([]), acquiredAt: z.coerce.date().optional()
});


function canonicalModel(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Project canonical model is invalid');
  return structuredClone(value as Record<string, unknown>);
}

function wallSet(roomId: string, polygon: unknown[]): Array<Record<string, unknown>> {
  return polygon.map((start, index) => ({ id: `${roomId}-wall-${index + 1}`, start, end: polygon[(index + 1) % polygon.length], heightM: 2.8, thicknessM: 0.12, material: 'Warm White', structuralStatus: 'UNKNOWN', confidence: 0.5, verificationStatus: 'DESIGNER_REVIEW_REQUIRED', openings: [] }));
}

async function saveCanonicalRevision(project: { id: string; activeVersion: number; model: unknown }, model: Record<string, unknown>, userId: string, label: string, notes?: string) {
  const nextVersion = project.activeVersion + 1;
  return prisma.$transaction(async (tx) => {
    await tx.designVersion.create({ data: { projectId: project.id, version: nextVersion, model: asJson(model), label, notes, createdById: userId } });
    return tx.designProject.update({ where: { id: project.id }, data: { model: asJson(model), activeVersion: nextVersion, status: 'DESIGNER_CORRECTION', verificationStatus: 'UNCONFIRMED', geometryStatus: 'DESIGNER_CORRECTION', generatedGlbKey: null } });
  });
}

const exportFormats = z.enum(['CANONICAL_JSON','GLB','GLB_LOW','GLB_FULL','SVG','DXF','PDF','PNG','JPEG','CSV','XLSX','BOQ_CSV','BOQ_XLSX','MEASUREMENT_REPORT','DOOR_WINDOW_SCHEDULE','MATERIAL_SCHEDULE']);

async function queueJob(type: string, projectId: string | null, captureId: string | null, input?: Record<string, unknown>) {
  const job = await prisma.processingJob.create({
    data: { type: type as never, designProjectId: projectId, captureId, status: 'QUEUED', input: input ? asJson(input) : undefined }
  });
  await visionQueue.add(type, { jobId: job.id }, { attempts: 2, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 200, removeOnFail: 500 });
  return job;
}

export async function modeBRoutes(app: FastifyInstance) {
  app.post('/v2/captures/:captureId/packages/finalize', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { captureId } = request.params as { captureId: string };
      const capture = await getCaptureForOrganization(captureId, request.user.organizationId);
      if (!capture) return notFound(reply, 'Capture');
      if (capture.mode !== 'DESIGN_SCAN') return reply.code(409).send({ error: 'CAPTURE_IS_NOT_DESIGN_SCAN' });
      const body = z.object({
        rooms: z.array(z.object({ roomId: z.string(), manifestAssetId: z.string(), archiveAssetId: z.string() })).min(1)
      }).parse(request.body);
      const roomIds = new Set((await prisma.room.findMany({ where: { captureId }, select: { id: true } })).map((room) => room.id));
      const assetIds = body.rooms.flatMap((room) => [room.manifestAssetId, room.archiveAssetId]);
      const assets = await prisma.asset.findMany({ where: { id: { in: assetIds }, captureId, status: { in: ['UPLOADED','APPROVED'] } } });
      const byId = new Map(assets.map((asset) => [asset.id, asset]));
      for (const item of body.rooms) {
        if (!roomIds.has(item.roomId)) return reply.code(400).send({ error: 'ROOM_NOT_IN_CAPTURE', roomId: item.roomId });
        const manifest = byId.get(item.manifestAssetId); const archive = byId.get(item.archiveAssetId);
        if (!manifest || manifest.roomId !== item.roomId || manifest.kind !== 'CAPTURE_MANIFEST') return reply.code(400).send({ error: 'INVALID_MANIFEST_ASSET', roomId: item.roomId });
        if (!archive || archive.roomId !== item.roomId || archive.kind !== 'MODEL_EVIDENCE') return reply.code(400).send({ error: 'INVALID_ARCHIVE_ASSET', roomId: item.roomId });
      }
      await prisma.$transaction(body.rooms.map((item) => prisma.capturePackage.upsert({
        where: { id: `${captureId}:${item.roomId}` },
        create: { id: `${captureId}:${item.roomId}`, captureId, roomId: item.roomId, schemaVersion: '2.0', captureType: 'ANDROID_RGBD_ROOM_SCAN', manifestAssetId: item.manifestAssetId, archiveAssetId: item.archiveAssetId, status: 'VALIDATING' },
        update: { manifestAssetId: item.manifestAssetId, archiveAssetId: item.archiveAssetId, status: 'VALIDATING', checksumVerified: false }
      })));
      const job = await queueJob('CAPTURE_PACKAGE_VALIDATE', null, captureId, { packageRoomIds: body.rooms.map((room) => room.roomId) });
      return reply.code(202).send({ jobId: job.id, packageCount: body.rooms.length });
    } catch (error) { return badRequest(reply, error); }
  });

  app.get('/v2/captures/:captureId/packages', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { captureId } = request.params as { captureId: string };
    const capture = await getCaptureForOrganization(captureId, request.user.organizationId);
    if (!capture) return notFound(reply, 'Capture');
    return prisma.capturePackage.findMany({ where: { captureId }, orderBy: { createdAt: 'asc' } });
  });


  app.post('/v2/captures/:captureId/roomplan-import', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { captureId } = request.params as { captureId: string };
      const capture = await getCaptureForOrganization(captureId, request.user.organizationId);
      if (!capture) return notFound(reply, 'Capture');
      if (capture.mode !== 'DESIGN_SCAN') return reply.code(409).send({ error: 'CAPTURE_IS_NOT_DESIGN_SCAN' });
      const body = z.object({ sourceAssetId: z.string(), model: z.record(z.unknown()), rooms: z.array(z.object({ roomId: z.string(), floorPolygon: z.array(point).min(3), ceilingHeightM: z.number().positive(), roomModel: z.record(z.unknown()) })).min(1) }).parse(request.body);
      const source = await prisma.asset.findFirst({ where: { id: body.sourceAssetId, captureId, kind: 'ROOMPLAN_USDZ', status: { in: ['UPLOADED','APPROVED'] } } });
      if (!source) return reply.code(400).send({ error: 'ROOMPLAN_SOURCE_ASSET_INVALID' });
      const validRooms = new Set((await prisma.room.findMany({ where: { captureId }, select: { id: true } })).map((room) => room.id));
      for (const item of body.rooms) if (!validRooms.has(item.roomId)) return reply.code(400).send({ error: 'ROOM_NOT_IN_CAPTURE', roomId: item.roomId });
      await prisma.$transaction(body.rooms.map((item) => prisma.room.update({ where: { id: item.roomId }, data: { floorPolygon: asJson(item.floorPolygon), ceilingHeightM: item.ceilingHeightM, roomModel: asJson({ ...item.roomModel, source: 'ROOMPLAN', evidenceRefs: [body.sourceAssetId], verificationStatus: 'DESIGNER_REVIEW_REQUIRED' }) } })));
      return reply.send({ captureId, sourceAssetId: source.id, importedRooms: body.rooms.length, canonicalModel: body.model, status: 'DRAFT_MODEL' });
    } catch (error) { return badRequest(reply, error); }
  });

  app.post('/v2/captures/:captureId/geometry-jobs', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { captureId } = request.params as { captureId: string };
      const capture = await getCaptureForOrganization(captureId, request.user.organizationId);
      if (!capture) return notFound(reply, 'Capture');
      const body = z.object({ projectId: z.string(), stages: z.array(z.enum(['CAPTURE_PACKAGE_VALIDATE','DEPTH_FUSE','SURFACE_EXTRACT','ROOM_MODEL_INFER','OPENING_INFER','MODEL_OPTIMIZE','MODEL_QA'])).default(['CAPTURE_PACKAGE_VALIDATE','DEPTH_FUSE','SURFACE_EXTRACT','ROOM_MODEL_INFER','OPENING_INFER','MODEL_OPTIMIZE','MODEL_QA']) }).parse(request.body);
      const project = await getDesignProjectForOrganization(body.projectId, request.user.organizationId);
      if (!project || project.captureId !== captureId) return notFound(reply, 'Design project');
      const job = await queueJob('MODEB_GEOMETRY', project.id, captureId, { requestedStages: body.stages });
      await prisma.designProject.update({ where: { id: project.id }, data: { status: 'MODEL_GENERATING', geometryStatus: 'PROCESSING' } });
      return reply.code(202).send({ jobId: job.id, stages: body.stages });
    } catch (error) { return badRequest(reply, error); }
  });

  app.get('/v2/geometry-jobs/:jobId', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = await prisma.processingJob.findFirst({ where: { id: jobId, OR: [{ capture: { unit: { property: { organizationId: request.user.organizationId } } } }, { designProject: { unit: { property: { organizationId: request.user.organizationId } } } }] } });
    return job ? reply.send(job) : notFound(reply, 'Geometry job');
  });

  app.get('/v2/geometry-jobs/:jobId/events', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const existing = await prisma.processingJob.findFirst({ where: { id: jobId, OR: [{ capture: { unit: { property: { organizationId: request.user.organizationId } } } }, { designProject: { unit: { property: { organizationId: request.user.organizationId } } } }] } });
    if (!existing) return notFound(reply, 'Job');
    reply.raw.setHeader('content-type', 'text/event-stream');
    reply.raw.setHeader('cache-control', 'no-cache');
    reply.raw.setHeader('connection', 'keep-alive');
    let closed = false; request.raw.on('close', () => { closed = true; });
    while (!closed) {
      const job = await prisma.processingJob.findUnique({ where: { id: jobId } });
      reply.raw.write(`event: progress\ndata: ${JSON.stringify(job)}\n\n`);
      if (!job || ['SUCCEEDED','FAILED'].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    reply.raw.end();
  });


  app.get('/v2/design-projects/:projectId/evidence', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
    if (!project) return notFound(reply, 'Design project');
    const assets = await prisma.asset.findMany({ where: { captureId: project.captureId, status: { in: ['UPLOADED','APPROVED'] } }, orderBy: { createdAt: 'asc' } });
    const packages = await prisma.capturePackage.findMany({ where: { captureId: project.captureId } });
    const proposals = await prisma.geometryProposal.findMany({ where: { room: { captureId: project.captureId } } });
    const signed = await Promise.all(assets.map(async (asset) => ({
      id: asset.id, roomId: asset.roomId, kind: asset.kind, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes,
      metadata: asset.metadata, status: asset.status,
      url: await minioSigner.presignedGetObject(config.MINIO_BUCKET_PRIVATE, asset.objectKey, 15 * 60)
    })));
    return reply.send({ expiresInSeconds: 900, assets: signed, packages, proposals, geometryReport: project.geometryReport });
  });

  app.get('/v2/models/:projectId/proposals', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
    if (!project) return notFound(reply, 'Design project');
    return prisma.geometryProposal.findMany({ where: { room: { captureId: project.captureId } }, orderBy: { createdAt: 'asc' } });
  });

  app.post('/v2/models/:projectId/proposals/:proposalId/decision', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId, proposalId } = request.params as { projectId: string; proposalId: string };
      const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Design project');
      const body = z.object({ decision: z.enum(['ACCEPT','REJECT']), note: z.string().max(500).optional() }).parse(request.body);
      const proposal = await prisma.geometryProposal.findFirst({ where: { id: proposalId, room: { captureId: project.captureId } } });
      if (!proposal) return notFound(reply, 'Geometry proposal');
      const updated = await prisma.geometryProposal.update({ where: { id: proposal.id }, data: body.decision === 'ACCEPT' ? { status: 'ACCEPTED', acceptedAt: new Date() } : { status: 'REJECTED', rejectedAt: new Date() } });
      if (body.decision === 'ACCEPT') {
        const model = canonicalModel(project.model); const rooms = Array.isArray(model.rooms) ? model.rooms as Array<Record<string, unknown>> : [];
        const room = rooms.find((item) => String(item.id) === proposal.roomId); const geometry = proposal.geometry as Record<string, unknown>;
        if (room && proposal.proposalType === 'ROOM_POLYGON' && Array.isArray(geometry.floorPolygon) && geometry.floorPolygon.length >= 3) {
          room.floorPolygon = geometry.floorPolygon; room.walls = wallSet(String(room.id), geometry.floorPolygon); room.heightM = Number(geometry.heightM ?? room.heightM ?? 2.8);
          room.verificationStatus = 'DESIGNER_REVIEW_REQUIRED'; room.geometryProposalId = proposal.id;
          await saveCanonicalRevision(project, model, request.user.userId, 'Accepted geometry proposal', body.note);
        } else if (room && proposal.proposalType === 'OPENING') {
          const unplaced = Array.isArray(room.unplacedOpeningProposals) ? room.unplacedOpeningProposals as Array<Record<string, unknown>> : [];
          room.unplacedOpeningProposals = unplaced.map((item) => String(item.id) === String(geometry.id) ? { ...item, proposalStatus: 'ACCEPTED_FOR_PLACEMENT' } : item);
          await saveCanonicalRevision(project, model, request.user.userId, 'Accepted opening proposal', body.note);
        }
      }
      return reply.send(updated);
    } catch (error) { return badRequest(reply, error); }
  });

  app.post('/v2/models/:projectId/measurements', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Design project');
      const body = z.object({ roomId: z.string(), measurement: measurementSchema }).parse(request.body);
      const room = await prisma.room.findFirst({ where: { id: body.roomId, captureId: project.captureId } });
      if (!room) return notFound(reply, 'Room');
      const created = await prisma.measurement.create({ data: { roomId: room.id, label: body.measurement.label, valueM: body.measurement.valueM, startPoint: body.measurement.startPoint ? asJson(body.measurement.startPoint) : undefined, endPoint: body.measurement.endPoint ? asJson(body.measurement.endPoint) : undefined, method: body.measurement.method, toleranceM: body.measurement.toleranceM, verificationStatus: body.measurement.verificationStatus, evidenceRefs: asJson(body.measurement.evidenceRefs), acquiredById: request.user.userId, acquiredAt: body.measurement.acquiredAt ?? new Date() } });
      const model = canonicalModel(project.model); const rooms = Array.isArray(model.rooms) ? model.rooms as Array<Record<string, unknown>> : []; const modelRoom = rooms.find((item) => String(item.id) === room.id);
      if (modelRoom) {
        const measurements = Array.isArray(modelRoom.measurements) ? modelRoom.measurements : [];
        modelRoom.measurements = [...measurements, { id: created.id, label: created.label, valueM: created.valueM, unit: 'm', method: created.method, toleranceM: created.toleranceM, start: body.measurement.startPoint, end: body.measurement.endPoint, verificationStatus: created.verificationStatus, evidenceRefs: body.measurement.evidenceRefs, capturedAt: created.acquiredAt.toISOString() }];
        await saveCanonicalRevision(project, model, request.user.userId, 'Measurement added', `${created.label}: ${created.valueM}m`);
      }
      return reply.code(201).send(created);
    } catch (error) { return badRequest(reply, error); }
  });

  app.get('/v2/models/:projectId/measurements', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
    if (!project) return notFound(reply, 'Design project');
    return prisma.measurement.findMany({ where: { room: { captureId: project.captureId } }, orderBy: { acquiredAt: 'asc' } });
  });

  app.post('/v2/design-projects/:projectId/options', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Design project');
      const body = z.object({ name: z.string().min(1).max(120), description: z.string().max(500).optional(), model: z.record(z.unknown()).optional() }).parse(request.body);
      return reply.code(201).send(await prisma.designOption.create({ data: { projectId, name: body.name, description: body.description, model: asJson(body.model ?? project.model), createdById: request.user.userId } }));
    } catch (error) { return badRequest(reply, error); }
  });

  app.get('/v2/design-projects/:projectId/options', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
    if (!project) return notFound(reply, 'Design project');
    return prisma.designOption.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
  });


  app.post('/v2/design-projects/:projectId/renders', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Design project');
      const body = z.object({ quality: z.enum(['PREVIEW','FINAL']).default('PREVIEW'), mode: z.enum(['STILL','PANORAMA','WALKTHROUGH']).default('STILL'), designOptionId: z.string().optional(), settings: z.object({ width: z.number().int().min(320).max(8000).default(1600), height: z.number().int().min(240).max(8000).default(1000), camera: z.record(z.number()).optional(), path: z.array(z.record(z.unknown())).optional(), fps: z.number().int().min(12).max(60).optional(), framesPerSegment: z.number().int().min(10).max(300).optional(), timeoutSeconds: z.number().int().min(30).max(3600).optional() }).default({ width: 1600, height: 1000 }) }).parse(request.body ?? {});
      if (body.designOptionId) { const option = await prisma.designOption.findFirst({ where: { id: body.designOptionId, projectId } }); if (!option) return notFound(reply, 'Design option'); }
      const format = body.mode === 'WALKTHROUGH' ? 'WALKTHROUGH_MP4' : body.mode === 'PANORAMA' ? 'PANORAMA_PNG' : body.quality === 'FINAL' ? 'RENDER_FINAL_PNG' : 'RENDER_PREVIEW_PNG';
      const settings = { ...body.settings, renderMode: body.mode };
      const record = await prisma.exportRecord.create({ data: { projectId, designOptionId: body.designOptionId, version: project.activeVersion, format, createdById: request.user.userId, metadata: asJson(settings) } });
      const type = body.quality === 'FINAL' ? 'RENDER_FINAL' : 'RENDER_PREVIEW';
      const job = await queueJob(type, projectId, project.captureId, { exportRecordId: record.id, settings });
      return reply.code(202).send({ renderId: record.id, jobId: job.id });
    } catch (error) { return badRequest(reply, error); }
  });

  app.post('/v2/design-projects/:projectId/exports', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Design project');
      const body = z.object({ format: exportFormats, designOptionId: z.string().optional(), version: z.number().int().positive().optional(), settings: z.record(z.unknown()).optional() }).parse(request.body);
      const record = await prisma.exportRecord.create({ data: { projectId, designOptionId: body.designOptionId, version: body.version ?? project.activeVersion, format: body.format, createdById: request.user.userId, metadata: body.settings ? asJson(body.settings) : undefined } });
      const jobType = ['GLB','GLB_LOW','GLB_FULL'].includes(body.format) ? 'EXPORT_PARAMETRIC_SHELL_GLB' : body.format === 'CANONICAL_JSON' ? 'EXPORT_MODEL' : ['CSV','XLSX','BOQ_CSV','BOQ_XLSX','DOOR_WINDOW_SCHEDULE','MATERIAL_SCHEDULE'].includes(body.format) ? 'EXPORT_SCHEDULE' : 'EXPORT_PLAN';
      const job = await queueJob(jobType, projectId, project.captureId, { exportRecordId: record.id, format: body.format, designOptionId: body.designOptionId, version: record.version, settings: body.settings ?? {} });
      return reply.code(202).send({ exportId: record.id, jobId: job.id });
    } catch (error) { return badRequest(reply, error); }
  });

  app.get('/v2/design-projects/:projectId/exports', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
    if (!project) return notFound(reply, 'Design project');
    return prisma.exportRecord.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  });


  app.post('/v2/design-projects/:projectId/model-qa', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
    if (!project) return notFound(reply, 'Design project');
    const job = await queueJob('MODEL_QA', project.id, project.captureId);
    return reply.code(202).send({ jobId: job.id });
  });

  app.post('/v2/design-projects/:projectId/reviews', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Design project');
      const body = z.object({ decision: z.enum(['DESIGNER_CONFIRMED','SITE_VERIFIED','CHANGES_REQUIRED']), notes: z.string().max(1000).optional() }).parse(request.body);
      if (body.decision !== 'CHANGES_REQUIRED') {
        const report = (project.geometryReport ?? {}) as Record<string, unknown>;
        const issues = Array.isArray(report.issues) ? report.issues as Array<Record<string, unknown>> : [];
        if (report.valid === false || Number(report.errorCount ?? 0) > 0 || issues.some((issue) => issue.severity === 'ERROR')) {
          return reply.code(409).send({ error: 'MODEL_QA_HAS_BLOCKING_ERRORS', geometryReport: report });
        }
      }
      const review = await prisma.modelReview.create({ data: { projectId, version: project.activeVersion, reviewerId: request.user.userId, decision: body.decision, notes: body.notes, verificationStatus: body.decision } });
      const confirmed = body.decision !== 'CHANGES_REQUIRED';
      await prisma.designProject.update({ where: { id: project.id }, data: { verificationStatus: confirmed ? body.decision : 'UNCONFIRMED', geometryStatus: confirmed ? `${body.decision}_MODEL` : 'DESIGNER_CORRECTION', status: confirmed ? 'DESIGNER_CONFIRMED' : 'DESIGNER_CORRECTION' } });
      return reply.code(201).send(review);
    } catch (error) { return badRequest(reply, error); }
  });

  app.get('/v2/design-projects/:projectId/comments', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
    if (!project) return notFound(reply, 'Design project');
    return prisma.designComment.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
  });

  app.post('/v2/design-projects/:projectId/comments/:commentId/resolve', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId, commentId } = request.params as { projectId: string; commentId: string };
    const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
    if (!project) return notFound(reply, 'Design project');
    const comment = await prisma.designComment.findFirst({ where: { id: commentId, projectId } });
    if (!comment) return notFound(reply, 'Comment');
    return reply.send(await prisma.designComment.update({ where: { id: comment.id }, data: { resolvedAt: new Date() } }));
  });

  app.post('/v2/design-projects/:projectId/share-links', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Design project');
      const body = z.object({ designOptionId: z.string().optional(), expiresAt: z.coerce.date().optional(), permissions: z.record(z.unknown()).default({ view: true, comment: true, approve: true }) }).parse(request.body ?? {});
      if (!['DESIGNER_CONFIRMED','SITE_VERIFIED'].includes(project.verificationStatus)) return reply.code(409).send({ error: 'DESIGN_REQUIRES_CONFIRMATION' });
      if (body.designOptionId) {
        const option = await prisma.designOption.findFirst({ where: { id: body.designOptionId, projectId } });
        if (!option) return notFound(reply, 'Design option');
      }
      const slug = makeSlug(`${project.slug}-${Date.now().toString(36)}`);
      const link = await prisma.clientShareLink.create({ data: { projectId, slug, designOptionId: body.designOptionId, version: project.activeVersion, expiresAt: body.expiresAt, permissions: asJson(body.permissions), createdById: request.user.userId } });
      return reply.code(201).send({ ...link, url: `/d/${link.slug}` });
    } catch (error) { return badRequest(reply, error); }
  });


  app.post('/v2/design-projects/:projectId/share-links/:linkId/revoke', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId, linkId } = request.params as { projectId: string; linkId: string };
    const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
    if (!project) return notFound(reply, 'Design project');
    const link = await prisma.clientShareLink.findFirst({ where: { id: linkId, projectId } });
    if (!link) return notFound(reply, 'Share link');
    return reply.send(await prisma.clientShareLink.update({ where: { id: link.id }, data: { revokedAt: new Date() } }));
  });

  app.get('/v2/exports/:exportId/download-url', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { exportId } = request.params as { exportId: string };
    const record = await prisma.exportRecord.findFirst({ where: { id: exportId, project: { unit: { property: { organizationId: request.user.organizationId } } } } });
    if (!record) return notFound(reply, 'Export');
    if (record.status !== 'SUCCEEDED' || !record.privateObjectKey) return reply.code(409).send({ error: 'EXPORT_NOT_READY', status: record.status });
    const url = await minioSigner.presignedGetObject(config.MINIO_BUCKET_PRIVATE, record.privateObjectKey, 15 * 60);
    return reply.send({ url, expiresInSeconds: 900, mimeType: record.mimeType, format: record.format });
  });

  app.get('/v2/catalogue/assets', { preHandler: [app.authenticate] }, async (request) => {
    const query = request.query as { category?: string; q?: string };
    return prisma.catalogueAsset.findMany({ where: { active: true, OR: [{ organizationId: request.user.organizationId }, { organizationId: null }], category: query.category, name: query.q ? { contains: query.q, mode: 'insensitive' } : undefined }, orderBy: { name: 'asc' }, take: 200 });
  });

  app.post('/v2/catalogue/assets', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const body = z.object({ name: z.string().min(1), category: z.string().min(1), glbObjectKey: z.string().min(1), thumbnailKey: z.string().optional(), dimensionsM: z.record(z.number()), anchor: z.record(z.unknown()).optional(), placementRules: z.record(z.unknown()).optional(), polygonCount: z.number().int().nonnegative().optional(), textureBytes: z.number().int().nonnegative().optional(), metadata: z.record(z.unknown()).optional() }).parse(request.body);
      return reply.code(201).send(await prisma.catalogueAsset.create({ data: { organizationId: request.user.organizationId, ...body, dimensionsM: asJson(body.dimensionsM), anchor: body.anchor ? asJson(body.anchor) : undefined, placementRules: body.placementRules ? asJson(body.placementRules) : undefined, textureBytes: body.textureBytes !== undefined ? BigInt(body.textureBytes) : undefined, metadata: body.metadata ? asJson(body.metadata) : undefined } }));
    } catch (error) { return badRequest(reply, error); }
  });


  app.post('/v2/materials', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const body = z.object({ name: z.string().min(1), category: z.string().min(1), supplier: z.string().optional(), sku: z.string().optional(), textureSet: z.record(z.unknown()).optional(), physical: z.record(z.unknown()).optional(), realWorldSizeM: z.record(z.number()).optional(), costPerUnit: z.number().nonnegative().optional(), unit: z.string().optional() }).parse(request.body);
      return reply.code(201).send(await prisma.material.create({ data: { organizationId: request.user.organizationId, ...body, textureSet: body.textureSet ? asJson(body.textureSet) : undefined, physical: body.physical ? asJson(body.physical) : undefined, realWorldSizeM: body.realWorldSizeM ? asJson(body.realWorldSizeM) : undefined } }));
    } catch (error) { return badRequest(reply, error); }
  });

  app.get('/v2/products', { preHandler: [app.authenticate] }, async (request) => {
    const query = request.query as { category?: string; q?: string };
    return prisma.product.findMany({ where: { active: true, OR: [{ organizationId: request.user.organizationId }, { organizationId: null }], category: query.category, name: query.q ? { contains: query.q, mode: 'insensitive' } : undefined }, include: { variants: true }, orderBy: { name: 'asc' }, take: 200 });
  });

  app.post('/v2/products', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const body = z.object({ sku: z.string().min(1), name: z.string().min(1), category: z.string().min(1), supplier: z.string().optional(), catalogueAssetId: z.string().optional(), metadata: z.record(z.unknown()).optional(), variants: z.array(z.object({ name: z.string().min(1), materialId: z.string().optional(), price: z.number().nonnegative().optional(), currency: z.string().optional(), priceVersion: z.string().optional(), availability: z.string().optional(), metadata: z.record(z.unknown()).optional() })).default([]) }).parse(request.body);
      return reply.code(201).send(await prisma.product.create({ data: { organizationId: request.user.organizationId, sku: body.sku, name: body.name, category: body.category, supplier: body.supplier, catalogueAssetId: body.catalogueAssetId, metadata: body.metadata ? asJson(body.metadata) : undefined, variants: { create: body.variants.map((variant) => ({ ...variant, metadata: variant.metadata ? asJson(variant.metadata) : undefined })) } }, include: { variants: true } }));
    } catch (error) { return badRequest(reply, error); }
  });

  app.get('/v2/materials', { preHandler: [app.authenticate] }, async (request) => {
    const query = request.query as { category?: string; q?: string };
    return prisma.material.findMany({ where: { active: true, OR: [{ organizationId: request.user.organizationId }, { organizationId: null }], category: query.category, name: query.q ? { contains: query.q, mode: 'insensitive' } : undefined }, orderBy: { name: 'asc' }, take: 200 });
  });
}
