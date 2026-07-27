import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getCaptureForOrganization, getDesignProjectForOrganization } from '../lib/access.js';
import { badRequest, notFound } from '../lib/http.js';
import { asJson } from '../lib/json.js';
import { makeSlug } from '../lib/slug.js';
import { visionQueue } from '../lib/queue.js';
import { publicAssetUrl } from '../lib/minio.js';

const modelSchema = z.object({
  units: z.literal('meters').default('meters'),
  rooms: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    heightM: z.number().positive().max(20),
    floorPolygon: z.array(z.tuple([z.number(), z.number()])).min(3),
    walls: z.array(z.object({
      id: z.string(),
      start: z.tuple([z.number(), z.number()]),
      end: z.tuple([z.number(), z.number()]),
      thicknessM: z.number().positive().max(1).default(0.12),
      material: z.string().optional(),
      structuralStatus: z.enum(['UNKNOWN', 'NON_STRUCTURAL', 'STRUCTURAL']).default('UNKNOWN'),
      openings: z.array(z.object({
        id: z.string(),
        type: z.enum(['DOOR', 'WINDOW', 'OPENING']),
        offsetM: z.number().nonnegative(),
        widthM: z.number().positive(),
        heightM: z.number().positive(),
        bottomM: z.number().nonnegative().default(0)
      })).default([])
    })),
    objects: z.array(z.record(z.unknown())).default([])
  })).min(1),
  metadata: z.record(z.unknown()).optional()
});

export async function designRoutes(app: FastifyInstance) {
  app.get('/v1/design-projects', { preHandler: [app.authenticate] }, async (request) => {
    return prisma.designProject.findMany({
      where: { unit: { property: { organizationId: request.user.organizationId } } },
      include: { unit: { include: { property: true } }, capture: true, versions: { orderBy: { version: 'desc' }, take: 5 } },
      orderBy: { createdAt: 'desc' }
    });
  });

  app.post('/v1/design-projects', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const body = z.object({ captureId: z.string(), name: z.string().min(2).max(150), model: modelSchema }).parse(request.body);
      const capture = await getCaptureForOrganization(body.captureId, request.user.organizationId);
      if (!capture) return notFound(reply, 'Capture');
      if (capture.mode !== 'DESIGN_SCAN') return reply.code(409).send({ error: 'CAPTURE_IS_NOT_DESIGN_SCAN' });
      const project = await prisma.designProject.create({
        data: {
          unitId: capture.unitId,
          captureId: capture.id,
          name: body.name,
          slug: makeSlug(body.name),
          model: asJson(body.model),
          versions: {
            create: { version: 1, model: asJson(body.model), createdById: request.user.userId, notes: 'Initial model' }
          }
        },
        include: { versions: true }
      });
      return reply.code(201).send(project);
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.get('/v1/design-projects/:projectId', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await prisma.designProject.findFirst({
      where: { id: projectId, unit: { property: { organizationId: request.user.organizationId } } },
      include: { unit: { include: { property: true } }, capture: { include: { assets: true, rooms: true } }, versions: { orderBy: { version: 'desc' } }, jobs: true }
    });
    return project ? reply.send(project) : notFound(reply, 'Design project');
  });

  app.put('/v1/design-projects/:projectId/model', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      const existing = await getDesignProjectForOrganization(projectId, request.user.organizationId);
      if (!existing) return notFound(reply, 'Design project');
      const body = z.object({ model: modelSchema, notes: z.string().max(500).optional() }).parse(request.body);
      const nextVersion = existing.activeVersion + 1;
      const updated = await prisma.$transaction(async (tx) => {
        await tx.designVersion.create({
          data: { projectId, version: nextVersion, model: asJson(body.model), notes: body.notes, createdById: request.user.userId }
        });
        return tx.designProject.update({
          where: { id: projectId },
          data: { model: asJson(body.model), activeVersion: nextVersion, status: 'DRAFT' }
        });
      });
      return reply.send(updated);
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.post('/v1/design-projects/:projectId/generate-shell', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await getDesignProjectForOrganization(projectId, request.user.organizationId);
    if (!project) return notFound(reply, 'Design project');
    const job = await prisma.processingJob.create({
      data: { type: 'ROOM_SHELL', designProjectId: project.id, captureId: project.captureId, status: 'QUEUED' }
    });
    await prisma.designProject.update({ where: { id: project.id }, data: { status: 'GENERATING' } });
    await visionQueue.add('ROOM_SHELL', { jobId: job.id }, { attempts: 2, backoff: { type: 'exponential', delay: 5000 } });
    return reply.code(202).send({ jobId: job.id });
  });

  app.post('/v1/design-projects/:projectId/publish', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await prisma.designProject.findFirst({
      where: { id: projectId, unit: { property: { organizationId: request.user.organizationId } } },
      include: { unit: { include: { property: true } } }
    });
    if (!project) return notFound(reply, 'Design project');
    if (!project.generatedGlbKey || project.status !== 'READY') {
      return reply.code(409).send({ error: 'DESIGN_MODEL_NOT_READY' });
    }
    const manifest = {
      version: '1.0',
      type: 'DESIGN_CONCEPT',
      projectId: project.id,
      slug: project.slug,
      name: project.name,
      modelUrl: publicAssetUrl(project.generatedGlbKey),
      property: { name: project.unit.property.name, address: project.unit.property.address, unitLabel: project.unit.label },
      disclaimer: 'Conceptual interior design. Measurements and structural changes require professional verification.'
    };
    const updated = await prisma.designProject.update({
      where: { id: project.id },
      data: { status: 'PUBLISHED', publicManifest: asJson(manifest) }
    });
    return reply.send({ ...updated, publicUrl: `/design/${project.slug}` });
  });
}
