import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { finalizeCaptureAssetUpload } from '../lib/capture-assets.js';
import { badRequest, notFound } from '../lib/http.js';
import { minio, minioSigner } from '../lib/minio.js';
import { prisma } from '../lib/prisma.js';
import {
  DEFAULT_CHUNK_SIZE_BYTES,
  MAX_CHUNK_SIZE_BYTES,
  MIN_CHUNK_SIZE_BYTES,
  expectedUploadPartSize,
  uploadPartCount,
  uploadRequestFingerprint
} from '../lib/resumable-upload.js';
import { safeObjectName } from '../lib/security.js';
import { getCaptureForOrganization } from '../lib/access.js';

const assetKind = z.enum([
  'PANORAMA', 'PHOTO', 'VIDEO', 'THUMBNAIL', 'AR_POSES', 'CAMERA_INTRINSICS', 'DEPTH_MAP',
  'DEPTH_CONFIDENCE', 'ROOMPLAN_USDZ', 'FLOORPLAN', 'GLB', 'DESIGN_PREVIEW', 'RGB_KEYFRAME',
  'AR_PLANES', 'CAPTURE_MANIFEST', 'MODEL_EVIDENCE', 'FLOORPLAN_SVG', 'DESIGN_RENDER',
  'DESIGN_EXPORT', 'OTHER'
]);

function serializeUpload(upload: {
  id: string;
  captureId: string;
  roomId: string | null;
  assetId: string;
  filename: string;
  mimeType: string;
  kind: string;
  totalSizeBytes: bigint;
  chunkSizeBytes: number;
  totalParts: number;
  checksumSha256: string | null;
  status: string;
  uploadedBytes: bigint;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  parts?: Array<{ partNumber: number; sizeBytes: bigint; checksumSha256: string | null; status: string; completedAt: Date | null }>;
}) {
  return {
    ...upload,
    totalSizeBytes: Number(upload.totalSizeBytes),
    uploadedBytes: Number(upload.uploadedBytes),
    parts: upload.parts?.map((part) => ({ ...part, sizeBytes: Number(part.sizeBytes) })) ?? []
  };
}

async function ownedUpload(captureId: string, uploadId: string, organizationId: string) {
  return prisma.resumableUpload.findFirst({
    where: {
      id: uploadId,
      captureId,
      capture: { unit: { property: { organizationId } } }
    },
    include: { parts: { orderBy: { partNumber: 'asc' } }, asset: true }
  });
}

export async function uploadRoutes(app: FastifyInstance) {
  app.get('/v2/captures/:captureId/uploads', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { captureId } = request.params as { captureId: string };
    const capture = await getCaptureForOrganization(captureId, request.user.organizationId);
    if (!capture) return notFound(reply, 'Capture');
    const uploads = await prisma.resumableUpload.findMany({
      where: { captureId },
      include: { parts: { orderBy: { partNumber: 'asc' } } },
      orderBy: { createdAt: 'desc' }
    });
    return uploads.map(serializeUpload);
  });

  app.post('/v2/captures/:captureId/uploads', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { captureId } = request.params as { captureId: string };
      const capture = await getCaptureForOrganization(captureId, request.user.organizationId);
      if (!capture) return notFound(reply, 'Capture');
      const idempotencyKey = String(request.headers['idempotency-key'] ?? '').trim();
      if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
        return reply.code(400).send({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
      }
      const body = z.object({
        roomId: z.string().optional(),
        kind: assetKind,
        filename: z.string().min(1).max(255),
        mimeType: z.string().min(3).max(150),
        sizeBytes: z.number().int().positive().max(8 * 1024 * 1024 * 1024),
        checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
        chunkSizeBytes: z.number().int().min(MIN_CHUNK_SIZE_BYTES).max(MAX_CHUNK_SIZE_BYTES).optional()
      }).parse(request.body);
      if (body.roomId) {
        const room = await prisma.room.findFirst({ where: { id: body.roomId, captureId } });
        if (!room) return notFound(reply, 'Room');
      }
      const chunkSizeBytes = body.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
      const fingerprint = uploadRequestFingerprint({ ...body, chunkSizeBytes });
      const existing = await prisma.resumableUpload.findUnique({
        where: { captureId_idempotencyKey: { captureId, idempotencyKey } },
        include: { parts: { orderBy: { partNumber: 'asc' } } }
      });
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) {
          return reply.code(409).send({ error: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_UPLOAD' });
        }
        return reply.send(serializeUpload(existing));
      }

      let spatialRoomId: string | undefined;
      if (body.roomId) {
        const room = await prisma.room.findFirst({ where: { id: body.roomId, captureId } });
        spatialRoomId = room?.spatialRoomId ?? undefined;
      }
      const finalObjectKey = `org/${request.user.organizationId}/capture/${captureId}/${nanoid(12)}-${safeObjectName(body.filename)}`;
      const totalParts = uploadPartCount(body.sizeBytes, chunkSizeBytes);
      const created = await prisma.$transaction(async (tx) => {
        const asset = await tx.asset.create({
          data: {
            captureId,
            roomId: body.roomId,
            spatialRoomId,
            kind: body.kind,
            objectKey: finalObjectKey,
            mimeType: body.mimeType,
            sizeBytes: BigInt(body.sizeBytes),
            status: 'PENDING',
            metadata: { originalFilename: body.filename, uploadMode: 'RESUMABLE_V1' }
          }
        });
        return tx.resumableUpload.create({
          data: {
            captureId,
            roomId: body.roomId,
            assetId: asset.id,
            idempotencyKey,
            requestFingerprint: fingerprint,
            filename: body.filename,
            mimeType: body.mimeType,
            kind: body.kind,
            totalSizeBytes: BigInt(body.sizeBytes),
            chunkSizeBytes,
            totalParts,
            checksumSha256: body.checksumSha256,
            status: 'CREATED'
          },
          include: { parts: true }
        });
      });
      await audit({
        organizationId: request.user.organizationId,
        actorId: request.user.userId,
        entityType: 'ResumableUpload',
        entityId: created.id,
        action: 'CREATE',
        payload: { captureId, assetId: created.assetId, totalParts, sizeBytes: body.sizeBytes, kind: body.kind }
      });
      return reply.code(201).send(serializeUpload(created));
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.get('/v2/captures/:captureId/uploads/:uploadId', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { captureId, uploadId } = request.params as { captureId: string; uploadId: string };
    const upload = await ownedUpload(captureId, uploadId, request.user.organizationId);
    return upload ? reply.send(serializeUpload(upload)) : notFound(reply, 'Upload');
  });

  app.post('/v2/captures/:captureId/uploads/:uploadId/parts/:partNumber/url', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { captureId, uploadId, partNumber: rawPart } = request.params as { captureId: string; uploadId: string; partNumber: string };
      const upload = await ownedUpload(captureId, uploadId, request.user.organizationId);
      if (!upload) return notFound(reply, 'Upload');
      if (upload.status === 'COMPLETED') return reply.code(409).send({ error: 'UPLOAD_ALREADY_COMPLETED' });
      const partNumber = z.coerce.number().int().parse(rawPart);
      const expectedBytes = expectedUploadPartSize(Number(upload.totalSizeBytes), upload.chunkSizeBytes, partNumber);
      const objectKey = `org/${request.user.organizationId}/capture/${captureId}/resumable/${upload.id}/part-${String(partNumber).padStart(6, '0')}`;
      const part = await prisma.resumableUploadPart.upsert({
        where: { uploadId_partNumber: { uploadId, partNumber } },
        create: { uploadId, partNumber, objectKey, sizeBytes: BigInt(expectedBytes) },
        update: { objectKey, sizeBytes: BigInt(expectedBytes) }
      });
      if (part.status === 'UPLOADED') {
        return reply.send({ partNumber, expectedBytes, alreadyUploaded: true, expiresInSeconds: 0 });
      }
      const uploadUrl = await minioSigner.presignedPutObject(config.MINIO_BUCKET_PRIVATE, objectKey, 60 * 60);
      return reply.send({ partNumber, expectedBytes, uploadUrl, expiresInSeconds: 3600, alreadyUploaded: false });
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.post('/v2/captures/:captureId/uploads/:uploadId/parts/:partNumber/complete', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      const { captureId, uploadId, partNumber: rawPart } = request.params as { captureId: string; uploadId: string; partNumber: string };
      const upload = await ownedUpload(captureId, uploadId, request.user.organizationId);
      if (!upload) return notFound(reply, 'Upload');
      const partNumber = z.coerce.number().int().parse(rawPart);
      const part = upload.parts.find((candidate) => candidate.partNumber === partNumber);
      if (!part) return notFound(reply, 'Upload part');
      if (part.status === 'UPLOADED') return reply.send({ partNumber, status: 'UPLOADED', sizeBytes: Number(part.sizeBytes) });
      const body = z.object({ checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional() }).parse(request.body ?? {});
      const stat = await minio.statObject(config.MINIO_BUCKET_PRIVATE, part.objectKey);
      const expectedBytes = expectedUploadPartSize(Number(upload.totalSizeBytes), upload.chunkSizeBytes, partNumber);
      if (stat.size !== expectedBytes) {
        return reply.code(409).send({ error: 'UPLOAD_PART_SIZE_MISMATCH', expectedBytes, actualBytes: stat.size });
      }
      await prisma.resumableUploadPart.update({
        where: { id: part.id },
        data: { status: 'UPLOADED', checksumSha256: body.checksumSha256, completedAt: new Date() }
      });
      const aggregate = await prisma.resumableUploadPart.aggregate({
        where: { uploadId, status: 'UPLOADED' },
        _sum: { sizeBytes: true }
      });
      const uploadedBytes = aggregate._sum.sizeBytes ?? BigInt(0);
      await prisma.resumableUpload.update({ where: { id: uploadId }, data: { status: 'UPLOADING', uploadedBytes } });
      return reply.send({ partNumber, status: 'UPLOADED', sizeBytes: expectedBytes, uploadedBytes: Number(uploadedBytes) });
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.post('/v2/captures/:captureId/uploads/:uploadId/complete', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { captureId, uploadId } = request.params as { captureId: string; uploadId: string };
    const upload = await ownedUpload(captureId, uploadId, request.user.organizationId);
    if (!upload) return notFound(reply, 'Upload');
    if (upload.status === 'COMPLETED') {
      return reply.send({ upload: serializeUpload(upload), asset: upload.asset });
    }
    const parts = upload.parts.filter((part) => part.status === 'UPLOADED').sort((a, b) => a.partNumber - b.partNumber);
    if (parts.length !== upload.totalParts) {
      return reply.code(409).send({ error: 'UPLOAD_INCOMPLETE', uploadedParts: parts.length, totalParts: upload.totalParts });
    }
    for (let index = 0; index < parts.length; index += 1) {
      if (parts[index]?.partNumber !== index + 1) return reply.code(409).send({ error: 'UPLOAD_PART_SEQUENCE_INCOMPLETE' });
    }

    const digest = createHash('sha256');
    async function* content() {
      for (const part of parts) {
        const source = await minio.getObject(config.MINIO_BUCKET_PRIVATE, part.objectKey);
        for await (const chunk of source) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          digest.update(buffer);
          yield buffer;
        }
      }
    }

    try {
      await prisma.resumableUpload.update({ where: { id: upload.id }, data: { status: 'ASSEMBLING', lastError: null } });
      await minio.putObject(
        config.MINIO_BUCKET_PRIVATE,
        upload.asset.objectKey,
        Readable.from(content()),
        Number(upload.totalSizeBytes),
        { 'Content-Type': upload.mimeType }
      );
      const checksumSha256 = digest.digest('hex');
      if (upload.checksumSha256 && checksumSha256.toLowerCase() !== upload.checksumSha256.toLowerCase()) {
        await minio.removeObject(config.MINIO_BUCKET_PRIVATE, upload.asset.objectKey).catch(() => undefined);
        await prisma.resumableUpload.update({
          where: { id: upload.id },
          data: { status: 'FAILED', lastError: 'WHOLE_FILE_CHECKSUM_MISMATCH' }
        });
        return reply.code(409).send({ error: 'WHOLE_FILE_CHECKSUM_MISMATCH' });
      }
      const asset = await finalizeCaptureAssetUpload(captureId, upload.assetId, checksumSha256);
      if (!asset) return notFound(reply, 'Asset');
      const completed = await prisma.resumableUpload.update({
        where: { id: upload.id },
        data: {
          status: 'COMPLETED',
          uploadedBytes: upload.totalSizeBytes,
          checksumSha256,
          completedAt: new Date(),
          lastError: null
        },
        include: { parts: { orderBy: { partNumber: 'asc' } } }
      });
      for (const part of parts) {
        await minio.removeObject(config.MINIO_BUCKET_PRIVATE, part.objectKey).catch(() => undefined);
      }
      await audit({
        organizationId: request.user.organizationId,
        actorId: request.user.userId,
        entityType: 'ResumableUpload',
        entityId: upload.id,
        action: 'COMPLETE',
        payload: { captureId, assetId: upload.assetId, checksumSha256, parts: upload.totalParts }
      });
      return reply.send({ upload: serializeUpload(completed), asset });
    } catch (error) {
      await prisma.resumableUpload.update({
        where: { id: upload.id },
        data: { status: 'FAILED', lastError: error instanceof Error ? error.message.slice(0, 1000) : 'ASSEMBLY_FAILED' }
      }).catch(() => undefined);
      request.log.error(error);
      return reply.code(500).send({ error: 'UPLOAD_ASSEMBLY_FAILED' });
    }
  });

  app.post('/v2/captures/:captureId/uploads/:uploadId/cancel', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { captureId, uploadId } = request.params as { captureId: string; uploadId: string };
    const upload = await ownedUpload(captureId, uploadId, request.user.organizationId);
    if (!upload) return notFound(reply, 'Upload');
    if (upload.status === 'COMPLETED') return reply.code(409).send({ error: 'UPLOAD_ALREADY_COMPLETED' });
    for (const part of upload.parts) await minio.removeObject(config.MINIO_BUCKET_PRIVATE, part.objectKey).catch(() => undefined);
    await prisma.asset.delete({ where: { id: upload.assetId } });
    return reply.code(204).send();
  });
}
