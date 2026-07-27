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
}
