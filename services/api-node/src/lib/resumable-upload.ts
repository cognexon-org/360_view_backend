import { createHash } from 'node:crypto';

export const DEFAULT_CHUNK_SIZE_BYTES = 5 * 1024 * 1024;
export const MIN_CHUNK_SIZE_BYTES = 512 * 1024;
export const MAX_CHUNK_SIZE_BYTES = 16 * 1024 * 1024;

export function uploadPartCount(totalSizeBytes: number, chunkSizeBytes: number): number {
  if (!Number.isSafeInteger(totalSizeBytes) || totalSizeBytes <= 0) throw new Error('INVALID_TOTAL_SIZE');
  if (!Number.isSafeInteger(chunkSizeBytes) || chunkSizeBytes <= 0) throw new Error('INVALID_CHUNK_SIZE');
  return Math.ceil(totalSizeBytes / chunkSizeBytes);
}

export function expectedUploadPartSize(totalSizeBytes: number, chunkSizeBytes: number, partNumber: number): number {
  const totalParts = uploadPartCount(totalSizeBytes, chunkSizeBytes);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > totalParts) throw new Error('INVALID_PART_NUMBER');
  const start = (partNumber - 1) * chunkSizeBytes;
  return Math.min(chunkSizeBytes, totalSizeBytes - start);
}

export function uploadRequestFingerprint(input: {
  roomId?: string | null;
  kind: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256?: string | null;
  chunkSizeBytes: number;
}): string {
  const canonical = [
    input.roomId ?? '',
    input.kind,
    input.filename,
    input.mimeType,
    String(input.sizeBytes),
    input.checksumSha256 ?? '',
    String(input.chunkSizeBytes)
  ].join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}
