import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, requireRoles } from '../middleware/auth'
import { notFound, forbidden } from '../lib/errors'
import { writeAudit } from '../lib/audit'
import { revertCollectionFromCycle } from '../services/cycleService'

const decideSchema = z.object({
  note: z.string().optional(),
})

export async function voidRequestRoutes(app: FastifyInstance): Promise<void> {
  app.get('/void-requests', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CONTROLLER') }, async (req, reply) => {
    const { status = 'PENDING', page = '1', page_size = '50' } = req.query as Record<string, string>
    const pg = parseInt(page)
    const ps = Math.min(parseInt(page_size), 100)

    const [requests, total] = await Promise.all([
      prisma.voidRequest.findMany({
        where: status !== 'ALL' ? { status: status as never } : {},
        skip: (pg - 1) * ps,
        take: ps,
        orderBy: { createdAt: 'desc' },
        include: {
          collection: {
            include: {
              client: { select: { id: true, firstName: true, lastName: true, carnetNumber: true } },
              collector: { select: { id: true, firstName: true, lastName: true } },
            },
          },
          requestedBy: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      prisma.voidRequest.count({ where: status !== 'ALL' ? { status: status as never } : {} }),
    ])

    return reply.send({ data: requests, total, page: pg, page_size: ps })
  })

  app.post('/void-requests/:id/approve', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CONTROLLER') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = decideSchema.safeParse(req.body)

    const voidReq = await prisma.voidRequest.findUnique({ where: { id }, include: { collection: true } })
    if (!voidReq) return reply.code(404).send({ error: notFound('VoidRequest', id) })
    if (voidReq.status !== 'PENDING') return reply.code(422).send({ error: { code: 'CONFLICT', message: 'Cette demande est déjà traitée' } })

    const col = voidReq.collection
    if (col.voidedAt) return reply.code(422).send({ error: { code: 'CONFLICT', message: 'Cet encaissement est déjà annulé' } })

    await prisma.$transaction(async (tx) => {
      // Void the collection
      await (tx as any).collection.update({
        where: { id: col.id },
        data: {
          voidedAt: new Date(),
          voidedById: req.actor.userId,
          voidReason: voidReq.reason,
        },
      })

      // Revert cycle totals
      await revertCollectionFromCycle(col.cycleId, col.amount, tx as any)

      // Update void request
      await (tx as any).voidRequest.update({
        where: { id },
        data: {
          status: 'APPROVED',
          decidedById: req.actor.userId,
          decidedAt: new Date(),
          decisionNote: body.data?.note ?? null,
        },
      })
    })

    await writeAudit({
      actorId: req.actor.userId, actorRole: req.actor.role,
      action: 'APPROVE_VOID', entity: 'void_requests', entityId: id,
      after: { collectionId: col.id, amount: col.amount }, ip: req.ip,
    })

    return reply.code(204).send()
  })

  app.post('/void-requests/:id/reject', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CONTROLLER') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = decideSchema.safeParse(req.body)

    const voidReq = await prisma.voidRequest.findUnique({ where: { id } })
    if (!voidReq) return reply.code(404).send({ error: notFound('VoidRequest', id) })
    if (voidReq.status !== 'PENDING') return reply.code(422).send({ error: { code: 'CONFLICT', message: 'Cette demande est déjà traitée' } })

    await prisma.voidRequest.update({
      where: { id },
      data: {
        status: 'REJECTED',
        decidedById: req.actor.userId,
        decidedAt: new Date(),
        decisionNote: body.data?.note ?? null,
      },
    })

    await writeAudit({
      actorId: req.actor.userId, actorRole: req.actor.role,
      action: 'REJECT_VOID', entity: 'void_requests', entityId: id,
      ip: req.ip,
    })

    return reply.code(204).send()
  })
}
