import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import { env } from './lib/env'
import { authRoutes } from './routes/auth'
import { userRoutes } from './routes/users'
import { deviceRoutes } from './routes/devices'
import { zoneRoutes } from './routes/zones'
import { settingsRoutes } from './routes/settings'
import { auditLogRoutes } from './routes/auditLog'
import { stickerRoutes } from './routes/stickers'
import { clientRoutes } from './routes/clients'
import { cycleRoutes } from './routes/cycles'
import { syncRoutes } from './routes/sync'
import { collectionRoutes } from './routes/collections'
import { voidRequestRoutes } from './routes/voidRequests'
import { dashboardRoutes } from './routes/dashboard'
import { handoverRoutes } from './routes/handovers'
import { otpRoutes } from './routes/otp'
import { activityRoutes } from './routes/activity'
import { startDailySummaryJob } from './jobs/daily-summary'
import { AppError } from './lib/errors'
import { prisma } from './lib/prisma'

async function build() {
  const app = Fastify({ logger: { level: env.NODE_ENV === 'test' ? 'silent' : 'info' } })

  await app.register(helmet, { contentSecurityPolicy: false })
  await app.register(cors, { origin: env.ADMIN_ORIGIN, credentials: true })
  await app.register(rateLimit, { max: env.RATE_LIMIT_MAX, timeWindow: env.RATE_LIMIT_WINDOW_MS })
  await app.register(jwt, { secret: env.JWT_SECRET })
  await app.register(multipart, { limits: { fileSize: 300 * 1024 } })

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } })
    }
    if (error.validation) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: error.message } })
    }
    app.log.error(error)
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Erreur interne du serveur' } })
  })

  app.get('/v1/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? '0.1.0',
  }))

  await app.register(async (v1) => {
    await v1.register(authRoutes)
    await v1.register(userRoutes)
    await v1.register(deviceRoutes)
    await v1.register(zoneRoutes)
    await v1.register(settingsRoutes)
    await v1.register(auditLogRoutes)
    await v1.register(stickerRoutes)
    await v1.register(clientRoutes)
    await v1.register(cycleRoutes)
    await v1.register(syncRoutes)
    await v1.register(collectionRoutes)
    await v1.register(voidRequestRoutes)
    await v1.register(dashboardRoutes)
    await v1.register(handoverRoutes)
    await v1.register(otpRoutes)
    await v1.register(activityRoutes)
  }, { prefix: '/v1' })

  return app
}

async function start() {
  const app = await build()
  try {
    await app.listen({ port: env.PORT, host: env.HOST })
    startDailySummaryJob()
  } catch (err) {
    app.log.error(err)
    await prisma.$disconnect()
    process.exit(1)
  }
}

start()
export { build }
