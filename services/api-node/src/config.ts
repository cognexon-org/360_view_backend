import { z } from 'zod';

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
  LOG_LEVEL: z.string().default('info')
});

export const config = schema.parse(process.env);
