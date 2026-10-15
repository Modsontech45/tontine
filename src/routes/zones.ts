import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireRoles, requireAuth } from '../middleware/auth'
import { notFound } from '../lib/errors'
import { writeAudit } from '../lib/audit'

const zoneSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
})

export async function zoneRoutes(app: FastifyInstance): Promise<void> {
  app.get('/zones', { preHandler: requireAuth }, async (_req, reply) => {
    const zones = await prisma.zone.findMany({ orderBy: { name: 'asc' } })
    return reply.send({ data: zones })
  })

  app.post('/zones', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN') }, async (req, reply) => {
    const body = zoneSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const zone = await prisma.zone.create({ data: { id: crypto.randomUUID(), name: body.data.name, description: body.data.description } })
    await writeAudit({ actorId: req.actor.userId, actorRole: req.actor.role, action: 'CREATE', entity: 'zones', entityId: zone.id, after: zone, ip: req.ip })
    return reply.code(201).send(zone)
  })

  app.patch('/zones/:id', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = zoneSchema.partial().safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const existing = await prisma.zone.findUnique({ where: { id } })
    if (!existing) return reply.code(404).send({ error: notFound('Zone', id) })

    const updated = await prisma.zone.update({ where: { id }, data: body.data })
    await writeAudit({ actorId: req.actor.userId, actorRole: req.actor.role, action: 'UPDATE', entity: 'zones', entityId: id, before: existing, after: updated, ip: req.ip })
    return reply.send(updated)
  })
}
