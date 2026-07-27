import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { notFound } from '../lib/http.js';

export async function jobRoutes(app: FastifyInstance) {
  app.get('/v1/jobs/:jobId', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = await prisma.processingJob.findFirst({
      where: {
        id: jobId,
        OR: [
          { capture: { unit: { property: { organizationId: request.user.organizationId } } } },
          { designProject: { unit: { property: { organizationId: request.user.organizationId } } } }
        ]
      }
    });
    return job ? reply.send(job) : notFound(reply, 'Job');
  });
}
