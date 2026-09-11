import { describe, expect, it } from 'vitest';
import { expectedUploadPartSize, uploadPartCount, uploadRequestFingerprint } from '../resumable-upload.js';

describe('resumable upload helpers', () => {
  it('splits files into deterministic parts', () => {
    expect(uploadPartCount(11, 5)).toBe(3);
    expect(expectedUploadPartSize(11, 5, 1)).toBe(5);
    expect(expectedUploadPartSize(11, 5, 2)).toBe(5);
    expect(expectedUploadPartSize(11, 5, 3)).toBe(1);
  });

  it('rejects out-of-range part numbers', () => {
    expect(() => expectedUploadPartSize(10, 5, 0)).toThrow();
    expect(() => expectedUploadPartSize(10, 5, 3)).toThrow();
  });

  it('changes the idempotency fingerprint when upload semantics change', () => {
    const base = { roomId: 'room', kind: 'VIDEO', filename: 'walk.mp4', mimeType: 'video/mp4', sizeBytes: 100, checksumSha256: 'a'.repeat(64), chunkSizeBytes: 5 };
    expect(uploadRequestFingerprint(base)).toBe(uploadRequestFingerprint(base));
    expect(uploadRequestFingerprint({ ...base, sizeBytes: 101 })).not.toBe(uploadRequestFingerprint(base));
  });
});
