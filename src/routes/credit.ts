import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, requireRoles } from '../middleware/auth'
import { writeAudit } from '../lib/audit'
import { AppError } from '../lib/errors'
import { verifyOtp } from '../lib/otp'

const CONFIG_ID = 'singleton'

const tierSchema = z.object({ months: z.number().int().min(1), interestPct: z.number().min(0).max(100) })

const updateConfigSchema = z.object({
  minContributingMonths: z.number().int().min(1).max(24),
  maxLoanAmount: z.number().int().min(1000),
  tiers: z.array(tierSchema).min(1).max(6),
  isEnabled: z.boolean(),
  otp_code: z.string().length(6),
})

const requestLoanSchema = z.object({
  clientId: z.string().uuid(),
  amount: z.number().int().min(1000),
  durationMonths: z.number().int().min(1),
  note: z.string().max(500).optional(),
})

const reviewSchema = z.object({ reviewNote: z.string().max(500).optional() })
const repaySchema = z.object({
  amount: z.number().int().min(1),
  note: z.string().max(500).optional(),
})

const REPAYMENT_SELECT = {
  id: true, amount: true, status: true, note: true,
  recordedAt: true, confirmedAt: true,
  collector: { select: { id: true, firstName: true, lastName: true } },
  cashier:   { select: { id: true, firstName: true, lastName: true } },
}

const REPAYMENT_INCLUDE = {
  client:    { select: { id: true, firstName: true, lastName: true, carnetNumber: true, phone: true } },
  collector: { select: { id: true, firstName: true, lastName: true } },
  reviewedBy:{ select: { firstName: true, lastName: true } },
  repayments:{ select: REPAYMENT_SELECT, orderBy: { recordedAt: 'asc' as const } },
}

function withComputed<T extends {
  totalRepay: number
  dueDate: Date | null
  repayments: { amount: number; status: string }[]
}>(loan: T) {
  // Only CONFIRMED repayments count toward the balance
  const paidAmount = loan.repayments
    .filter(r => r.status === 'CONFIRMED')
    .reduce((s, r) => s + r.amount, 0)
  const pendingAmount = loan.repayments
    .filter(r => r.status === 'PENDING')
    .reduce((s, r) => s + r.amount, 0)
  return { ...loan, paidAmount, remainingAmount: loan.totalRepay - paidAmount, pendingAmount }
}

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

    const valid = await verifyOtp(req.actor.userId, 'UPDATE_CREDIT_CONFIG', body.data.otp_code)
    if (!valid) throw new AppError('INVALID_OTP', 'Code de vérification invalide ou expiré.', 422)

    const { otp_code: _, ...configData } = body.data
    const config = await prisma.creditConfig.upsert({
      where: { id: CONFIG_ID },
      update: { ...configData, updatedById: req.actor.userId },
      create: { id: CONFIG_ID, ...configData, updatedById: req.actor.userId },
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

  // ── GET all loan requests (admin/controller/cashier) ─────────────────────
  app.get('/credit/requests', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CONTROLLER', 'CASHIER') }, async (req, reply) => {
    const { status } = req.query as { status?: string }
    const requests = await prisma.loanRequest.findMany({
      where: status ? { status: status as any } : undefined,
      include: REPAYMENT_INCLUDE,
      orderBy: { requestedAt: 'desc' },
    })
    return reply.send({ data: requests.map(withComputed) })
  })

  // ── GET active loans (APPROVED, not yet REPAID) — admin + cashier ─────────
  app.get('/credit/active-loans', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CONTROLLER', 'CASHIER') }, async (_req, reply) => {
    const loans = await prisma.loanRequest.findMany({
      where: { status: 'APPROVED' },
      include: REPAYMENT_INCLUDE,
      orderBy: { reviewedAt: 'asc' },
    })
    return reply.send({ data: loans.map(withComputed) })
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

    const now = new Date()
    const dueDate = new Date(now)
    dueDate.setMonth(dueDate.getMonth() + loan.durationMonths)
    const updated = await prisma.loanRequest.update({
      where: { id },
      data: { status: 'APPROVED', reviewedById: req.actor.userId, reviewedAt: now, reviewNote: body.data.reviewNote, dueDate },
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

  // ── POST repay — collector records field payment (PENDING) ───────────────
  // OR cashier records direct payment (CONFIRMED, legacy/direct)
  app.post('/credit/requests/:id/repay', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CASHIER', 'COLLECTOR') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = repaySchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const loan = await prisma.loanRequest.findUnique({
      where: { id },
      include: { repayments: { select: { amount: true, status: true } } },
    })
    if (!loan) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Demande introuvable' } })
    if (loan.status !== 'APPROVED') return reply.code(409).send({ error: { code: 'INVALID_STATUS', message: 'Ce prêt n\'est pas actif' } })

    const confirmedPaid = loan.repayments.filter(r => r.status === 'CONFIRMED').reduce((s, r) => s + r.amount, 0)
    const remaining = loan.totalRepay - confirmedPaid
    if (body.data.amount > remaining) {
      return reply.code(422).send({ error: { code: 'AMOUNT_EXCEEDED', message: `Montant maximum à rembourser: ${remaining} FCFA` } })
    }

    const isCollector = req.actor.role === 'COLLECTOR'
    await prisma.loanRepayment.create({
      data: {
        loanId: id,
        amount: body.data.amount,
        note: body.data.note,
        status: isCollector ? 'PENDING' : 'CONFIRMED',
        collectorId: isCollector ? req.actor.userId : null,
        cashierId: isCollector ? null : req.actor.userId,
        confirmedAt: isCollector ? null : new Date(),
      },
    })

    // Only auto-close when cashier pays directly (CONFIRMED)
    if (!isCollector) {
      const newTotal = confirmedPaid + body.data.amount
      if (newTotal >= loan.totalRepay) {
        await prisma.loanRequest.update({ where: { id }, data: { status: 'REPAID' } })
      }
    }

    await writeAudit({ actorId: req.actor.userId, actorRole: req.actor.role, action: 'LOAN_REPAYMENT_RECORDED', entity: 'loan_requests', entityId: id, ip: req.ip })
    const updated = await prisma.loanRequest.findUnique({ where: { id }, include: REPAYMENT_INCLUDE })
    return reply.code(201).send(withComputed(updated!))
  })

  // ── POST confirm repayment (cashier validates field payment) ─────────────
  app.post('/credit/repayments/:repaymentId/confirm', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CASHIER') }, async (req, reply) => {
    const { repaymentId } = req.params as { repaymentId: string }

    const repayment = await prisma.loanRepayment.findUnique({
      where: { id: repaymentId },
      include: { loan: { include: { repayments: { select: { id: true, amount: true, status: true } } } } },
    })
    if (!repayment) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Remboursement introuvable' } })
    if (repayment.status !== 'PENDING') return reply.code(409).send({ error: { code: 'INVALID_STATUS', message: 'Déjà traité' } })

    await prisma.loanRepayment.update({
      where: { id: repaymentId },
      data: { status: 'CONFIRMED', cashierId: req.actor.userId, confirmedAt: new Date() },
    })

    // Check if loan is now fully paid
    const allConfirmed = repayment.loan.repayments
      .filter(r => r.status === 'CONFIRMED' || r.id === repaymentId)
      .reduce((s, r) => s + r.amount, 0) + repayment.amount
    if (allConfirmed >= repayment.loan.totalRepay) {
      await prisma.loanRequest.update({ where: { id: repayment.loanId }, data: { status: 'REPAID' } })
    }

    await writeAudit({ actorId: req.actor.userId, actorRole: req.actor.role, action: 'LOAN_REPAYMENT_CONFIRMED', entity: 'loan_repayments', entityId: repaymentId, ip: req.ip })
    const updated = await prisma.loanRequest.findUnique({ where: { id: repayment.loanId }, include: REPAYMENT_INCLUDE })
    return reply.send(withComputed(updated!))
  })

  // ── POST reject repayment ─────────────────────────────────────────────────
  app.post('/credit/repayments/:repaymentId/reject', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CASHIER') }, async (req, reply) => {
    const { repaymentId } = req.params as { repaymentId: string }
    const body = z.object({ note: z.string().max(300).optional() }).safeParse(req.body)

    const repayment = await prisma.loanRepayment.findUnique({ where: { id: repaymentId } })
    if (!repayment) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Remboursement introuvable' } })
    if (repayment.status !== 'PENDING') return reply.code(409).send({ error: { code: 'INVALID_STATUS', message: 'Déjà traité' } })

    await prisma.loanRepayment.update({
      where: { id: repaymentId },
      data: { status: 'REJECTED', cashierId: req.actor.userId, confirmedAt: new Date(), note: body.success && body.data.note ? body.data.note : repayment.note },
    })
    await writeAudit({ actorId: req.actor.userId, actorRole: req.actor.role, action: 'LOAN_REPAYMENT_REJECTED', entity: 'loan_repayments', entityId: repaymentId, ip: req.ip })
    return reply.code(204).send()
  })

  // ── GET pending repayments (cashier inbox) ────────────────────────────────
  app.get('/credit/pending-repayments', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CASHIER') }, async (_req, reply) => {
    const repayments = await prisma.loanRepayment.findMany({
      where: { status: 'PENDING' },
      include: {
        loan: {
          select: {
            id: true, amount: true, totalRepay: true, dueDate: true,
            client: { select: { id: true, firstName: true, lastName: true, carnetNumber: true, phone: true } },
          },
        },
        collector: { select: { id: true, firstName: true, lastName: true } },
        cashier:   { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { recordedAt: 'asc' },
    })
    return reply.send({ data: repayments })
  })

  // ── GET single client's loan history (all roles) ──────────────────────────
  app.get('/credit/client/:clientId', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CONTROLLER', 'CASHIER', 'COLLECTOR') }, async (req, reply) => {
    const { clientId } = req.params as { clientId: string }
    const loans = await prisma.loanRequest.findMany({
      where: { clientId },
      include: REPAYMENT_INCLUDE,
      orderBy: { requestedAt: 'desc' },
    })
    return reply.send({ data: loans.map(withComputed) })
  })
}
