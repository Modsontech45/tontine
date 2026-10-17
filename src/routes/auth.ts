import { FastifyInstance } from 'fastify'
import argon2 from 'argon2'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { unauthorized, AppError } from '../lib/errors'
import { writeAudit } from '../lib/audit'
import { createHash, randomBytes } from 'crypto'
import { requestOtp, verifyOtp } from '../lib/otp'
import { sendNewDeviceAlert } from '../lib/email'

const webLoginSchema = z.object({
  phone: z.string().optional(),
  email: z.string().email().optional(),
  password: z.string().min(1),
})

const collectorLoginSchema = z.object({
  phone: z.string().min(1).optional(),
  email: z.string().email().optional(),
  pin: z.string().length(6).regex(/^\d+$/),
  device_info: z.object({
    android_id: z.string().min(1),
    model: z.string().min(1),
    app_version: z.string().min(1),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
  }),
}).refine((d) => d.phone || d.email, { message: 'phone or email required' })

const refreshSchema = z.object({
  refresh_token: z.string().min(1),
})

const changePinSchema = z.object({
  current_pin: z.string().length(6).regex(/^\d+$/),
  new_pin: z.string().length(6).regex(/^\d+$/),
})

const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8),
})

const LOCK_ATTEMPTS = 5
const LOCK_DURATION_MS = 15 * 60 * 1000
const loginAttempts = new Map<string, { count: number; since: number }>()

function checkLocked(key: string): boolean {
  const entry = loginAttempts.get(key)
  if (!entry) return false
  if (entry.count >= LOCK_ATTEMPTS && Date.now() - entry.since < LOCK_DURATION_MS) return true
  if (Date.now() - entry.since >= LOCK_DURATION_MS) loginAttempts.delete(key)
  return false
}

function recordAttempt(key: string, success: boolean): void {
  if (success) { loginAttempts.delete(key); return }
  const entry = loginAttempts.get(key) ?? { count: 0, since: Date.now() }
  if (Date.now() - entry.since >= LOCK_DURATION_MS) { loginAttempts.set(key, { count: 1, since: Date.now() }); return }
  entry.count++
  loginAttempts.set(key, entry)
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/web/login', async (req, reply) => {
    const body = webLoginSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const { phone, email, password } = body.data
    if (!phone && !email) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'phone or email required' } })

    const lockKey = email ?? phone ?? ''
    if (checkLocked(lockKey)) {
      return reply.code(429).send({ error: { code: 'LOCKED', message: 'Compte verrouillé 15 min' } })
    }

    const user = await prisma.user.findFirst({
      where: { OR: [email ? { email } : {}, phone ? { phone } : {}], isActive: true },
    })

    if (!user || !user.passwordHash || !(await argon2.verify(user.passwordHash, password))) {
      recordAttempt(lockKey, false)
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Identifiants invalides' } })
    }
    if (['COLLECTOR'].includes(user.role)) {
      recordAttempt(lockKey, false)
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Utilisez l\'app mobile' } })
    }

    recordAttempt(lockKey, true)
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })

    const accessToken = app.jwt.sign(
      { userId: user.id, role: user.role },
      { expiresIn: '15m' },
    )
    const rawRefresh = randomBytes(48).toString('hex')
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000)
    await prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: hashToken(rawRefresh), expiresAt },
    })

    await writeAudit({ actorId: user.id, actorRole: user.role, action: 'LOGIN', entity: 'users', entityId: user.id, ip: req.ip })

    return reply.send({ access_token: accessToken, refresh_token: rawRefresh, expires_in: 900, user: { id: user.id, role: user.role, first_name: user.firstName, last_name: user.lastName } })
  })

  app.post('/auth/collector/login', async (req, reply) => {
    const body = collectorLoginSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const { phone, email, pin, device_info } = body.data
    const lockKey = `col:${email ?? phone}`
    if (checkLocked(lockKey)) {
      return reply.code(429).send({ error: { code: 'LOCKED', message: 'Compte verrouillé 15 min' } })
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          ...(phone ? [{ phone, role: 'COLLECTOR' as const }] : []),
          ...(email ? [{ email, role: 'COLLECTOR' as const }] : []),
        ],
        isActive: true,
      },
    })
    if (!user || !user.pinHash || !(await argon2.verify(user.pinHash, pin))) {
      recordAttempt(lockKey, false)
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Identifiant ou PIN incorrect' } })
    }
    recordAttempt(lockKey, true)

    const { latitude, longitude } = device_info
    const now = new Date()

    let device = await prisma.device.findFirst({ where: { userId: user.id, androidId: device_info.android_id } })
    const isNewDevice = !device

    if (!device) {
      device = await prisma.device.create({
        data: {
          userId: user.id,
          androidId: device_info.android_id,
          model: device_info.model,
          appVersion: device_info.app_version,
          status: 'PENDING',
          lastLoginAt: now,
          lastLoginLat: latitude,
          lastLoginLng: longitude,
        },
      })
      // Fire-and-forget admin alert
      sendNewDeviceAlert({
        collectorName: `${user.firstName} ${user.lastName}`,
        collectorPhone: user.phone,
        model: device_info.model,
        androidId: device_info.android_id,
        appVersion: device_info.app_version,
        lat: latitude,
        lng: longitude,
        deviceId: device.id,
      }).catch(() => {})
    } else if (device.status === 'REVOKED') {
      return reply.code(403).send({ error: { code: 'DEVICE_REVOKED', message: 'Appareil révoqué' } })
    } else {
      await prisma.device.update({
        where: { id: device.id },
        data: {
          model: device_info.model,
          appVersion: device_info.app_version,
          lastLoginAt: now,
          lastLoginLat: latitude ?? device.lastLoginLat,
          lastLoginLng: longitude ?? device.lastLoginLng,
        },
      })
    }

    if (device.status === 'PENDING') {
      return reply.code(202).send({ status: 'PENDING', message: 'Appareil en attente d\'approbation par un administrateur', device_id: device.id })
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })

    const accessToken = app.jwt.sign(
      { userId: user.id, role: user.role, deviceId: device.id },
      { expiresIn: '15m' },
    )
    const rawRefresh = randomBytes(48).toString('hex')
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    await prisma.refreshToken.create({
      data: { userId: user.id, deviceId: device.id, tokenHash: hashToken(rawRefresh), expiresAt },
    })

    await writeAudit({ actorId: user.id, actorRole: user.role, action: 'LOGIN', entity: 'users', entityId: user.id, deviceId: device.id, ip: req.ip })

    return reply.send({ access_token: accessToken, refresh_token: rawRefresh, expires_in: 900, device_id: device.id, user: { id: user.id, role: user.role, first_name: user.firstName, last_name: user.lastName } })
  })

  app.post('/auth/refresh', async (req, reply) => {
    const body = refreshSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const tokenHash = hashToken(body.data.refresh_token)
    const stored = await prisma.refreshToken.findFirst({ where: { tokenHash, revokedAt: null }, include: { user: true } })
    if (!stored || stored.expiresAt < new Date()) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Refresh token invalide' } })
    }

    if (stored.deviceId) {
      const device = await prisma.device.findUnique({ where: { id: stored.deviceId } })
      if (!device || device.status === 'REVOKED') {
        await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } })
        return reply.code(401).send({ error: { code: 'DEVICE_REVOKED', message: 'Appareil révoqué' } })
      }
    }

    await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } })

    const accessToken = app.jwt.sign(
      { userId: stored.userId, role: stored.user.role, deviceId: stored.deviceId ?? undefined },
      { expiresIn: '15m' },
    )
    const rawRefresh = randomBytes(48).toString('hex')
    const isCollector = stored.user.role === 'COLLECTOR'
    const expiresAt = new Date(Date.now() + (isCollector ? 30 * 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000))
    await prisma.refreshToken.create({
      data: { userId: stored.userId, deviceId: stored.deviceId, tokenHash: hashToken(rawRefresh), expiresAt },
    })

    return reply.send({ access_token: accessToken, refresh_token: rawRefresh, expires_in: 900 })
  })

  app.post('/auth/logout', { preHandler: [async (req, reply) => { try { await req.jwtVerify() } catch { /* ignore */ } } ] }, async (req, reply) => {
    const body = refreshSchema.safeParse(req.body)
    if (body.success) {
      const tokenHash = hashToken(body.data.refresh_token)
      await prisma.refreshToken.updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: new Date() } })
    }
    return reply.code(204).send()
  })

  app.post('/auth/change-pin', { preHandler: [] }, async (req, reply) => {
    try {
      await req.jwtVerify()
    } catch {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Non autorisé' } })
    }
    const actor = req.user as { userId: string; role: string }
    const body = changePinSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const user = await prisma.user.findUnique({ where: { id: actor.userId } })
    if (!user || !user.pinHash) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'PIN not set' } })
    if (!(await argon2.verify(user.pinHash, body.data.current_pin))) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'PIN actuel incorrect' } })
    }

    const newHash = await argon2.hash(body.data.new_pin)
    await prisma.user.update({ where: { id: user.id }, data: { pinHash: newHash } })
    await writeAudit({ actorId: user.id, actorRole: user.role, action: 'CHANGE_PIN', entity: 'users', entityId: user.id, ip: req.ip })
    return reply.code(204).send()
  })

  app.post('/auth/forgot-password', async (req, reply) => {
    const body = z.object({ email: z.string().email() }).safeParse(req.body)
    if (!body.success) return reply.send({ sent: true })

    const user = await prisma.user.findFirst({
      where: { email: { equals: body.data.email, mode: 'insensitive' }, isActive: true },
    })

    if (user && user.role !== 'COLLECTOR' && user.email) {
      requestOtp(user.id, 'RESET_PASSWORD').catch(() => {})
    }

    return reply.send({ sent: true })
  })

  app.post('/auth/reset-password', async (req, reply) => {
    const body = z.object({
      email: z.string().email(),
      otp_code: z.string().length(6).regex(/^\d+$/),
      new_password: z.string().min(8),
    }).safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const user = await prisma.user.findFirst({
      where: { email: { equals: body.data.email, mode: 'insensitive' }, isActive: true },
    })

    if (!user) {
      return reply.code(422).send({ error: { code: 'INVALID_OTP', message: 'Code invalide ou expiré.' } })
    }

    const valid = await verifyOtp(user.id, 'RESET_PASSWORD', body.data.otp_code)
    if (!valid) {
      return reply.code(422).send({ error: { code: 'INVALID_OTP', message: 'Code invalide ou expiré.' } })
    }

    const passwordHash = await argon2.hash(body.data.new_password)
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } })
    await prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } })
    await writeAudit({ actorId: user.id, actorRole: user.role, action: 'RESET_PASSWORD', entity: 'users', entityId: user.id, ip: req.ip })

    return reply.send({ success: true })
  })

  app.post('/auth/change-password', async (req, reply) => {
    try {
      await req.jwtVerify()
    } catch {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Non autorisé' } })
    }
    const actor = req.user as { userId: string; role: string }
    const body = changePasswordSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const user = await prisma.user.findUnique({ where: { id: actor.userId } })
    if (!user || !user.passwordHash) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Password not set' } })
    if (!(await argon2.verify(user.passwordHash, body.data.current_password))) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Mot de passe actuel incorrect' } })
    }

    const newHash = await argon2.hash(body.data.new_password)
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash } })
    await writeAudit({ actorId: user.id, actorRole: user.role, action: 'CHANGE_PASSWORD', entity: 'users', entityId: user.id, ip: req.ip })
    return reply.code(204).send()
  })
}
