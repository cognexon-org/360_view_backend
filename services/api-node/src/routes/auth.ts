import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { badRequest } from '../lib/http.js';
import { hashOtp, randomOtp } from '../lib/security.js';

const phoneSchema = z.string().min(8).max(20).regex(/^\+?[0-9]+$/);

export async function authRoutes(app: FastifyInstance) {
  app.post('/v1/auth/otp/request', async (request, reply) => {
    try {
      const { phone } = z.object({ phone: phoneSchema }).parse(request.body);
      const code = randomOtp();
      await prisma.otpCode.create({
        data: {
          phone,
          codeHash: hashOtp(phone, code),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000)
        }
      });

      // Integrate an SMS provider here in production. Development can expose the code.
      return reply.send({
        requested: true,
        expiresInSeconds: 600,
        ...(config.DEV_OTP_EXPOSE ? { developmentOtp: code } : {})
      });
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.post('/v1/auth/otp/verify', async (request, reply) => {
    try {
      const { phone, code, name } = z
        .object({ phone: phoneSchema, code: z.string().length(6), name: z.string().min(1).max(100).optional() })
        .parse(request.body);

      const otp = await prisma.otpCode.findFirst({
        where: { phone, usedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' }
      });
      if (!otp || otp.codeHash !== hashOtp(phone, code)) {
        return reply.code(401).send({ error: 'INVALID_OTP' });
      }

      const result = await prisma.$transaction(async (tx) => {
        await tx.otpCode.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
        let user = await tx.user.findUnique({ where: { phone }, include: { organization: true } });
        if (!user) {
          const organization = await tx.organization.create({ data: { name: name ? `${name}'s Organization` : 'My Organization' } });
          user = await tx.user.create({
            data: { phone, name, role: 'OWNER', organizationId: organization.id },
            include: { organization: true }
          });
        }
        return user;
      });

      const token = await reply.jwtSign(
        { userId: result.id, organizationId: result.organizationId, role: result.role },
        { expiresIn: '30d' }
      );
      return reply.send({ token, user: result });
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.get('/v1/me', { preHandler: [app.authenticate] }, async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.userId },
      include: { organization: true }
    });
    if (!user) return reply.code(404).send({ error: 'USER_NOT_FOUND' });
    return reply.send(user);
  });
}
