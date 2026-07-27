import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/http.js';

export async function organizationRoutes(app: FastifyInstance) {
  app.get('/v1/organization', { preHandler: [app.authenticate] }, async (request) => {
    return prisma.organization.findUnique({
      where: { id: request.user.organizationId },
      include: { users: { select: { id: true, phone: true, name: true, role: true } } }
    });
  });

  app.patch('/v1/organization', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { name } = z.object({ name: z.string().min(2).max(120) }).parse(request.body);
      const organization = await prisma.organization.update({
        where: { id: request.user.organizationId },
        data: { name }
      });
      await audit({
        organizationId: organization.id,
        actorId: request.user.userId,
        entityType: 'Organization',
        entityId: organization.id,
        action: 'UPDATE',
        payload: { name }
      });
      return reply.send(organization);
    } catch (error) {
      return badRequest(reply, error);
    }
  });
}
