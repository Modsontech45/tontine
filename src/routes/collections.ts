import { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { requireAuth, requireRoles } from '../middleware/auth'
import { notFound } from '../lib/errors'

export async function collectionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/collections', { preHandler: requireAuth }, async (req, reply) => {
    const {
      collector_id, client_id, cycle_id,
      from, to, flag, voided,
      page = '1', page_size = '50',
    } = req.query as Record<string, string>

    const pg = parseInt(page)
    const ps = Math.min(parseInt(page_size), 100)

    const effectiveCollectorId = req.actor.role === 'COLLECTOR' ? req.actor.userId : collector_id

    const where = {
      ...(effectiveCollectorId ? { collectorId: effectiveCollectorId } : {}),
      ...(client_id ? { clientId: client_id } : {}),
      ...(cycle_id ? { cycleId: cycle_id } : {}),
      ...(from || to ? {
        collectedAt: {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to ? { lte: new Date(to + 'T23:59:59Z') } : {}),
        },
      } : {}),
      ...(flag ? { flags: { has: flag } } : {}),
      ...(voided === 'true' ? { voidedAt: { not: null } } : voided === 'false' ? { voidedAt: null } : {}),
    }

    const [collections, total] = await Promise.all([
      prisma.collection.findMany({
        where,
        skip: (pg - 1) * ps,
        take: ps,
        orderBy: { collectedAt: 'desc' },
        include: {
          client: { select: { id: true, firstName: true, lastName: true, carnetNumber: true } },
          collector: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      prisma.collection.count({ where }),
    ])

    return reply.send({ data: collections, total, page: pg, page_size: ps })
  })

  app.get('/collections/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const collection = await prisma.collection.findUnique({
      where: { id },
      include: {
        client: { select: { id: true, firstName: true, lastName: true, carnetNumber: true, latitude: true, longitude: true } },
        collector: { select: { id: true, firstName: true, lastName: true } },
        voidRequests: true,
      },
    })
    if (!collection) return reply.code(404).send({ error: notFound('Collection', id) })

    if (req.actor.role === 'COLLECTOR' && collection.collectorId !== req.actor.userId) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Accès refusé' } })
    }

    return reply.send(collection)
  })

  // Dashboard for logged-in collector (today's summary)
  app.get('/dashboard/collector/me', { preHandler: requireAuth }, async (req, reply) => {
    const { date } = req.query as { date?: string }
    const collectorId = req.actor.userId
    const today = date ?? new Date().toISOString().substring(0, 10)
    const todayStart = new Date(today + 'T00:00:00Z')
    const todayEnd = new Date(today + 'T23:59:59Z')

    const [todayCollections, clients, openAlerts] = await Promise.all([
      prisma.collection.findMany({
        where: { collectorId, businessDate: { gte: todayStart, lte: todayEnd }, voidedAt: null },
        select: { id: true, amount: true, clientId: true, flags: true },
      }),
      prisma.client.findMany({
        where: { collectorId, status: 'ACTIVE' },
        select: { id: true, cycles: { where: { status: 'OPEN' }, select: { id: true, boxesFilled: true, stakeAmount: true }, take: 1 } },
      }),
      prisma.alert.count({ where: { collectorId, status: 'OPEN' } }),
    ])

    const totalToday = todayCollections.reduce((s, c) => s + c.amount, 0)
    const clientsCollectedToday = new Set(todayCollections.map((c) => c.clientId)).size
    const clientsWithOpenCycle = clients.filter((c) => c.cycles.length > 0).length

    return reply.send({
      date: today,
      total_today: totalToday,
      clients_collected: clientsCollectedToday,
      clients_total: clients.length,
      clients_with_open_cycle: clientsWithOpenCycle,
      open_alerts: openAlerts,
      collections_count: todayCollections.length,
      collections_synced: todayCollections.length, // all server-side collections are "synced"
    })
  })
}
