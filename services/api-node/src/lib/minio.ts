import { Client } from 'minio';
import { config } from '../config.js';

export const minio = new Client({
  endPoint: config.MINIO_ENDPOINT,
  port: config.MINIO_PORT,
  useSSL: config.MINIO_USE_SSL,
  accessKey: config.MINIO_ACCESS_KEY,
  secretKey: config.MINIO_SECRET_KEY
});

export function publicAssetUrl(objectKey: string): string {
  return `${config.MINIO_PUBLIC_BASE_URL.replace(/\/$/, '')}/${objectKey}`;
}

export const minioSigner = new Client({
  endPoint: config.MINIO_PRESIGN_ENDPOINT,
  port: config.MINIO_PRESIGN_PORT,
  useSSL: config.MINIO_PRESIGN_USE_SSL,
  accessKey: config.MINIO_ACCESS_KEY,
  secretKey: config.MINIO_SECRET_KEY,
  region: 'us-east-1'
});
