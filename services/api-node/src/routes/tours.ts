import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getCaptureForOrganization, getTourForOrganization } from '../lib/access.js';
import { badRequest, notFound } from '../lib/http.js';
import { makeSlug } from '../lib/slug.js';
import { buildTourManifest } from '../lib/manifest.js';
import { config } from '../config.js';
import { minio } from '../lib/minio.js';
import { asJson } from '../lib/json.js';
import { audit } from '../lib/audit.js';

export async function tourRoutes(app: FastifyInstance) {
  app.get('/v1/tours', { preHandler: [app.authenticate] }, async (request) => {
    return prisma.tour.findMany({
      where: { unit: { property: { organizationId: request.user.organizationId } } },
      include: { unit: { include: { property: true } }, capture: true, hotspots: true },
      orderBy: { createdAt: 'desc' }
    });
  });

  app.post('/v1/tours', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const body = z
        .object({
          captureId: z.string(),
          title: z.string().min(2).max(150),
          verificationLabel: z.enum([
            'ACTUAL_UNIT', 'SAMPLE_FLAT', 'CGI_RENDER', 'PHOTO_STORY', 'VIDEO_TOUR',
            'PANORAMA_TOUR', 'RECONSTRUCTED_3D', 'DESIGN_CONCEPT'
          ]).default('PANORAMA_TOUR'),
          captureDate: z.coerce.date().optional()
        })
        .parse(request.body);
      const capture = await getCaptureForOrganization(body.captureId, request.user.organizationId);
      if (!capture) return notFound(reply, 'Capture');
      const tour = await prisma.tour.create({
        data: {
          unitId: capture.unitId,
          captureId: capture.id,
          title: body.title,
          slug: makeSlug(body.title),
          verificationLabel: body.verificationLabel,
          captureDate: body.captureDate ?? capture.completedAt ?? new Date()
        }
      });
      return reply.code(201).send(tour);
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.get('/v1/tours/:tourId', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { tourId } = request.params as { tourId: string };
    const tour = await prisma.tour.findFirst({
      where: { id: tourId, unit: { property: { organizationId: request.user.organizationId } } },
      include: {
        unit: { include: { property: true } },
        capture: { include: { rooms: { orderBy: { sortOrder: 'asc' } }, assets: true } },
        hotspots: true
      }
    });
    return tour ? reply.send(tour) : notFound(reply, 'Tour');
  });

  app.post('/v1/tours/:tourId/hotspots', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { tourId } = request.params as { tourId: string };
      const tour = await getTourForOrganization(tourId, request.user.organizationId);
      if (!tour) return notFound(reply, 'Tour');
      const body = z.object({
        fromRoomId: z.string(),
        toRoomId: z.string(),
        yaw: z.number().min(-Math.PI * 2).max(Math.PI * 2),
        pitch: z.number().min(-Math.PI / 2).max(Math.PI / 2),
        label: z.string().min(1).max(100)
      }).parse(request.body);
      const count = await prisma.room.count({
        where: { id: { in: [body.fromRoomId, body.toRoomId] }, captureId: tour.captureId }
      });
      if (count !== 2) return reply.code(400).send({ error: 'ROOMS_NOT_IN_TOUR_CAPTURE' });
      const hotspot = await prisma.hotspot.create({ data: { tourId, ...body } });
      return reply.code(201).send(hotspot);
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.post('/v1/tours/:tourId/publish', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { tourId } = request.params as { tourId: string };
    const tour = await prisma.tour.findFirst({
      where: { id: tourId, unit: { property: { organizationId: request.user.organizationId } } },
      include: {
        unit: { include: { property: true } },
        capture: { include: { rooms: { orderBy: { sortOrder: 'asc' } }, assets: true } },
        hotspots: true
      }
    });
    if (!tour) return notFound(reply, 'Tour');
    if (tour.capture.status !== 'READY') {
      return reply.code(409).send({ error: 'CAPTURE_NOT_READY', captureStatus: tour.capture.status });
    }

    const approvedPanoramas = new Map(
      tour.capture.assets
        .filter((asset) => asset.kind === 'PANORAMA' && asset.status === 'APPROVED')
        .map((asset) => [asset.id, asset])
    );
    const rooms = tour.capture.rooms.map((room) => ({
      id: room.id,
      name: room.name,
      panorama: room.panoramaAssetId ? approvedPanoramas.get(room.panoramaAssetId) ?? null : null
    }));
    const roomsWithoutPanorama = rooms.filter((room) => !room.panorama);
    if (roomsWithoutPanorama.length > 0) {
      return reply.code(409).send({
        error: 'ROOM_PANORAMA_MISSING_OR_NOT_APPROVED',
        rooms: roomsWithoutPanorama.map((room) => ({ id: room.id, name: room.name }))
      });
    }

    const publicRooms = [] as typeof rooms;
    for (const room of rooms) {
      if (!room.panorama) {
        publicRooms.push(room);
        continue;
      }
      const extension = room.panorama.objectKey.includes('.')
        ? room.panorama.objectKey.split('.').pop()!.toLowerCase()
        : 'jpg';
      const publicObjectKey = `tours/${tour.slug}/rooms/${room.id}.${extension}`;
      const source = await minio.getObject(config.MINIO_BUCKET_PRIVATE, room.panorama.objectKey);
      const stat = await minio.statObject(config.MINIO_BUCKET_PRIVATE, room.panorama.objectKey);
      await minio.putObject(
        config.MINIO_BUCKET_PUBLIC,
        publicObjectKey,
        source,
        stat.size,
        { 'Content-Type': room.panorama.mimeType, 'Cache-Control': 'public, max-age=31536000, immutable' }
      );
      publicRooms.push({ ...room, panorama: { ...room.panorama, objectKey: publicObjectKey } });
    }

    const manifest = buildTourManifest({
      tourId: tour.id,
      title: tour.title,
      slug: tour.slug,
      verificationLabel: tour.verificationLabel,
      captureDate: tour.captureDate,
      rooms: publicRooms,
      hotspots: tour.hotspots,
      unit: tour.unit
    });
    const manifestKey = `tours/${tour.slug}/manifest.json`;
    await minio.putObject(
      config.MINIO_BUCKET_PUBLIC,
      manifestKey,
      Buffer.from(JSON.stringify(manifest, null, 2)),
      undefined,
      { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
    );
    const updated = await prisma.tour.update({
      where: { id: tour.id },
      data: { status: 'PUBLISHED', manifest: asJson(manifest), publishedAt: new Date() }
    });
    await prisma.captureSession.update({ where: { id: tour.captureId }, data: { status: 'PUBLISHED' } });
    await audit({
      organizationId: request.user.organizationId,
      actorId: request.user.userId,
      entityType: 'Tour',
      entityId: tour.id,
      action: 'PUBLISH',
      payload: { slug: tour.slug }
    });
    return reply.send({ ...updated, publicUrl: `/t/${tour.slug}`, manifestUrl: `${config.MINIO_PUBLIC_BASE_URL}/${manifestKey}` });
  });
}
