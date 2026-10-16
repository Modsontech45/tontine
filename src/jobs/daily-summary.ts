import cron from 'node-cron'
import { prisma } from '../lib/prisma'
import { sendDailySummary } from '../lib/email'

export function startDailySummaryJob() {
  // Every day at 19:00 Lomé time (UTC+0, so 19:00 UTC)
  cron.schedule('0 19 * * *', async () => {
    try {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const tomorrow = new Date(today)
      tomorrow.setDate(tomorrow.getDate() + 1)

      const [collected, versed, handovers, activeCollectors, pendingVoids] = await Promise.all([
        prisma.collection.aggregate({
          where: { businessDate: { gte: today, lt: tomorrow }, voidedAt: null },
          _sum: { amount: true }, _count: { id: true },
        }),
        prisma.cashHandover.aggregate({
          where: { businessDate: { gte: today, lt: tomorrow }, status: { in: ['CONFIRMED', 'VALIDATED'] } },
          _sum: { receivedAmount: true }, _count: { id: true },
        }),
        prisma.cashHandover.findMany({
          where: { businessDate: { gte: today, lt: tomorrow } },
          include: { collector: { select: { firstName: true, lastName: true } } },
        }),
        prisma.user.count({ where: { role: 'COLLECTOR', isActive: true } }),
        prisma.voidRequest.count({ where: { status: 'PENDING' } }),
      ])

      await sendDailySummary({
        date: today.toLocaleDateString('fr-FR', { timeZone: 'Africa/Lome', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        collected: collected._sum.amount ?? 0,
        collectionsCount: collected._count.id ?? 0,
        versed: versed._sum.receivedAmount ?? 0,
        versedsCount: versed._count.id ?? 0,
        gap: (collected._sum.amount ?? 0) - (versed._sum.receivedAmount ?? 0),
        activeCollectors,
        pendingVoids,
        handovers,
      })
    } catch (e) {
      console.error('[daily-summary]', e)
    }
  }, { timezone: 'Africa/Lome' })
}
