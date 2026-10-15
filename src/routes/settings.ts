import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, requireRoles } from '../middleware/auth'
import { writeAudit } from '../lib/audit'

const DEFAULT_SETTINGS: Record<string, unknown> = {
  commission_strategy: 'ONE_STAKE',
  commission_value: 1,
  stake_min: 100,
  stake_max: 10000,
  stake_step: 25,
  cycle_default_length: 31,
  gps_alert_distance_m: 300,
  inactive_days: 5,
  spot_checks_per_collector_week: 5,
  sms_weekly_enabled: true,
  sms_unit_cost_xof: 30,
  office_phone: '+22890000000',
  company_name: 'Tontine Prospera',
  working_hours: { start: '06:00', end: '21:00' },
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/settings', { preHandler: requireAuth }, async (_req, reply) => {
    const rows = await prisma.setting.findMany()
    const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS }
    for (const row of rows) {
      settings[row.key] = row.value
    }
    return reply.send(settings)
  })

  app.patch('/settings', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN') }, async (req, reply) => {
    const updates = req.body as Record<string, unknown>
    const ALLOWED_KEYS = new Set(Object.keys(DEFAULT_SETTINGS))

    const validEntries = Object.entries(updates).filter(([k]) => ALLOWED_KEYS.has(k))
    if (validEntries.length === 0) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'No valid settings keys' } })

    const now = new Date()
    for (const [key, value] of validEntries) {
      await prisma.setting.upsert({
        where: { key },
        create: { key, value: value as never, updatedById: req.actor.userId, updatedAt: now },
        update: { value: value as never, updatedById: req.actor.userId, updatedAt: now },
      })
    }

    await writeAudit({ actorId: req.actor.userId, actorRole: req.actor.role, action: 'UPDATE_SETTINGS', entity: 'settings', after: updates, ip: req.ip })
    return reply.code(204).send()
  })
}
