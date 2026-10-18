import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { requireRoles } from '../middleware/auth'

export async function notificationRoutes(app: FastifyInstance) {
  app.get('/notifications/count', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CONTROLLER', 'CASHIER') }, async () => {
    const [openAlerts, pendingDevices, pendingLoans] = await Promise.all([
      prisma.alert.count({ where: { status: 'OPEN' } }),
      prisma.device.count({ where: { status: 'PENDING' } }),
      prisma.loanRequest.count({ where: { status: 'PENDING' } }),
    ])
    return { openAlerts, pendingDevices, pendingLoans, total: openAlerts + pendingDevices + pendingLoans }
  })
}
