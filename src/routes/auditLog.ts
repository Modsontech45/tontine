import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireRoles } from '../middleware/auth'

const querySchema = z.object({
  entity: z.string().optional(),
  entity_id: z.string().uuid().optional(),
  actor_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(50),
})

export async function auditLogRoutes(app: FastifyInstance): Promise<void> {
  app.get('/audit-log', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN') }, async (req, reply) => {
    const q = querySchema.parse(req.query)
    const where = {
      ...(q.entity ? { entity: q.entity } : {}),
      ...(q.entity_id ? { entityId: q.entity_id } : {}),
      ...(q.actor_id ? { actorId: q.actor_id } : {}),
    }
    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        skip: (q.page - 1) * q.page_size,
        take: q.page_size,
        orderBy: { at: 'desc' },
        include: { actor: { select: { firstName: true, lastName: true, role: true } } },
      }),
      prisma.auditLog.count({ where }),
    ])
    const serialized = logs.map((l) => ({ ...l, id: l.id.toString() }))
    return reply.send({ data: serialized, total, page: q.page, page_size: q.page_size })
  })
}
