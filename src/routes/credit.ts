import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, requireRoles } from '../middleware/auth'
import { writeAudit } from '../lib/audit'
import { AppError } from '../lib/errors'

const CONFIG_ID = 'singleton'

const tierSchema = z.object({ months: z.number().int().min(1), interestPct: z.number().min(0).max(100) })

const updateConfigSchema = z.object({
  minContributingMonths: z.number().int().min(1).max(24),
  maxLoanAmount: z.number().int().min(1000),
  tiers: z.array(tierSchema).min(1).max(6),
  isEnabled: z.boolean(),
})

const requestLoanSchema = z.object({
  clientId: z.string().uuid(),
  amount: z.number().int().min(1000),
  durationMonths: z.number().int().min(1),
  note: z.string().max(500).optional(),
})

const reviewSchema = z.object({ reviewNote: z.string().max(500).optional() })

async function getOrCreateConfig() {
  return prisma.creditConfig.upsert({
    where: { id: CONFIG_ID },
    update: {},
    create: { id: CONFIG_ID },
  })
}

async function getEligibility(clientId: string, config: Awaited<ReturnType<typeof getOrCreateConfig>>) {
  const [client, contributingMonths, activeLoan] = await Promise.all([
    prisma.client.findUnique({ where: { id: clientId }, select: { id: true, status: true, firstName: true, lastName: true, carnetNumber: true } }),
    prisma.$queryRaw<[{ months: number }]>`
      SELECT COUNT(DISTINCT DATE_TRUNC('month', business_date))::int AS months
      FROM collections
      WHERE client_id = ${clientId}::uuid AND voided_at IS NULL
    `,
    prisma.loanRequest.findFirst({
      where: { clientId, status: { in: ['PENDING', 'APPROVED'] } },
      select: { id: true, status: true, amount: true, requestedAt: true },
    }),
  ])

  if (!client) throw new AppError('NOT_FOUND', 'Client introuvable', 404)

  const months = contributingMonths[0]?.months ?? 0
  const eligible = client.status === 'ACTIVE' && months >= config.minContributingMonths && !activeLoan && config.isEnabled
  const monthsRemaining = Math.max(0, config.minContributingMonths - months)

  return { eligible, months, monthsRemaining, activeLoan, client }
}

export async function creditRoutes(app: FastifyInstance): Promise<void> {
  // ── GET config (all authenticated, not cashier) ───────────────────────────
  app.get('/credit/config', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CONTROLLER', 'COLLECTOR') }, async (_req, reply) => {
    const config = await getOrCreateConfig()
    return reply.send(config)
  })

  // ── PUT config (admin only) ───────────────────────────────────────────────
  app.put('/credit/config', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN') }, async (req, reply) => {
    const body = updateConfigSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const config = await prisma.creditConfig.upsert({
      where: { id: CONFIG_ID },
      update: { ...body.data, updatedById: req.actor.userId },
      create: { id: CONFIG_ID, ...body.data, updatedById: req.actor.userId },
    })

    await writeAudit({ actorId: req.actor.userId, actorRole: req.actor.role, action: 'UPDATE_CREDIT_CONFIG', entity: 'credit_config', ip: req.ip })
    return reply.send(config)
  })

  // ── GET eligibility for a client ─────────────────────────────────────────
  app.get('/credit/eligibility/:clientId', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CONTROLLER', 'COLLECTOR') }, async (req, reply) => {
    const { clientId } = req.params as { clientId: string }
    const config = await getOrCreateConfig()
    const result = await getEligibility(clientId, config)
    return reply.send({
      eligible: result.eligible,
      contributingMonths: result.months,
      requiredMonths: config.minContributingMonths,
      monthsRemaining: result.monthsRemaining,
      maxLoanAmount: config.maxLoanAmount,
      tiers: config.tiers,
      isEnabled: config.isEnabled,
      activeLoan: result.activeLoan,
    })
  })

  // ── POST loan request (collector only) ───────────────────────────────────
  app.post('/credit/requests', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'COLLECTOR') }, async (req, reply) => {
    const body = requestLoanSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const config = await getOrCreateConfig()
    if (!config.isEnabled) return reply.code(403).send({ error: { code: 'CREDIT_DISABLED', message: 'Le crédit est désactivé' } })

    const { eligible, activeLoan } = await getEligibility(body.data.clientId, config)
    if (!eligible) {
      if (activeLoan) return reply.code(409).send({ error: { code: 'LOAN_ACTIVE', message: 'Ce client a déjà une demande en cours' } })
      return reply.code(422).send({ error: { code: 'NOT_ELIGIBLE', message: 'Ce client n\'est pas encore éligible au crédit' } })
    }

    if (body.data.amount > config.maxLoanAmount) {
      return reply.code(422).send({ error: { code: 'AMOUNT_EXCEEDED', message: `Montant maximum: ${config.maxLoanAmount} FCFA` } })
    }

    const tiers = config.tiers as Array<{ months: number; interestPct: number }>
    const tier = tiers.find(t => t.months === body.data.durationMonths)
    if (!tier) return reply.code(422).send({ error: { code: 'INVALID_DURATION', message: 'Durée non configurée' } })

    const interest = Math.round(body.data.amount * tier.interestPct / 100)
    const totalRepay = body.data.amount + interest

    const loan = await prisma.loanRequest.create({
      data: {
        clientId: body.data.clientId,
        collectorId: req.actor.userId,
        amount: body.data.amount,
        durationMonths: body.data.durationMonths,
        interestPct: tier.interestPct,
        totalRepay,
        note: body.data.note,
      },
    })

    await writeAudit({ actorId: req.actor.userId, actorRole: req.actor.role, action: 'CREATE_LOAN_REQUEST', entity: 'loan_requests', entityId: loan.id as unknown as string, ip: req.ip })
    return reply.code(201).send(loan)
  })

  // ── GET all loan requests (admin/controller) ──────────────────────────────
  app.get('/credit/requests', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CONTROLLER') }, async (req, reply) => {
    const { status } = req.query as { status?: string }
    const requests = await prisma.loanRequest.findMany({
      where: status ? { status: status as any } : undefined,
      include: {
        client: { select: { id: true, firstName: true, lastName: true, carnetNumber: true, phone: true } },
        collector: { select: { id: true, firstName: true, lastName: true } },
        reviewedBy: { select: { firstName: true, lastName: true } },
      },
      orderBy: { requestedAt: 'desc' },
    })
    return reply.send({ data: requests })
  })

  // ── GET collector's own requests ──────────────────────────────────────────
  app.get('/credit/my-requests', { preHandler: requireRoles('COLLECTOR') }, async (req, reply) => {
    const requests = await prisma.loanRequest.findMany({
      where: { collectorId: req.actor.userId },
      include: {
        client: { select: { id: true, firstName: true, lastName: true, carnetNumber: true } },
        reviewedBy: { select: { firstName: true, lastName: true } },
      },
      orderBy: { requestedAt: 'desc' },
    })
    return reply.send({ data: requests })
  })

  // ── POST approve ──────────────────────────────────────────────────────────
  app.post('/credit/requests/:id/approve', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CONTROLLER') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = reviewSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const loan = await prisma.loanRequest.findUnique({ where: { id } })
    if (!loan) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Demande introuvable' } })
    if (loan.status !== 'PENDING') return reply.code(409).send({ error: { code: 'INVALID_STATUS', message: 'Demande déjà traitée' } })

    const updated = await prisma.loanRequest.update({
      where: { id },
      data: { status: 'APPROVED', reviewedById: req.actor.userId, reviewedAt: new Date(), reviewNote: body.data.reviewNote },
    })
    await writeAudit({ actorId: req.actor.userId, actorRole: req.actor.role, action: 'APPROVE_LOAN', entity: 'loan_requests', entityId: id, ip: req.ip })
    return reply.send(updated)
  })

  // ── POST reject ───────────────────────────────────────────────────────────
  app.post('/credit/requests/:id/reject', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CONTROLLER') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = reviewSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const loan = await prisma.loanRequest.findUnique({ where: { id } })
    if (!loan) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Demande introuvable' } })
    if (loan.status !== 'PENDING') return reply.code(409).send({ error: { code: 'INVALID_STATUS', message: 'Demande déjà traitée' } })

    const updated = await prisma.loanRequest.update({
      where: { id },
      data: { status: 'REJECTED', reviewedById: req.actor.userId, reviewedAt: new Date(), reviewNote: body.data.reviewNote },
    })
    await writeAudit({ actorId: req.actor.userId, actorRole: req.actor.role, action: 'REJECT_LOAN', entity: 'loan_requests', entityId: id, ip: req.ip })
    return reply.send(updated)
  })
}
