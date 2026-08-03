import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { badRequest, notFound } from '../lib/http.js';
import { asJson } from '../lib/json.js';

export async function publicRoutes(app: FastifyInstance) {
  app.get('/v1/public/tours/:slug/manifest', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const tour = await prisma.tour.findFirst({ where: { slug, status: 'PUBLISHED' } });
    if (!tour?.manifest) return notFound(reply, 'Published tour');
    return reply.header('cache-control', 'public, max-age=300').send(tour.manifest);
  });

  app.post('/v1/public/tours/:slug/leads', async (request, reply) => {
    try {
      const { slug } = request.params as { slug: string };
      const tour = await prisma.tour.findFirst({ where: { slug, status: 'PUBLISHED' } });
      if (!tour) return notFound(reply, 'Published tour');
      const body = z.object({
        name: z.string().max(100).optional(),
        phone: z.string().max(25).optional(),
        email: z.string().email().optional(),
        action: z.enum(['WHATSAPP', 'CALL', 'ENQUIRY', 'BOOK_VISIT']),
        consent: z.literal(true),
        metadata: z.record(z.unknown()).optional()
      }).parse(request.body);
      const lead = await prisma.lead.create({
        data: {
          tourId: tour.id,
          name: body.name,
          phone: body.phone,
          email: body.email,
          action: body.action,
          consent: body.consent,
          metadata: body.metadata ? asJson(body.metadata) : undefined
        }
      });
      return reply.code(201).send({ id: lead.id, createdAt: lead.createdAt });
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.get('/v1/public/designs/:slug/manifest', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const project = await prisma.designProject.findFirst({ where: { slug, status: 'PUBLISHED' } });
    if (!project?.publicManifest) return notFound(reply, 'Published design');
    return reply.header('cache-control', 'public, max-age=300').send(project.publicManifest);
  });

  app.get('/v2/public/design-links/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const link = await prisma.clientShareLink.findFirst({
      where: { slug, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      include: { project: { include: { unit: { include: { property: true } }, options: true } } }
    });
    if (!link) return notFound(reply, 'Design share link');
    const project = link.project;
    const option = link.designOptionId ? project.options.find((item) => item.id === link.designOptionId) : null;
    return reply.header('cache-control', 'private, max-age=60').send({
      id: link.id, slug: link.slug, version: link.version, permissions: link.permissions,
      project: { id: project.id, name: project.name, verificationStatus: project.verificationStatus, geometryStatus: project.geometryStatus },
      property: { name: project.unit.property.name, address: project.unit.property.address, unitLabel: project.unit.label },
      model: option?.model ?? project.model,
      disclaimer: 'Interior design visualization and space planning only. Verify dimensions, structure, services and regulatory requirements with qualified professionals.'
    });
  });


  app.post('/v2/public/design-links/:slug/comments', async (request, reply) => {
    try {
      const { slug } = request.params as { slug: string };
      const link = await prisma.clientShareLink.findFirst({ where: { slug, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } });
      if (!link) return notFound(reply, 'Design share link');
      const permissions = (link.permissions ?? {}) as Record<string, unknown>;
      if (permissions.comment === false) return reply.code(403).send({ error: 'COMMENT_NOT_ALLOWED' });
      const body = z.object({ body: z.string().min(1).max(2000), elementId: z.string().max(200).optional() }).parse(request.body);
      return reply.code(201).send(await prisma.designComment.create({ data: { projectId: link.projectId, body: body.body, elementId: body.elementId } }));
    } catch (error) { return badRequest(reply, error); }
  });

  app.post('/v2/public/design-links/:slug/approvals', async (request, reply) => {
    try {
      const { slug } = request.params as { slug: string };
      const link = await prisma.clientShareLink.findFirst({ where: { slug, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } });
      if (!link) return notFound(reply, 'Design share link');
      const permissions = (link.permissions ?? {}) as Record<string, unknown>;
      if (permissions.approve === false) return reply.code(403).send({ error: 'APPROVAL_NOT_ALLOWED' });
      const body = z.object({ decision: z.enum(['APPROVED','CHANGES_REQUESTED']), name: z.string().max(120).optional(), contact: z.string().max(180).optional(), note: z.string().max(1000).optional() }).parse(request.body);
      return reply.code(201).send(await prisma.designApproval.create({ data: { projectId: link.projectId, version: link.version, ...body } }));
    } catch (error) { return badRequest(reply, error); }
  });

}
