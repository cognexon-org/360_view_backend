import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Automatically locate and load .env when running on host or inside container
const envPaths = [
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '../../.env'),
  resolve(process.cwd(), '../.env')
];
for (const p of envPaths) {
  if (existsSync(p)) {
    dotenv.config({ path: p });
  }
}

const env: Record<string, any> = { ...process.env };

// Fallback MinIO keys from MINIO_ROOT_USER / MINIO_ROOT_PASSWORD in .env
if (!env.MINIO_ACCESS_KEY && env.MINIO_ROOT_USER) {
  env.MINIO_ACCESS_KEY = env.MINIO_ROOT_USER;
}
if (!env.MINIO_SECRET_KEY && env.MINIO_ROOT_PASSWORD) {
  env.MINIO_SECRET_KEY = env.MINIO_ROOT_PASSWORD;
}

// When running on the host outside Docker, normalize Docker-internal container hostnames to localhost
const isInsideDocker = existsSync('/.dockerenv');
if (!isInsideDocker) {
  if (env.DATABASE_URL && env.DATABASE_URL.includes('@cockroach:')) {
    env.DATABASE_URL = env.DATABASE_URL.replace('@cockroach:', '@localhost:');
  }
  if (env.REDIS_URL && env.REDIS_URL.includes('redis://redis:')) {
    env.REDIS_URL = env.REDIS_URL.replace('redis://redis:', 'redis://localhost:');
  }
  if (env.VISION_SERVICE_URL && env.VISION_SERVICE_URL.includes('http://vision:')) {
    env.VISION_SERVICE_URL = env.VISION_SERVICE_URL.replace('http://vision:', 'http://localhost:');
  }
  if (env.MINIO_ENDPOINT === 'minio') {
    env.MINIO_ENDPOINT = 'localhost';
  }
}

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(16),
  OTP_SECRET: z.string().min(16),
  DEV_OTP_EXPOSE: z.string().default('false').transform((value) => value === 'true'),
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().default(9000),
  MINIO_USE_SSL: z.string().default('false').transform((value) => value === 'true'),
  MINIO_PRESIGN_ENDPOINT: z.string().default('localhost'),
  MINIO_PRESIGN_PORT: z.coerce.number().default(9000),
  MINIO_PRESIGN_USE_SSL: z.string().default('false').transform((value) => value === 'true'),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET_PRIVATE: z.string().default('propertytour-private'),
  MINIO_BUCKET_PUBLIC: z.string().default('propertytour-public'),
  MINIO_PUBLIC_BASE_URL: z.string().url().default('http://localhost:9000/propertytour-public'),
  VISION_SERVICE_URL: z.string().url().default('http://localhost:8001'),
  VISION_SHARED_SECRET: z.string().min(8),
  API_PORT: z.coerce.number().default(3000),
  RATE_LIMIT_MAX: z.coerce.number().default(1200),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  RATE_LIMIT_UPLOAD_MAX: z.coerce.number().default(6000),
  LOG_LEVEL: z.string().default('info')
});

export const config = schema.parse(env);
