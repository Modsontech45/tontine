import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, requireRoles } from '../middleware/auth'
import { writeAudit } from '../lib/audit'
import { businessDate, formatDateFr } from '../lib/dates'
import { buildQrPayload, verifyQrPayload } from '../lib/qr'
import { applyCollectionToCycle, getSettings, validateCollectionAmount } from '../services/cycleService'
import { AppError } from '../lib/errors'

const pushSchema = z.object({
  device_id: z.string().uuid(),
  device_now: z.string().datetime({ offset: true }),
  clients: z.array(z.record(z.unknown())).default([]),
  cycles: z.array(z.record(z.unknown())).default([]),
  collections: z.array(z.record(z.unknown())).default([]),
  void_requests: z.array(z.record(z.unknown())).default([]),
})

const clientPushSchema = z.object({
  id: z.string().uuid(),
  carnet_number: z.string().min(1),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  phone: z.string().regex(/^\+228\d{8}$/),
  phone_alt: z.string().nullable().optional(),
  address_text: z.string().default(''),
  landmark: z.string().nullable().optional(),
  latitude: z.number(),
  longitude: z.number(),
  gps_accuracy_m: z.number(),
  zone_id: z.string().uuid().nullable().optional(),
  collector_id: z.string().uuid(),
  status: z.string().default('ACTIVE'),
  activity: z.string().nullable().optional(),
  registered_at: z.string().datetime({ offset: true }),
  notes: z.string().nullable().optional(),
  sms_opt_out: z.boolean().default(false),
})

const cyclePushSchema = z.object({
  id: z.string().uuid(),
  client_id: z.string().uuid(),
  cycle_sequence: z.number().int().positive(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  stake_amount: z.number().int().positive(),
  max_boxes: z.number().int().positive().default(31),
  status: z.string().default('OPEN'),
})

const collectionPushSchema = z.object({
  id: z.string().uuid(),
  client_id: z.string().uuid(),
  cycle_id: z.string().uuid(),
  collector_id: z.string().uuid(),
  device_id: z.string().uuid(),
  amount: z.number().int().positive(),
  collected_at: z.string().datetime({ offset: true }),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  gps_accuracy_m: z.number().nullable().optional(),
})

const voidPushSchema = z.object({
  id: z.string().uuid(),
  collection_id: z.string().uuid(),
  reason: z.string().min(1),
})

type Rejection = { entity: string; id: string; code: string; message: string }

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  // ─── PUSH ─────────────────────────────────────────────────────────────────
  app.post('/sync/push', { preHandler: requireAuth }, async (req, reply) => {
    const body = pushSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const { device_id, device_now, clients, cycles, collections, void_requests } = body.data
    const collectorId = req.actor.userId
    const serverNow = new Date()
    const deviceNow = new Date(device_now)

    const accepted: Record<string, string[]> = { clients: [], cycles: [], collections: [], void_requests: [] }
    const rejected: Rejection[] = []

    // ── Clients ──────────────────────────────────────────────────────────────
    for (const rawClient of clients) {
      const parsed = clientPushSchema.safeParse(rawClient)
      if (!parsed.success) { rejected.push({ entity: 'client', id: (rawClient as any).id ?? '', code: 'VALIDATION_ERROR', message: parsed.error.message }); continue }
      const c = parsed.data

      // Collector can only register clients assigned to themselves
      if (c.collector_id !== collectorId && req.actor.role === 'COLLECTOR') {
        rejected.push({ entity: 'client', id: c.id, code: 'CLIENT_NOT_ASSIGNED', message: 'Vous ne pouvez pas enregistrer des clients pour un autre collecteur' })
        continue
      }

      // Validate sticker
      const sticker = await prisma.carnetSticker.findUnique({ where: { carnetNumber: c.carnet_number } })
      if (!sticker) { rejected.push({ entity: 'client', id: c.id, code: 'STICKER_NOT_FOUND', message: `Carnet ${c.carnet_number} inconnu` }); continue }
      if (sticker.status === 'USED') { rejected.push({ entity: 'client', id: c.id, code: 'STICKER_ALREADY_USED', message: `Carnet ${c.carnet_number} déjà utilisé` }); continue }
      if (req.actor.role === 'COLLECTOR' && sticker.assignedCollectorId !== collectorId) {
        rejected.push({ entity: 'client', id: c.id, code: 'STICKER_NOT_ASSIGNED', message: `Carnet ${c.carnet_number} ne vous est pas assigné` }); continue
      }

      try {
        await prisma.$transaction(async (tx) => {
          await tx.client.upsert({
            where: { id: c.id },
            create: {
              id: c.id, carnetNumber: c.carnet_number,
              firstName: c.first_name, lastName: c.last_name,
              phone: c.phone, phoneAlt: c.phone_alt ?? null,
              addressText: c.address_text, landmark: c.landmark ?? null,
              latitude: c.latitude, longitude: c.longitude, gpsAccuracyM: c.gps_accuracy_m,
              zoneId: c.zone_id ?? null,
              collectorId: c.collector_id, registeredById: req.actor.userId,
              registeredAt: new Date(c.registered_at),
              status: 'ACTIVE', smsOptOut: c.sms_opt_out, activity: c.activity ?? null, notes: c.notes ?? null,
            },
            update: {
              phoneAlt: c.phone_alt ?? null, landmark: c.landmark ?? null,
              addressText: c.address_text, activity: c.activity ?? null, notes: c.notes ?? null,
            },
          })
          await tx.carnetSticker.update({ where: { carnetNumber: c.carnet_number }, data: { status: 'USED', usedByClientId: c.id } })
        })
        accepted.clients.push(c.id)
      } catch (e: any) {
        rejected.push({ entity: 'client', id: c.id, code: 'DB_ERROR', message: e.message })
      }
    }

    // ── Cycles ────────────────────────────────────────────────────────────────
    const settings = await getSettings(prisma)
    for (const rawCycle of cycles) {
      const parsed = cyclePushSchema.safeParse(rawCycle)
      if (!parsed.success) { rejected.push({ entity: 'cycle', id: (rawCycle as any).id ?? '', code: 'VALIDATION_ERROR', message: parsed.error.message }); continue }
      const c = parsed.data

      // Check client belongs to collector
      const client = await prisma.client.findUnique({ where: { id: c.client_id } })
      if (!client) { rejected.push({ entity: 'cycle', id: c.id, code: 'CLIENT_NOT_FOUND', message: 'Client inconnu' }); continue }
      if (req.actor.role === 'COLLECTOR' && client.collectorId !== collectorId) {
        rejected.push({ entity: 'cycle', id: c.id, code: 'CLIENT_NOT_ASSIGNED', message: 'Client non assigné' }); continue
      }

      const openCycle = await prisma.cycle.findFirst({ where: { clientId: c.client_id, status: 'OPEN', NOT: { id: c.id } } })
      if (openCycle) { rejected.push({ entity: 'cycle', id: c.id, code: 'ONE_OPEN_CYCLE', message: 'Ce client a déjà un cycle ouvert' }); continue }

      try {
        await prisma.cycle.upsert({
          where: { id: c.id },
          create: {
            id: c.id, clientId: c.client_id, cycleSequence: c.cycle_sequence,
            startDate: new Date(c.start_date), endDate: new Date(c.end_date),
            stakeAmount: c.stake_amount, maxBoxes: c.max_boxes, status: 'OPEN',
            totalPaid: 0, boxesFilled: 0,
          },
          update: {},
        })
        accepted.cycles.push(c.id)
      } catch (e: any) {
        rejected.push({ entity: 'cycle', id: c.id, code: 'DB_ERROR', message: e.message })
      }
    }

    // ── Collections ───────────────────────────────────────────────────────────
    for (const rawCol of collections) {
      const parsed = collectionPushSchema.safeParse(rawCol)
      if (!parsed.success) { rejected.push({ entity: 'collection', id: (rawCol as any).id ?? '', code: 'VALIDATION_ERROR', message: parsed.error.message }); continue }
      const col = parsed.data

      // Idempotency: already exists → accepted silently
      const existing = await prisma.collection.findUnique({ where: { id: col.id } })
      if (existing) { accepted.collections.push(col.id); continue }

      // Authorization
      if (req.actor.role === 'COLLECTOR' && col.collector_id !== collectorId) {
        rejected.push({ entity: 'collection', id: col.id, code: 'CLIENT_NOT_ASSIGNED', message: 'Collecteur non autorisé' }); continue
      }
      const client = await prisma.client.findUnique({ where: { id: col.client_id } })
      if (!client) { rejected.push({ entity: 'collection', id: col.id, code: 'CLIENT_NOT_FOUND', message: 'Client inconnu' }); continue }
      if (req.actor.role === 'COLLECTOR' && client.collectorId !== collectorId) {
        rejected.push({ entity: 'collection', id: col.id, code: 'CLIENT_NOT_ASSIGNED', message: 'Client non assigné' }); continue
      }

      try {
        await prisma.$transaction(async (tx) => {
          const cycle = await tx.cycle.findUnique({ where: { id: col.cycle_id } })
          if (!cycle || cycle.status !== 'OPEN') {
            throw new AppError(422, 'CYCLE_NOT_OPEN', 'Le cycle n\'est pas ouvert')
          }
          validateCollectionAmount(col.amount, cycle as any)

          const collectedAt = new Date(col.collected_at)
          const bDate = businessDate(collectedAt)
          const stakeCount = col.amount / cycle.stakeAmount

          // Compute flags
          const flags: string[] = []
          if (col.latitude == null) flags.push('GPS_MISSING')
          else {
            if ((col.gps_accuracy_m ?? 0) > 100) flags.push('GPS_LOW_ACCURACY')
            const dist = haversineM(col.latitude, col.longitude, client.latitude, client.longitude)
            if (dist > (settings.gpsAlertDistanceM ?? 300)) flags.push('GPS_FAR')
          }
          const hour = new Date(col.collected_at).getHours()
          if (hour >= 21 || hour < 5) flags.push('OUTSIDE_HOURS')
          // Late sync
          const syncDelaySec = (serverNow.getTime() - new Date(col.collected_at).getTime()) / 1000
          if (syncDelaySec > 86400) flags.push('LATE_SYNC')
          // Clock skew
          if (Math.abs(serverNow.getTime() - deviceNow.getTime()) > 10 * 60 * 1000) flags.push('DEVICE_CLOCK_SKEW')

          await tx.collection.create({
            data: {
              id: col.id, clientId: col.client_id, cycleId: col.cycle_id,
              collectorId: col.collector_id, deviceId: device_id,
              amount: col.amount, stakeCount: stakeCount,
              isAppoint: col.amount % cycle.stakeAmount !== 0,
              collectedAt, businessDate: bDate, receivedAt: serverNow,
              latitude: col.latitude ?? null, longitude: col.longitude ?? null,
              gpsAccuracyM: col.gps_accuracy_m ?? null,
              distanceFromClientM: col.latitude != null
                ? haversineM(col.latitude, col.longitude, client.latitude, client.longitude)
                : null,
              flags,
            },
          })

          await applyCollectionToCycle(col.cycle_id, col.amount, tx as any)
        })
        accepted.collections.push(col.id)
      } catch (e: any) {
        const code = e instanceof AppError ? e.code : 'DB_ERROR'
        rejected.push({ entity: 'collection', id: col.id, code, message: e.message })
      }
    }

    // ── Void requests ──────────────────────────────────────────────────────────
    for (const rawVoid of void_requests) {
      const parsed = voidPushSchema.safeParse(rawVoid)
      if (!parsed.success) { rejected.push({ entity: 'void_request', id: (rawVoid as any).id ?? '', code: 'VALIDATION_ERROR', message: parsed.error.message }); continue }
      const v = parsed.data

      const existing = await prisma.voidRequest.findUnique({ where: { id: v.id } })
      if (existing) { accepted.void_requests.push(v.id); continue }

      const collection = await prisma.collection.findUnique({ where: { id: v.collection_id } })
      if (!collection) { rejected.push({ entity: 'void_request', id: v.id, code: 'COLLECTION_NOT_FOUND', message: 'Encaissement inconnu' }); continue }
      if (req.actor.role === 'COLLECTOR' && collection.collectorId !== collectorId) {
        rejected.push({ entity: 'void_request', id: v.id, code: 'CLIENT_NOT_ASSIGNED', message: 'Non autorisé' }); continue
      }

      await prisma.voidRequest.create({
        data: { id: v.id, collectionId: v.collection_id, requestedById: req.actor.userId, reason: v.reason, status: 'PENDING' },
      })
      accepted.void_requests.push(v.id)
    }

    return reply.send({ accepted, rejected, server_now: serverNow.toISOString() })
  })

  // ─── PULL ─────────────────────────────────────────────────────────────────
  app.get('/sync/pull', { preHandler: requireAuth }, async (req, reply) => {
    const { since } = req.query as { since?: string }
    const collectorId = req.actor.userId
    const sinceDate = since ? new Date(since) : new Date(0)
    const cursor = new Date().toISOString()

    // Clients assigned to this collector updated since cursor
    const clients = await prisma.client.findMany({
      where: { collectorId, updatedAt: { gte: sinceDate } },
      select: {
        id: true, carnetNumber: true, firstName: true, lastName: true, phone: true, phoneAlt: true,
        addressText: true, landmark: true, latitude: true, longitude: true, gpsAccuracyM: true,
        zoneId: true, collectorId: true, status: true, activity: true, notes: true, smsOptOut: true,
        registeredAt: true, updatedAt: true,
      },
    })

    // Cycles for those clients (open + last closed)
    const clientIds = clients.map((c) => c.id)
    const allClientIds = (await prisma.client.findMany({ where: { collectorId }, select: { id: true } })).map((c) => c.id)

    const cycles = await prisma.cycle.findMany({
      where: {
        clientId: { in: allClientIds },
        OR: [{ status: 'OPEN' }, { updatedAt: { gte: sinceDate } }],
      },
      select: {
        id: true, clientId: true, cycleSequence: true, startDate: true, endDate: true,
        stakeAmount: true, maxBoxes: true, status: true, totalPaid: true, boxesFilled: true,
        commissionAmount: true, netToPay: true, closedAt: true, updatedAt: true,
      },
    })

    // Void request decisions
    const void_requests = await prisma.voidRequest.findMany({
      where: {
        collection: { collectorId },
        updatedAt: { gte: sinceDate },
      },
      select: { id: true, collectionId: true, status: true, decidedBy: true, decidedAt: true, decisionNote: true },
    })

    // Sticker stock for this collector
    const stickerStock = await prisma.carnetSticker.findMany({
      where: { assignedCollectorId: collectorId, status: { in: ['ASSIGNED', 'USED'] } },
      select: { carnetNumber: true, status: true },
    })

    // Settings (always included)
    const settings = await prisma.setting.findMany()
    const settingsMap = Object.fromEntries(settings.map((s) => [s.key, s.value]))

    return reply.send({
      cursor,
      clients,
      cycles,
      void_requests,
      sticker_stock: stickerStock,
      settings: settingsMap,
    })
  })
}

// Haversine distance in metres
function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
