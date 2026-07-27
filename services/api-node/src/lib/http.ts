import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';

export function badRequest(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: 'VALIDATION_ERROR', details: error.flatten() });
  }
  const message = error instanceof Error ? error.message : 'Invalid request';
  return reply.code(400).send({ error: 'BAD_REQUEST', message });
}

export function notFound(reply: FastifyReply, resource = 'Resource') {
  return reply.code(404).send({ error: 'NOT_FOUND', message: `${resource} not found` });
}

export function forbidden(reply: FastifyReply) {
  return reply.code(403).send({ error: 'FORBIDDEN' });
}
