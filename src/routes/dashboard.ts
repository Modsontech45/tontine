import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { requireRoles } from '../middleware/auth'

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/dashboard/admin', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CONTROLLER', 'CASHIER') }, async () => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1)
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)

    const [
      activeClients, suspendedClients, closedClients,
      openCycles, closedCycles, paidCycles, cancelledCycles,
      pendingAlerts, pendingVoids,
      versedAgg,
    ] = await Promise.all([
      prisma.client.count({ where: { status: 'ACTIVE' } }),
      prisma.client.count({ where: { status: 'SUSPENDED' } }),
      prisma.client.count({ where: { status: 'CLOSED' } }),
      prisma.cycle.count({ where: { status: 'OPEN' } }),
      prisma.cycle.count({ where: { status: 'CLOSED' } }),
      prisma.cycle.count({ where: { status: 'PAID' } }),
      prisma.cycle.count({ where: { status: 'CANCELLED' } }),
      prisma.alert.count({ where: { status: 'OPEN' } }),
      prisma.voidRequest.count({ where: { status: 'PENDING' } }),
      prisma.cashHandover.aggregate({
        where: { businessDate: { gte: today, lt: tomorrow }, status: { in: ['CONFIRMED', 'VALIDATED'] } },
        _sum: { receivedAmount: true },
      }),
    ])

    // Today's collections
    const todayAgg = await prisma.collection.aggregate({
      where: { businessDate: { gte: today, lt: tomorrow }, voidedAt: null },
      _sum: { amount: true }, _count: { id: true },
    })

    // Expected today = sum of stake_amount for all open cycles with remaining boxes
    const expectedRaw = await prisma.$queryRaw<[{ expected: number }]>`
      SELECT COALESCE(SUM(stake_amount), 0)::int AS expected
      FROM cycles
      WHERE status = 'OPEN' AND boxes_filled < max_boxes
    `
    const expectedToday = expectedRaw[0]?.expected ?? 0
    const remainingToday = Math.max(0, expectedToday - (todayAgg._sum.amount ?? 0))

    // Month collections
    const monthAgg = await prisma.collection.aggregate({
      where: { businessDate: { gte: monthStart, lt: tomorrow }, voidedAt: null },
      _sum: { amount: true }, _count: { id: true },
    })

    // Daily collections — last 30 days
    const daily = await prisma.$queryRaw<Array<{ date: string; amount: number; count: number }>>`
      SELECT
        TO_CHAR(business_date, 'YYYY-MM-DD') as date,
        SUM(amount)::int                     as amount,
        COUNT(*)::int                        as count
      FROM collections
      WHERE business_date >= CURRENT_DATE - INTERVAL '30 days'
        AND voided_at IS NULL
      GROUP BY business_date
      ORDER BY business_date
    `

    // Monthly revenue — last 6 months
    const monthly = await prisma.$queryRaw<Array<{ month: string; amount: number; count: number }>>`
      SELECT
        TO_CHAR(DATE_TRUNC('month', business_date), 'Mon YYYY') as month,
        SUM(amount)::int                                         as amount,
        COUNT(*)::int                                            as count
      FROM collections
      WHERE business_date >= CURRENT_DATE - INTERVAL '180 days'
        AND voided_at IS NULL
      GROUP BY DATE_TRUNC('month', business_date)
      ORDER BY DATE_TRUNC('month', business_date)
    `

    // Collections by zone — last 7 days
    const byZone = await prisma.$queryRaw<Array<{ zone: string; amount: number; count: number }>>`
      SELECT
        COALESCE(z.name, 'Non assigné') as zone,
        SUM(col.amount)::int            as amount,
        COUNT(*)::int                   as count
      FROM collections col
      JOIN clients cl ON col.client_id = cl.id
      LEFT JOIN zones z ON cl.zone_id = z.id
      WHERE col.business_date >= CURRENT_DATE - INTERVAL '7 days'
        AND col.voided_at IS NULL
      GROUP BY z.name
      ORDER BY amount DESC
    `

    // Top collectors — last 30 days
    const topCollectors = await prisma.$queryRaw<Array<{ name: string; amount: number; clients: number; count: number }>>`
      SELECT
        u.first_name || ' ' || u.last_name as name,
        SUM(col.amount)::int               as amount,
        COUNT(DISTINCT col.client_id)::int as clients,
        COUNT(*)::int                      as count
      FROM collections col
      JOIN users u ON col.collector_id = u.id
      WHERE col.business_date >= CURRENT_DATE - INTERVAL '30 days'
        AND col.voided_at IS NULL
      GROUP BY u.id, u.first_name, u.last_name
      ORDER BY amount DESC
      LIMIT 8
    `

    // Cycle status breakdown
    const cycleBreakdown = [
      { status: 'OPEN',      label: 'En cours',  count: openCycles },
      { status: 'CLOSED',    label: 'Clôturé',   count: closedCycles },
      { status: 'PAID',      label: 'Payé',       count: paidCycles },
      { status: 'CANCELLED', label: 'Annulé',     count: cancelledCycles },
    ]

    // Alert type breakdown (open only)
    const alertsByType = await prisma.$queryRaw<Array<{ type: string; count: number }>>`
      SELECT type, COUNT(*)::int as count
      FROM alerts
      WHERE status = 'OPEN'
      GROUP BY type
      ORDER BY count DESC
    `

    // Stake distribution
    const stakeDistrib = await prisma.$queryRaw<Array<{ stake: number; clients: number }>>`
      SELECT stake_amount::int as stake, COUNT(DISTINCT client_id)::int as clients
      FROM cycles
      WHERE status = 'OPEN'
      GROUP BY stake_amount
      ORDER BY stake_amount
    `

    return {
      kpis: {
        activeClients, suspendedClients, closedClients,
        todayAmount: todayAgg._sum.amount ?? 0,
        todayCount:  todayAgg._count.id  ?? 0,
        monthAmount: monthAgg._sum.amount ?? 0,
        monthCount:  monthAgg._count.id  ?? 0,
        openCycles, closedCycles, paidCycles, cancelledCycles,
        pendingAlerts, pendingVoids,
        todayVersed: Number(versedAgg._sum.receivedAmount ?? 0),
        todayGap: (todayAgg._sum.amount ?? 0) - Number(versedAgg._sum.receivedAmount ?? 0),
        expectedToday,
        remainingToday,
      },
      dailyCollections: daily,
      monthlyRevenue:   monthly,
      collectionsByZone: byZone,
      topCollectors,
      cycleBreakdown,
      alertsByType,
      stakeDistribution: stakeDistrib,
    }
  })
}
