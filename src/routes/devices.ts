import { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { requireRoles } from '../middleware/auth'
import { notFound } from '../lib/errors'
import { writeAudit } from '../lib/audit'

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/devices', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN') }, async (req, reply) => {
    const { user_id, status } = req.query as { user_id?: string; status?: string }
    const devices = await prisma.device.findMany({
      where: { ...(user_id ? { userId: user_id } : {}), ...(status ? { status: status as never } : {}) },
      include: { user: { select: { id: true, firstName: true, lastName: true, role: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return reply.send({ data: devices })
  })

  app.post('/devices/:id/approve', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const device = await prisma.device.findUnique({ where: { id } })
    if (!device) return reply.code(404).send({ error: notFound('Device', id) })

    const updated = await prisma.device.update({
      where: { id },
      data: { status: 'APPROVED', approvedBy: req.actor.userId, approvedAt: new Date() },
    })
    await writeAudit({ actorId: req.actor.userId, actorRole: req.actor.role, action: 'APPROVE_DEVICE', entity: 'devices', entityId: id, ip: req.ip })
    return reply.send(updated)
  })

  app.post('/devices/:id/revoke', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const device = await prisma.device.findUnique({ where: { id } })
    if (!device) return reply.code(404).send({ error: notFound('Device', id) })

    await prisma.device.update({ where: { id }, data: { status: 'REVOKED' } })
    await prisma.refreshToken.updateMany({ where: { deviceId: id, revokedAt: null }, data: { revokedAt: new Date() } })
    await writeAudit({ actorId: req.actor.userId, actorRole: req.actor.role, action: 'REVOKE_DEVICE', entity: 'devices', entityId: id, ip: req.ip })
    return reply.code(204).send()
  })
}
