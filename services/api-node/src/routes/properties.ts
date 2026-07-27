import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/http.js';
import { asJson } from '../lib/json.js';

const propertyBody = z.object({
  name: z.string().min(2).max(150),
  address: z.string().min(3).max(500),
  propertyType: z.string().min(2).max(50),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  metadata: z.record(z.unknown()).optional()
});

export async function propertyRoutes(app: FastifyInstance) {
  app.get('/v1/properties', { preHandler: [app.authenticate] }, async (request) => {
    return prisma.property.findMany({
      where: { organizationId: request.user.organizationId },
      include: { units: true },
      orderBy: { createdAt: 'desc' }
    });
  });

  app.post('/v1/properties', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const body = propertyBody.parse(request.body);
      const property = await prisma.property.create({
        data: {
          organizationId: request.user.organizationId,
          name: body.name,
          address: body.address,
          propertyType: body.propertyType,
          latitude: body.latitude,
          longitude: body.longitude,
          metadata: body.metadata ? asJson(body.metadata) : undefined
        }
      });
      await audit({
        organizationId: request.user.organizationId,
        actorId: request.user.userId,
        entityType: 'Property',
        entityId: property.id,
        action: 'CREATE'
      });
      return reply.code(201).send(property);
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.get('/v1/properties/:propertyId', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { propertyId } = request.params as { propertyId: string };
    const property = await prisma.property.findFirst({
      where: { id: propertyId, organizationId: request.user.organizationId },
      include: { units: true }
    });
    return property ? reply.send(property) : notFound(reply, 'Property');
  });

  app.post('/v1/properties/:propertyId/units', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { propertyId } = request.params as { propertyId: string };
      const property = await prisma.property.findFirst({
        where: { id: propertyId, organizationId: request.user.organizationId }
      });
      if (!property) return notFound(reply, 'Property');
      const body = z
        .object({
          label: z.string().min(1).max(100),
          bedrooms: z.number().int().min(0).max(30).optional(),
          bathrooms: z.number().int().min(0).max(30).optional(),
          areaSqFt: z.number().positive().optional(),
          price: z.number().nonnegative().optional(),
          availability: z.string().max(100).optional(),
          metadata: z.record(z.unknown()).optional()
        })
        .parse(request.body);
      const unit = await prisma.unit.create({
        data: {
          propertyId,
          label: body.label,
          bedrooms: body.bedrooms,
          bathrooms: body.bathrooms,
          areaSqFt: body.areaSqFt,
          price: body.price,
          availability: body.availability,
          metadata: body.metadata ? asJson(body.metadata) : undefined
        }
      });
      await audit({
        organizationId: request.user.organizationId,
        actorId: request.user.userId,
        entityType: 'Unit',
        entityId: unit.id,
        action: 'CREATE'
      });
      return reply.code(201).send(unit);
    } catch (error) {
      return badRequest(reply, error);
    }
  });
}
