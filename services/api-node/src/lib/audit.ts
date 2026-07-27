import { prisma } from './prisma.js';

export async function audit(params: {
  organizationId: string;
  actorId?: string;
  entityType: string;
  entityId: string;
  action: string;
  payload?: unknown;
}) {
  await prisma.auditEvent.create({
    data: {
      organizationId: params.organizationId,
      actorId: params.actorId,
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      payload: params.payload as object | undefined
    }
  });
}
