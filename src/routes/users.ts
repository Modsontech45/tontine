import { FastifyInstance } from 'fastify'
import argon2 from 'argon2'
import { z } from 'zod'
import { Role } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { requireRoles } from '../middleware/auth'
import { notFound, forbidden } from '../lib/errors'
import { writeAudit } from '../lib/audit'
import { sendWelcomeEmail } from '../lib/email'

const createUserSchema = z.object({
  role: z.nativeEnum(Role),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  phone: z.string().min(8),
  email: z.string().email().optional(),
  password: z.string().min(8).optional(),
  pin: z.string().length(6).regex(/^\d+$/).optional(),
  zone_id: z.string().uuid().optional(),
})

const patchUserSchema = z.object({
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
  phone: z.string().min(8).optional(),
  email: z.string().email().optional().nullable(),
  zone_id: z.string().uuid().optional().nullable(),
  photo_url: z.string().url().optional().nullable(),
})

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
  role: z.nativeEnum(Role).optional(),
  q: z.string().optional(),
})

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get('/users', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN') }, async (req, reply) => {
    const q = paginationSchema.parse(req.query)
    const where = {
      ...(q.role ? { role: q.role } : {}),
      ...(q.q ? { OR: [{ firstName: { contains: q.q, mode: 'insensitive' as const } }, { lastName: { contains: q.q, mode: 'insensitive' as const } }, { phone: { contains: q.q } }] } : {}),
    }
    const [users, total] = await Promise.all([
      prisma.user.findMany({ where, skip: (q.page - 1) * q.page_size, take: q.page_size, orderBy: { createdAt: 'desc' }, select: { id: true, role: true, firstName: true, lastName: true, phone: true, email: true, zoneId: true, isActive: true, lastLoginAt: true, createdAt: true } }),
      prisma.user.count({ where }),
    ])
    return reply.send({ data: users, total, page: q.page, page_size: q.page_size })
  })

  app.post('/users', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN') }, async (req, reply) => {
    const body = createUserSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const { role, first_name, last_name, phone, email, password, pin, zone_id } = body.data
    if ((role === 'COLLECTOR') && !pin) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'PIN requis pour un collecteur' } })
    if (role !== 'COLLECTOR' && !password) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Mot de passe requis' } })

    const [passwordHash, pinHash] = await Promise.all([
      password ? argon2.hash(password) : Promise.resolve(null),
      pin ? argon2.hash(pin) : Promise.resolve(null),
    ])

    const user = await prisma.user.create({
      data: { id: crypto.randomUUID(), role, firstName: first_name, lastName: last_name, phone, email, passwordHash, pinHash, zoneId: zone_id },
      select: { id: true, role: true, firstName: true, lastName: true, phone: true, email: true, zoneId: true, isActive: true, createdAt: true },
    })

    await writeAudit({ actorId: req.actor?.userId, actorRole: req.actor?.role, action: 'CREATE', entity: 'users', entityId: user.id, after: user, ip: req.ip })

    if (email && process.env.RESEND_API_KEY) {
      sendWelcomeEmail({ to: email, firstName: first_name, lastName: last_name, role, phone, password, pin }).catch(() => {})
    }

    return reply.code(201).send(user)
  })

  app.get('/users/:id', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, firstName: true, lastName: true, phone: true, email: true, zoneId: true, isActive: true, lastLoginAt: true, createdAt: true, updatedAt: true } })
    if (!user) return reply.code(404).send({ error: notFound('User', id) })
    return reply.send(user)
  })

  app.patch('/users/:id', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = patchUserSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const existing = await prisma.user.findUnique({ where: { id } })
    if (!existing) return reply.code(404).send({ error: notFound('User', id) })

    const updated = await prisma.user.update({
      where: { id },
      data: { firstName: body.data.first_name, lastName: body.data.last_name, phone: body.data.phone, email: body.data.email, zoneId: body.data.zone_id, photoUrl: body.data.photo_url },
      select: { id: true, role: true, firstName: true, lastName: true, phone: true, email: true, zoneId: true, isActive: true, photoUrl: true, updatedAt: true },
    })

    await writeAudit({ actorId: req.actor.userId, actorRole: req.actor.role, action: 'UPDATE', entity: 'users', entityId: id, before: existing, after: updated, ip: req.ip })
    return reply.send(updated)
  })

  app.post('/users/:id/reset-pin', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = z.object({ pin: z.string().length(6).regex(/^\d+$/) }).safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const user = await prisma.user.findUnique({ where: { id } })
    if (!user) return reply.code(404).send({ error: notFound('User', id) })
    if (user.role !== 'COLLECTOR') return reply.code(400).send({ error: { code: 'INVALID_OPERATION', message: 'Réinitialisation du PIN réservée aux collecteurs' } })

    const pinHash = await argon2.hash(body.data.pin)
    await prisma.user.update({ where: { id }, data: { pinHash } })
    await writeAudit({ actorId: req.actor.userId, actorRole: req.actor.role, action: 'RESET_PIN', entity: 'users', entityId: id, ip: req.ip })
    return reply.code(204).send()
  })

  app.post('/users/:id/deactivate', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (id === req.actor.userId) return reply.code(400).send({ error: { code: 'CONFLICT', message: 'Impossible de se désactiver soi-même' } })

    const user = await prisma.user.findUnique({ where: { id } })
    if (!user) return reply.code(404).send({ error: notFound('User', id) })

    await prisma.user.update({ where: { id }, data: { isActive: false } })
    await prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } })
    await writeAudit({ actorId: req.actor.userId, actorRole: req.actor.role, action: 'DEACTIVATE', entity: 'users', entityId: id, ip: req.ip })
    return reply.code(204).send()
  })
}
