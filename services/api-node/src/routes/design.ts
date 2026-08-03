import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getDesignProjectForOrganization } from '../lib/access.js';
import { badRequest, notFound } from '../lib/http.js';
import { asJson } from '../lib/json.js';
import { makeSlug } from '../lib/slug.js';
import { visionQueue } from '../lib/queue.js';
import { minio, publicAssetUrl } from '../lib/minio.js';
import { config } from '../config.js';

const pointSchema = z.tuple([z.number(), z.number()]);
const openingSchema = z.object({
  id: z.string(), type: z.enum(['DOOR', 'WINDOW', 'OPENING']), offsetM: z.number().nonnegative(),
  widthM: z.number().positive(), heightM: z.number().positive(), bottomM: z.number().nonnegative().optional(),
  sillM: z.number().nonnegative().optional(), swing: z.string().optional(), confidence: z.number().min(0).max(1).optional(),
  evidenceRefs: z.array(z.string()).optional()
}).passthrough();
const unplacedOpeningSchema = z.object({ id: z.string(), type: z.enum(['DOOR','WINDOW','OPENING']), widthM: z.number().positive(), heightM: z.number().positive(), bottomM: z.number().nonnegative().optional(), placementStatus: z.literal('UNPLACED').default('UNPLACED') });
const wallSchema = z.object({
  id: z.string(), start: pointSchema, end: pointSchema, thicknessM: z.number().positive().max(1).default(0.12),
  material: z.string().optional(), structuralStatus: z.enum(['UNKNOWN', 'NON_STRUCTURAL', 'STRUCTURAL']).default('UNKNOWN'),
  confidence: z.number().min(0).max(1).optional(), evidenceRefs: z.array(z.string()).optional(), openings: z.array(openingSchema).default([])
}).passthrough();
export const modelSchema = z.object({
  schemaVersion: z.string().default('2.1'), units: z.literal('meters').default('meters'),
  coordinateSystem: z.string().default('RIGHT_HANDED_Y_UP'),
  floors: z.array(z.object({ id: z.string(), name: z.string(), elevationM: z.number(), roomIds: z.array(z.string()) })).optional(),
  rooms: z.array(z.object({
    id: z.string().min(1), name: z.string().min(1), floorId: z.string().optional(), heightM: z.number().positive().max(20),
    floorPolygon: z.array(pointSchema).min(3), walls: z.array(wallSchema), objects: z.array(z.record(z.unknown())).default([]),
    scaleStatus: z.string().optional(), verificationStatus: z.string().optional(), confidence: z.number().min(0).max(1).optional(),
    evidenceRefs: z.array(z.string()).optional(), sourceTier: z.string().optional(), evidenceSummary: z.record(z.unknown()).optional(), geometryProposals: z.record(z.unknown()).optional(), unplacedOpenings: z.array(unplacedOpeningSchema).default([]), measurements: z.array(z.record(z.unknown())).default([]), transform: z.record(z.unknown()).optional(), quality: z.record(z.unknown()).optional()
  }).passthrough()).min(1),
  structure: z.record(z.unknown()).optional(), metadata: z.record(z.unknown()).optional()
}).passthrough();

type Point = [number, number];
function polygonWalls(roomId: string, points: Point[]) {
  return points.map((start, index) => ({
    id: `${roomId}-wall-${index + 1}`, start, end: points[(index + 1) % points.length], thicknessM: 0.12,
    material: 'Warm White', structuralStatus: 'UNKNOWN', confidence: 0.55, openings: []
  }));
}
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function numeric(value: unknown): number | null { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function pointsFrom(value: unknown): Point[] | null {
  if (!Array.isArray(value)) return null;
  const points = value.map((point) => Array.isArray(point) && point.length >= 2 ? [Number(point[0]), Number(point[1])] as Point : null);
  return points.every(Boolean) && points.length >= 3 ? points as Point[] : null;
}
function translateModelRoom(raw: Record<string, unknown>, fallbackId: string, fallbackName: string, dx: number) {
  const polygon = pointsFrom(raw.floorPolygon) ?? [[0,0],[3.5,0],[3.5,3],[0,3]] as Point[];
  const translated = polygon.map(([x,y]) => [x + dx, y] as Point);
  const rawWalls = Array.isArray(raw.walls) ? raw.walls as Array<Record<string, unknown>> : [];
  const walls = rawWalls.length ? rawWalls.map((wall, index) => {
    const start = Array.isArray(wall.start) ? [Number(wall.start[0]) + dx, Number(wall.start[1])] as Point : translated[index % translated.length];
    const end = Array.isArray(wall.end) ? [Number(wall.end[0]) + dx, Number(wall.end[1])] as Point : translated[(index + 1) % translated.length];
    return { ...wall, id: String(wall.id ?? `${fallbackId}-wall-${index + 1}`), start, end, openings: Array.isArray(wall.openings) ? wall.openings : [] };
  }) : polygonWalls(fallbackId, translated);
  return {
    ...raw, id: String(raw.id ?? fallbackId), name: String(raw.name ?? fallbackName), floorId: String(raw.floorId ?? 'floor-1'),
    heightM: numeric(raw.heightM) ?? 2.8, floorPolygon: translated, walls, objects: Array.isArray(raw.objects) ? raw.objects : [],
    scaleStatus: String(raw.scaleStatus ?? 'MEASURED_DRAFT'), verificationStatus: 'DESIGNER_REVIEW_REQUIRED', confidence: numeric(raw.confidence) ?? 0.55
  };
}
async function modelFromCapture(captureId: string, organizationId: string) {
  const capture = await prisma.captureSession.findFirst({
    where: { id: captureId, unit: { property: { organizationId } } },
    include: { rooms: { orderBy: { sortOrder: 'asc' } }, assets: true, connections: true, unit: { include: { property: true } } }
  });
  if (!capture) return null;
  let cursorX = 0;
  const rooms = capture.rooms.map((room) => {
    const existing = asRecord(room.roomModel);
    const measurements = asRecord(room.measurements);
    let raw: Record<string, unknown>;
    if (existing) raw = existing;
    else {
      const polygon = pointsFrom(room.floorPolygon) ?? (() => {
        const length = numeric(measurements?.lengthM) ?? 3.5; const width = numeric(measurements?.widthM) ?? 3;
        return [[0,0],[length,0],[length,width],[0,width]] as Point[];
      })();
      raw = { id: room.id, name: room.name, heightM: room.ceilingHeightM ?? 2.8, floorPolygon: polygon, walls: polygonWalls(room.id, polygon), objects: [] };
    }
    const translated = translateModelRoom(raw, room.id, room.name, cursorX);
    const xs = translated.floorPolygon.map(([x]: Point) => x);
    cursorX = Math.max(...xs) + 1.2;
    const evidenceRefs = capture.assets.filter((asset) => asset.roomId === room.id).map((asset) => asset.id);
    return { ...translated, evidenceRefs, confidence: evidenceRefs.length ? Math.max(Number(translated.confidence), 0.62) : translated.confidence };
  });
  return {
    capture,
    model: {
      schemaVersion: '2.1', units: 'meters', coordinateSystem: 'RIGHT_HANDED_Y_UP',
      floors: [{ id: 'floor-1', name: 'Floor 1', elevationM: 0, roomIds: rooms.map((room) => room.id) }], rooms,
      metadata: {
        source: 'capture_to_canonical_model', captureId, geometryStatus: 'DRAFT_MODEL', verificationStatus: 'DESIGNER_REVIEW_REQUIRED',
        sourceEvidencePreserved: true, structuralVerificationRequired: true, generatedAt: new Date().toISOString(),
        capturePlatform: capture.platform, captureAssetCount: capture.assets.length
      }
    }
  };
}
function xmlEscape(value: unknown): string { return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('\"','&quot;').replaceAll("'",'&apos;'); }
function floorplanSvg(model: z.infer<typeof modelSchema>): string {
  const points = model.rooms.flatMap((room) => room.floorPolygon);
  const minX = Math.min(...points.map((p) => p[0])); const minY = Math.min(...points.map((p) => p[1]));
  const maxX = Math.max(...points.map((p) => p[0])); const maxY = Math.max(...points.map((p) => p[1]));
  const scale = 100; const pad = 40; const width = Math.max(300, (maxX-minX)*scale+pad*2); const height = Math.max(300,(maxY-minY)*scale+pad*2);
  const roomSvg = model.rooms.map((room) => {
    const coords = room.floorPolygon.map(([x,y]) => `${pad+(x-minX)*scale},${height-pad-(y-minY)*scale}`).join(' ');
    const cx = room.floorPolygon.reduce((sum,p)=>sum+p[0],0)/room.floorPolygon.length; const cy = room.floorPolygon.reduce((sum,p)=>sum+p[1],0)/room.floorPolygon.length;
    return `<polygon points="${coords}" fill="#f5f1e8" stroke="#17233b" stroke-width="8"/><text x="${pad+(cx-minX)*scale}" y="${height-pad-(cy-minY)*scale}" text-anchor="middle" font-family="Arial" font-size="22" fill="#17233b">${xmlEscape(room.name)}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/>${roomSvg}<text x="${pad}" y="25" font-family="Arial" font-size="14" fill="#6b7280">PropertyTour360 · Draft floor plan · Verify dimensions on site</text></svg>`;
}

export async function designRoutes(app: FastifyInstance) {
  app.get('/v1/design-projects', { preHandler: [app.authenticate] }, async (request) => prisma.designProject.findMany({
    where: { unit: { property: { organizationId: request.user.organizationId } } },
    include: { unit: { include: { property: true } }, capture: true, versions: { orderBy: { version: 'desc' }, take: 5 }, comments: true, approvals: true },
    orderBy: { createdAt: 'desc' }
  }));

  app.post('/v1/design-projects', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const body = z.object({ captureId: z.string(), name: z.string().min(2).max(150), model: modelSchema.optional(), generateGeometry: z.boolean().default(true) }).parse(request.body);
      const built = await modelFromCapture(body.captureId, request.user.organizationId);
      if (!built) return notFound(reply, 'Capture');
      if (built.capture.mode !== 'DESIGN_SCAN') return reply.code(409).send({ error: 'CAPTURE_IS_NOT_DESIGN_SCAN' });
      const model = body.model ?? modelSchema.parse(built.model);
      const project = await prisma.designProject.create({
        data: {
          unitId: built.capture.unitId, captureId: built.capture.id, name: body.name, slug: makeSlug(body.name), model: asJson(model),
          geometryStatus: 'DRAFT_MODEL', verificationStatus: 'UNCONFIRMED',
          versions: { create: { version: 1, model: asJson(model), createdById: request.user.userId, notes: 'Initial capture-derived model', label: 'Capture draft' } }
        }, include: { versions: true }
      });
      const measurementRows = model.rooms.flatMap((modelRoom) => (modelRoom.measurements ?? []).map((measurement) => ({ roomId: modelRoom.id, measurement })));
      for (const row of measurementRows) {
        const measurement = row.measurement as Record<string, unknown>;
        await prisma.measurement.create({ data: {
          roomId: row.roomId, label: String(measurement.label ?? 'Measurement'), valueM: Number(measurement.valueM ?? 0),
          startPoint: measurement.start ? asJson(measurement.start) : undefined, endPoint: measurement.end ? asJson(measurement.end) : undefined,
          method: String(measurement.method ?? 'ANDROID_FIELD_CONFIRMATION'), toleranceM: measurement.toleranceM == null ? null : Number(measurement.toleranceM),
          verificationStatus: String(measurement.verificationStatus ?? (measurement.verified === true ? 'OPERATOR_CONFIRMED' : 'UNVERIFIED')),
          evidenceRefs: asJson(measurement.evidenceRefs ?? []), acquiredById: request.user.userId,
          acquiredAt: measurement.capturedAtEpochMs ? new Date(Number(measurement.capturedAtEpochMs)) : new Date()
        } });
      }
      if (!body.generateGeometry) {
        return reply.code(201).send({
          ...project,
          status: 'DRAFT',
          geometryStatus: 'DRAFT_MODEL',
          verificationStatus: 'UNCONFIRMED'
        });
      }
      const job = await prisma.processingJob.create({ data: { type: 'MODEB_GEOMETRY', designProjectId: project.id, captureId: project.captureId, status: 'QUEUED' } });
      const queued = await prisma.designProject.update({
        where: { id: project.id },
        data: { status: 'MODEL_GENERATING', geometryStatus: 'PROCESSING' }
      });
      await visionQueue.add('MODEB_GEOMETRY', { jobId: job.id }, { attempts: 2, backoff: { type: 'exponential', delay: 5000 } });
      return reply.code(201).send({
        ...project,
        status: queued.status,
        geometryStatus: 'QUEUED',
        verificationStatus: queued.verificationStatus,
        geometryJobId: job.id
      });
    } catch (error) { return badRequest(reply, error); }
  });

  app.get('/v1/design-projects/:projectId', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await prisma.designProject.findFirst({
      where: { id: projectId, unit: { property: { organizationId: request.user.organizationId } } },
      include: { unit: { include: { property: true } }, capture: { include: { assets: true, rooms: true, connections: true, capturePackages: true } }, versions: { orderBy: { version: 'desc' } }, jobs: { orderBy: { createdAt: 'desc' } }, comments: { orderBy: { createdAt: 'desc' } }, approvals: { orderBy: { createdAt: 'desc' } }, options: { orderBy: { createdAt: 'asc' } }, reviews: { orderBy: { createdAt: 'desc' } }, exports: { orderBy: { createdAt: 'desc' } }, shareLinks: { orderBy: { createdAt: 'desc' } } }
    });
    return project ? reply.send(project) : notFound(reply, 'Design project');
  });

  app.put('/v1/design-projects/:projectId/model', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string }; const existing = await getDesignProjectForOrganization(projectId, request.user.organizationId);
      if (!existing) return notFound(reply, 'Design project');
      const body = z.object({ model: modelSchema, notes: z.string().max(500).optional(), label: z.string().max(80).optional(), expectedVersion: z.number().int().positive().optional() }).parse(request.body);
      if (body.expectedVersion && body.expectedVersion !== existing.activeVersion) return reply.code(409).send({ error: 'MODEL_VERSION_CONFLICT', activeVersion: existing.activeVersion });
      const nextVersion = existing.activeVersion + 1;
      const updated = await prisma.$transaction(async (tx) => {
        await tx.designVersion.create({ data: { projectId, version: nextVersion, model: asJson(body.model), notes: body.notes, label: body.label, createdById: request.user.userId } });
        return tx.designProject.update({ where: { id: projectId }, data: { model: asJson(body.model), activeVersion: nextVersion, status: 'DESIGNER_CORRECTION', generatedGlbKey: null, verificationStatus: 'UNCONFIRMED' } });
      });
      return reply.send(updated);
    } catch (error) { return badRequest(reply, error); }
  });

  app.post('/v1/design-projects/:projectId/generate-geometry', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string }; const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
    if (!project) return notFound(reply, 'Design project');
    const job = await prisma.processingJob.create({ data: { type: 'MODEB_GEOMETRY', designProjectId: project.id, captureId: project.captureId, status: 'QUEUED' } });
    await prisma.designProject.update({ where: { id: project.id }, data: { status: 'MODEL_GENERATING' } });
    await visionQueue.add('MODEB_GEOMETRY', { jobId: job.id }, { attempts: 2, backoff: { type: 'exponential', delay: 5000 } });
    return reply.code(202).send({ jobId: job.id });
  });

  app.post('/v1/design-projects/:projectId/confirm', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string }; const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
      if (!project) return notFound(reply, 'Design project');
      const body = z.object({ status: z.enum(['DESIGNER_CONFIRMED', 'SITE_VERIFIED']), note: z.string().max(500).optional() }).parse(request.body);
      const model = modelSchema.parse(project.model); const metadata = { ...(model.metadata ?? {}), geometryStatus: body.status === 'SITE_VERIFIED' ? 'SITE_VERIFIED_MODEL' : 'DESIGNER_CONFIRMED_MODEL', verificationStatus: body.status, confirmedAt: new Date().toISOString(), confirmedBy: request.user.userId };
      const nextVersion = project.activeVersion + 1; const confirmed = { ...model, metadata };
      const updated = await prisma.$transaction(async (tx) => {
        await tx.designVersion.create({ data: { projectId, version: nextVersion, model: asJson(confirmed), notes: body.note ?? `Marked ${body.status}`, label: body.status, createdById: request.user.userId } });
        return tx.designProject.update({ where: { id: projectId }, data: { model: asJson(confirmed), activeVersion: nextVersion, verificationStatus: body.status, geometryStatus: String(metadata.geometryStatus), status: 'DESIGNER_CONFIRMED', generatedGlbKey: null } });
      });
      return reply.send(updated);
    } catch (error) { return badRequest(reply, error); }
  });

  app.post('/v1/design-projects/:projectId/generate-shell', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string }; const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
    if (!project) return notFound(reply, 'Design project');
    const job = await prisma.processingJob.create({ data: { type: 'EXPORT_PARAMETRIC_SHELL_GLB', designProjectId: project.id, captureId: project.captureId, status: 'QUEUED' } });
    await prisma.designProject.update({ where: { id: project.id }, data: { status: 'MODEL_GENERATING' } });
    await visionQueue.add('EXPORT_PARAMETRIC_SHELL_GLB', { jobId: job.id }, { attempts: 2, backoff: { type: 'exponential', delay: 5000 } });
    return reply.code(202).send({ jobId: job.id });
  });

  app.get('/v1/design-projects/:projectId/exports/floorplan.svg', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string }; const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
    if (!project) return notFound(reply, 'Design project');
    return reply.header('content-type','image/svg+xml').header('content-disposition',`attachment; filename="${project.slug}-floorplan.svg"`).send(floorplanSvg(modelSchema.parse(project.model)));
  });

  app.get('/v1/design-projects/:projectId/exports/schedule.csv', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string }; const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
    if (!project) return notFound(reply, 'Design project');
    const model = modelSchema.parse(project.model); const rows = ['room,object_id,name,type,width_m,depth_m,height_m,material'];
    for (const room of model.rooms) for (const raw of room.objects) {
      const size = Array.isArray(raw.size) ? raw.size : [0,0,0]; rows.push([room.name, raw.id ?? '', raw.name ?? '', raw.type ?? '', size[0] ?? 0, size[1] ?? 0, size[2] ?? 0, raw.material ?? ''].map((v)=>`"${String(v).replaceAll('"','""')}"`).join(','));
    }
    return reply.header('content-type','text/csv').header('content-disposition',`attachment; filename="${project.slug}-schedule.csv"`).send(rows.join('\n'));
  });

  app.post('/v1/design-projects/:projectId/comments', { preHandler: [app.authenticate] }, async (request, reply) => {
    try { const { projectId } = request.params as { projectId: string }; const project = await getDesignProjectForOrganization(projectId, request.user.organizationId); if (!project) return notFound(reply,'Design project');
      const body=z.object({body:z.string().min(1).max(2000),elementId:z.string().max(200).optional()}).parse(request.body); return reply.code(201).send(await prisma.designComment.create({data:{projectId,authorId:request.user.userId,body:body.body,elementId:body.elementId}}));
    } catch(error){return badRequest(reply,error);}
  });

  app.post('/v1/public/designs/:slug/approvals', async (request, reply) => {
    try { const {slug}=request.params as {slug:string}; const project=await prisma.designProject.findFirst({where:{slug,status:'PUBLISHED'}}); if(!project)return notFound(reply,'Published design');
      const body=z.object({decision:z.enum(['APPROVED','CHANGES_REQUESTED']),name:z.string().max(120).optional(),contact:z.string().max(180).optional(),note:z.string().max(1000).optional()}).parse(request.body);
      return reply.code(201).send(await prisma.designApproval.create({data:{projectId:project.id,version:project.activeVersion,...body}}));
    } catch(error){return badRequest(reply,error);}
  });

  app.post('/v1/design-projects/:projectId/unpublish', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
    if (!project) return notFound(reply, 'Design project');
    const updated = await prisma.designProject.update({ where: { id: projectId }, data: { status: 'READY', publishedAt: null } });
    return reply.send(updated);
  });

  app.post('/v1/design-projects/:projectId/publish', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await prisma.designProject.findFirst({ where: { id: projectId, unit: { property: { organizationId: request.user.organizationId } } }, include: { unit: { include: { property: true } } } });
    if (!project) return notFound(reply, 'Design project');
    if (!project.generatedGlbKey || project.status !== 'READY') return reply.code(409).send({ error: 'DESIGN_MODEL_NOT_READY' });
    if (!['DESIGNER_CONFIRMED','SITE_VERIFIED'].includes(project.verificationStatus)) return reply.code(409).send({ error: 'DESIGN_REQUIRES_CONFIRMATION' });
    const publicKey = `designs/${project.slug}/published-v${project.activeVersion}.glb`;
    await minio.copyObject(config.MINIO_BUCKET_PUBLIC, publicKey, `/${config.MINIO_BUCKET_PRIVATE}/${project.generatedGlbKey}`);
    const model = modelSchema.parse(project.model);
    const manifest = {
      version: '2.1', type: 'DESIGN_CONCEPT', projectId: project.id, slug: project.slug, name: project.name,
      modelUrl: publicAssetUrl(publicKey), verificationStatus: project.verificationStatus, geometryStatus: project.geometryStatus,
      property: { name: project.unit.property.name, address: project.unit.property.address, unitLabel: project.unit.label },
      rooms: model.rooms.map((room)=>({id:room.id,name:room.name,heightM:room.heightM})),
      disclaimer: 'Interior design visualization and space planning only. Structural work, fabrication dimensions, electrical/plumbing work and regulatory compliance require qualified professional verification.'
    };
    const updated = await prisma.designProject.update({ where: { id: project.id }, data: { status: 'PUBLISHED', publicManifest: asJson(manifest), publishedAt: new Date() } });
    return reply.send({ ...updated, publicUrl: `/design/${project.slug}` });
  });
}
