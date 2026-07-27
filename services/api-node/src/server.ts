import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { authRoutes } from './routes/auth.js';
import { organizationRoutes } from './routes/organizations.js';
import { propertyRoutes } from './routes/properties.js';
import { captureRoutes } from './routes/captures.js';
import { tourRoutes } from './routes/tours.js';
import { designRoutes } from './routes/design.js';
import { jobRoutes } from './routes/jobs.js';
import { publicRoutes } from './routes/public.js';

const app = Fastify({ logger: { level: config.LOG_LEVEL } });

app.setReplySerializer((payload) =>
  JSON.stringify(payload, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
);

await app.register(cors, { origin: true, credentials: true });
await app.register(jwt, { secret: config.JWT_SECRET });
await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
await app.register(swagger, {
  openapi: {
    info: { title: 'PropertyTour360 API', version: '1.0.0' },
    servers: [{ url: 'http://localhost:3000' }]
  }
});
await app.register(swaggerUi, { routePrefix: '/docs' });

app.decorate('authenticate', async function authenticate(request, reply): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    await reply.code(401).send({ error: 'UNAUTHORIZED' });
  }
});

app.get('/', async () => ({
  service: 'PropertyTour360 API',
  version: '1.0.0',
  docs: '/docs',
  health: '/health'
}));
app.get('/health', async () => {
  await prisma.$queryRaw`SELECT 1`;
  return { status: 'ok', database: 'ok', redis: redis.status };
});

await authRoutes(app);
await organizationRoutes(app);
await propertyRoutes(app);
await captureRoutes(app);
await tourRoutes(app);
await designRoutes(app);
await jobRoutes(app);
await publicRoutes(app);

app.setErrorHandler((error: FastifyError, request, reply) => {
  request.log.error(error);
  if (error.statusCode === 429) return reply.code(429).send({ error: 'RATE_LIMITED' });
  return reply.code(error.statusCode && error.statusCode >= 400 ? error.statusCode : 500).send({
    error: 'INTERNAL_ERROR',
    message: process.env.NODE_ENV === 'production' ? 'Unexpected server error' : error.message
  });
});

app.addHook('onClose', async () => {
  await prisma.$disconnect();
  await redis.quit();
});

await app.listen({ host: '0.0.0.0', port: config.API_PORT });
