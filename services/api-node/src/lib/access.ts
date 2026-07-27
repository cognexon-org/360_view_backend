import { prisma } from './prisma.js';

export async function getUnitForOrganization(unitId: string, organizationId: string) {
  return prisma.unit.findFirst({
    where: { id: unitId, property: { organizationId } },
    include: { property: true }
  });
}

export async function getCaptureForOrganization(captureId: string, organizationId: string) {
  return prisma.captureSession.findFirst({
    where: { id: captureId, unit: { property: { organizationId } } },
    include: { unit: { include: { property: true } } }
  });
}

export async function getTourForOrganization(tourId: string, organizationId: string) {
  return prisma.tour.findFirst({
    where: { id: tourId, unit: { property: { organizationId } } }
  });
}

export async function getDesignProjectForOrganization(projectId: string, organizationId: string) {
  return prisma.designProject.findFirst({
    where: { id: projectId, unit: { property: { organizationId } } }
  });
}
