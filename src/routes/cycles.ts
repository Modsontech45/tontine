import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, requireRoles } from '../middleware/auth'
import { notFound, forbidden, AppError } from '../lib/errors'
import { writeAudit } from '../lib/audit'
import { computeCommission, getSettings, validateStakeAmount } from '../services/cycleService'
import { businessDate } from '../lib/dates'

const createCycleSchema = z.object({
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD required'),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD required'),
  stake_amount: z.number().int().positive(),
})

const cancelSchema = z.object({
  reason: z.string().min(1),
})

export async function cycleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/clients/:clientId/cycles', { preHandler: requireAuth }, async (req, reply) => {
    const { clientId } = req.params as { clientId: string }

    const client = await prisma.client.findUnique({ where: { id: clientId } })
    if (!client) return reply.code(404).send({ error: notFound('Client', clientId) })

    if (req.actor.role === 'COLLECTOR' && client.collectorId !== req.actor.userId) {
      return reply.code(403).send({ error: forbidden() })
    }

    const cycles = await prisma.cycle.findMany({
      where: { clientId },
      orderBy: { cycleSequence: 'desc' },
      include: {
        payout: { select: { id: true, netPaid: true, paidAt: true } },
        _count: { select: { collections: true } },
      },
    })

    return reply.send({ data: cycles })
  })

  app.post('/clients/:clientId/cycles', { preHandler: requireAuth }, async (req, reply) => {
    const { clientId } = req.params as { clientId: string }
    const body = createCycleSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const client = await prisma.client.findUnique({ where: { id: clientId } })
    if (!client) return reply.code(404).send({ error: notFound('Client', clientId) })
    if (client.status !== 'ACTIVE') return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Le client n\'est pas actif' } })

    // Collectors can only create cycles for their own clients
    if (req.actor.role === 'COLLECTOR' && client.collectorId !== req.actor.userId) {
      return reply.code(403).send({ error: forbidden() })
    }

    const settings = await getSettings(prisma as never)
    validateStakeAmount(body.data.stake_amount, settings.stakeMin, settings.stakeMax, settings.stakeStep)

    const startDate = new Date(body.data.start_date)
    const endDate = new Date(body.data.end_date)
    if (endDate <= startDate) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'end_date must be after start_date' } })
    }

    // Check for existing OPEN cycle (enforced by DB unique index too)
    const openCycle = await prisma.cycle.findFirst({ where: { clientId, status: 'OPEN' } })
    if (openCycle) {
      return reply.code(422).send({ error: { code: 'ONE_OPEN_CYCLE', message: 'Ce client a déjà un cycle ouvert' } })
    }

    const lastCycle = await prisma.cycle.findFirst({ where: { clientId }, orderBy: { cycleSequence: 'desc' } })
    const cycleSequence = (lastCycle?.cycleSequence ?? 0) + 1

    const cycle = await prisma.cycle.create({
      data: {
        id: crypto.randomUUID(),
        clientId,
        cycleSequence,
        startDate,
        endDate,
        stakeAmount: body.data.stake_amount,
        maxBoxes: 31,
        status: 'OPEN',
        totalPaid: 0,
        boxesFilled: 0,
      },
    })

    await writeAudit({
      actorId: req.actor.userId, actorRole: req.actor.role,
      action: 'CREATE_CYCLE', entity: 'cycles', entityId: cycle.id,
      after: cycle, ip: req.ip, deviceId: req.actor.deviceId,
    })

    return reply.code(201).send(cycle)
  })

  app.post('/cycles/:id/close', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CONTROLLER') }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const cycle = await prisma.cycle.findUnique({ where: { id } })
    if (!cycle) return reply.code(404).send({ error: notFound('Cycle', id) })
    if (cycle.status !== 'OPEN') return reply.code(422).send({ error: { code: 'CYCLE_NOT_OPEN', message: 'Le cycle n\'est pas ouvert' } })

    const settings = await getSettings(prisma as never)
    const commission = computeCommission(
      settings.commissionStrategy,
      settings.commissionValue,
      cycle.totalPaid,
      cycle.stakeAmount,
      cycle.boxesFilled,
    )
    const netToPay = cycle.totalPaid - commission

    const closed = await prisma.cycle.update({
      where: { id },
      data: {
        status: 'CLOSED',
        commissionAmount: commission,
        netToPay,
        closedAt: new Date(),
      },
    })

    await writeAudit({
      actorId: req.actor.userId, actorRole: req.actor.role,
      action: 'CLOSE_CYCLE', entity: 'cycles', entityId: id,
      after: { commission, netToPay }, ip: req.ip,
    })

    return reply.send(closed)
  })

  app.post('/cycles/:id/cancel', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = cancelSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const cycle = await prisma.cycle.findUnique({ where: { id } })
    if (!cycle) return reply.code(404).send({ error: notFound('Cycle', id) })
    if (cycle.status === 'PAID') return reply.code(422).send({ error: { code: 'CONFLICT', message: 'Impossible d\'annuler un cycle déjà payé' } })

    const cancelled = await prisma.cycle.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledReason: body.data.reason, closedAt: new Date() },
    })

    await writeAudit({
      actorId: req.actor.userId, actorRole: req.actor.role,
      action: 'CANCEL_CYCLE', entity: 'cycles', entityId: id,
      after: { reason: body.data.reason }, ip: req.ip,
    })

    return reply.send(cancelled)
  })

  // Current OPEN cycle for a client (convenience)
  app.get('/clients/:clientId/cycles/open', { preHandler: requireAuth }, async (req, reply) => {
    const { clientId } = req.params as { clientId: string }

    const client = await prisma.client.findUnique({ where: { id: clientId } })
    if (!client) return reply.code(404).send({ error: notFound('Client', clientId) })
    if (req.actor.role === 'COLLECTOR' && client.collectorId !== req.actor.userId) {
      return reply.code(403).send({ error: forbidden() })
    }

    const cycle = await prisma.cycle.findFirst({
      where: { clientId, status: 'OPEN' },
      include: {
        collections: {
          where: { voidedAt: null },
          orderBy: { collectedAt: 'desc' },
          take: 50,
          select: { id: true, amount: true, stakeCount: true, collectedAt: true, businessDate: true, flags: true },
        },
      },
    })

    if (!cycle) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Aucun cycle ouvert' } })

    // Build 31-box grid
    const boxes = Array.from({ length: cycle.maxBoxes }, (_, i) => ({
      box: i + 1,
      filled: i < cycle.boxesFilled,
    }))

    const maxAllowed = cycle.maxBoxes * cycle.stakeAmount - cycle.totalPaid

    return reply.send({ ...cycle, boxes, max_allowed_next: maxAllowed })
  })
}
