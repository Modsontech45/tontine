import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireRoles } from '../middleware/auth'
import { writeAudit } from '../lib/audit'
import { sendHandoverAlert } from '../lib/email'
import { verifyOtp } from '../lib/otp'

const confirmSchema = z.object({
  collector_id: z.string().uuid(),
  business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  received_amount: z.number().int().min(0),
  notes: z.string().optional(),
  otp_code: z.string().length(6).optional(),
})

export async function handoverRoutes(app: FastifyInstance) {
  // GET /handovers/pending — collectors with collections on a given date that haven't been confirmed
  app.get('/handovers/pending', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CASHIER') }, async (req, reply) => {
    const dateStr = (req.query as any).date ?? new Date().toISOString().slice(0, 10)
    const date = new Date(dateStr)
    const nextDay = new Date(date); nextDay.setDate(nextDay.getDate() + 1)

    const rows = await prisma.$queryRaw<Array<{
      collector_id: string
      first_name: string
      last_name: string
      phone: string
      expected_amount: number
      collections_count: number
      handover_id: string | null
      handover_status: string | null
      received_amount: number | null
      difference: number | null
      confirmed_at: Date | null
      cashier_first: string | null
      cashier_last: string | null
    }>>`
      SELECT
        u.id                              AS collector_id,
        u.first_name,
        u.last_name,
        u.phone,
        SUM(c.amount)::int               AS expected_amount,
        COUNT(c.id)::int                 AS collections_count,
        h.id                             AS handover_id,
        h.status                         AS handover_status,
        h.received_amount,
        h.difference,
        h.confirmed_at,
        cu.first_name                    AS cashier_first,
        cu.last_name                     AS cashier_last
      FROM collections c
      JOIN users u ON c.collector_id = u.id
      LEFT JOIN cash_handovers h ON h.collector_id = u.id AND h.business_date = ${date}::date
      LEFT JOIN users cu ON h.cashier_id = cu.id
      WHERE c.business_date >= ${date}::date
        AND c.business_date < ${nextDay}::date
        AND c.voided_at IS NULL
      GROUP BY u.id, u.first_name, u.last_name, u.phone,
               h.id, h.status, h.received_amount, h.difference, h.confirmed_at,
               cu.first_name, cu.last_name
      ORDER BY expected_amount DESC
    `

    return reply.send(rows)
  })

  // GET /handovers — paginated list
  app.get('/handovers', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CASHIER') }, async (req, reply) => {
    const q = req.query as any
    const page = parseInt(q.page ?? '1')
    const pageSize = parseInt(q.page_size ?? '25')
    const where: any = {}
    if (q.collector_id) where.collectorId = q.collector_id
    if (q.status) where.status = q.status
    if (q.date) {
      const d = new Date(q.date)
      const d2 = new Date(d); d2.setDate(d2.getDate() + 1)
      where.businessDate = { gte: d, lt: d2 }
    }

    const [data, total] = await Promise.all([
      prisma.cashHandover.findMany({
        where,
        include: {
          collector: { select: { id: true, firstName: true, lastName: true, phone: true } },
          cashier: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: [{ businessDate: 'desc' }, { confirmedAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.cashHandover.count({ where }),
    ])

    return reply.send({ data, total, page, page_size: pageSize })
  })

  // POST /handovers/confirm — cashier confirms receipt of cash
  app.post('/handovers/confirm', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CASHIER') }, async (req, reply) => {
    const body = confirmSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const { collector_id, business_date, received_amount, notes, otp_code } = body.data

    if (otp_code) {
      const valid = await verifyOtp(req.actor.userId, 'CONFIRM_HANDOVER', otp_code)
      if (!valid) return reply.code(422).send({ error: { code: 'INVALID_OTP', message: 'Code OTP invalide ou expiré.' } })
    }

    const date = new Date(business_date)
    const nextDay = new Date(date); nextDay.setDate(nextDay.getDate() + 1)

    const agg = await prisma.collection.aggregate({
      where: {
        collectorId: collector_id,
        businessDate: { gte: date, lt: nextDay },
        voidedAt: null,
      },
      _sum: { amount: true },
      _count: { id: true },
    })

    const expectedAmount = Number(agg._sum.amount ?? 0)
    const collectionsCount = agg._count.id ?? 0

    if (collectionsCount === 0) {
      return reply.code(422).send({ error: { code: 'NO_COLLECTIONS', message: 'Aucun encaissement trouvé pour ce collecteur à cette date' } })
    }

    const difference = received_amount - expectedAmount

    const handover = await prisma.cashHandover.upsert({
      where: { collectorId_businessDate: { collectorId: collector_id, businessDate: date } },
      create: {
        id: crypto.randomUUID(),
        collectorId: collector_id,
        businessDate: date,
        expectedAmount,
        receivedAmount: received_amount,
        difference,
        collectionsCount,
        status: 'CONFIRMED',
        cashierId: req.actor.userId,
        confirmedAt: new Date(),
        notes: notes ?? null,
      },
      update: {
        receivedAmount: received_amount,
        difference,
        expectedAmount,
        collectionsCount,
        status: 'CONFIRMED',
        cashierId: req.actor.userId,
        confirmedAt: new Date(),
        notes: notes ?? null,
      },
      include: {
        collector: { select: { id: true, firstName: true, lastName: true } },
        cashier: { select: { id: true, firstName: true, lastName: true } },
      },
    })

    await prisma.collection.updateMany({
      where: {
        collectorId: collector_id,
        businessDate: { gte: date, lt: nextDay },
        voidedAt: null,
      },
      data: { handoverId: handover.id },
    })

    await writeAudit({
      actorId: req.actor.userId,
      actorRole: req.actor.role,
      action: 'CONFIRM_HANDOVER',
      entity: 'cash_handovers',
      entityId: handover.id,
      after: { collectorId: collector_id, businessDate: business_date, expectedAmount, receivedAmount: received_amount, difference },
      ip: req.ip,
    })

    sendHandoverAlert({
      collectorName: `${handover.collector.firstName} ${handover.collector.lastName}`,
      businessDate: business_date,
      expectedAmount,
      receivedAmount: received_amount,
      difference,
      cashierName: `${handover.cashier?.firstName ?? ''} ${handover.cashier?.lastName ?? ''}`.trim(),
      confirmedAt: new Date(),
    }).catch(() => {})

    return reply.code(201).send(handover)
  })
}
