import { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { requireRoles } from '../middleware/auth'

export async function activityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/activity', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN') }, async (_req, reply) => {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000)
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

    const [devices, recentLogs] = await Promise.all([
      prisma.device.findMany({
        include: { user: { select: { id: true, firstName: true, lastName: true, phone: true } } },
        orderBy: { lastLoginAt: 'desc' },
      }),
      prisma.auditLog.findMany({
        where: { at: { gte: oneDayAgo } },
        orderBy: { at: 'desc' },
        take: 50,
        include: { actor: { select: { firstName: true, lastName: true, role: true } } },
      }),
    ])

    const approvedDevices = devices.filter((d) => d.status === 'APPROVED').map((d) => ({
      id: d.id,
      model: d.model,
      androidId: d.androidId,
      appVersion: d.appVersion,
      lastLoginAt: d.lastLoginAt,
      lastSyncAt: d.lastSyncAt,
      lastLoginLat: d.lastLoginLat,
      lastLoginLng: d.lastLoginLng,
      user: d.user,
      onlineStatus:
        d.lastSyncAt && d.lastSyncAt >= thirtyMinAgo ? 'online' :
        d.lastLoginAt && d.lastLoginAt >= twoHoursAgo ? 'recent' :
        'offline',
    }))

    const pendingDevices = devices.filter((d) => d.status === 'PENDING').map((d) => ({
      id: d.id,
      model: d.model,
      androidId: d.androidId,
      lastLoginAt: d.lastLoginAt,
      lastLoginLat: d.lastLoginLat,
      lastLoginLng: d.lastLoginLng,
      user: d.user,
    }))

    const logs = recentLogs.map((l) => ({
      id: l.id.toString(),
      action: l.action,
      entity: l.entity,
      entityId: l.entityId,
      actorName: l.actor ? `${l.actor.firstName} ${l.actor.lastName}` : null,
      actorRole: l.actor?.role ?? null,
      ip: l.ip,
      at: l.at,
    }))

    return reply.send({ approvedDevices, pendingDevices, logs })
  })
}
