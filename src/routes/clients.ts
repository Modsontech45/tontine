import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import QRCode from 'qrcode'
import { prisma } from '../lib/prisma'
import { requireAuth, requireRoles } from '../middleware/auth'
import { notFound, forbidden, AppError } from '../lib/errors'
import { writeAudit } from '../lib/audit'
import { buildQrPayload, verifyQrPayload } from '../lib/qr'

const phoneRegex = /^\+228\d{8}$/

const clientQuerySchema = z.object({
  collector_id: z.string().uuid().optional(),
  zone_id: z.string().uuid().optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']).optional(),
  q: z.string().optional(),
  inactive: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
})

const patchClientSchema = z.object({
  phone_alt: z.string().regex(phoneRegex, 'Format E.164 Togo requis (+228XXXXXXXX)').optional().nullable(),
  landmark: z.string().optional().nullable(),
  address_text: z.string().min(1).optional(),
  notes: z.string().optional().nullable(),
  sms_opt_out: z.boolean().optional(),
  photo_url: z.string().url().optional().nullable(),
  place_photo_url: z.string().url().optional().nullable(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  gps_accuracy_m: z.number().optional(),
  zone_id: z.string().uuid().optional().nullable(),
})

const reassignSchema = z.object({
  to_collector_id: z.string().uuid(),
  reason: z.string().min(1),
})

const suspendCloseSchema = z.object({
  reason: z.string().min(1).optional(),
})

const verifyQrSchema = z.object({
  payload: z.string().min(1),
})

const createClientSchema = z.object({
  id: z.string().uuid(),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  phone: z.string().regex(phoneRegex),
  phone_alt: z.string().regex(phoneRegex).nullable().optional(),
  address_text: z.string().default(''),
  landmark: z.string().nullable().optional(),
  latitude: z.number(),
  longitude: z.number(),
  gps_accuracy_m: z.number(),
  zone_id: z.string().uuid().nullable().optional(),
  activity: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  sms_opt_out: z.boolean().default(false),
  carnet_number: z.string().optional(),
  registered_at: z.string().datetime({ offset: true }),
  cycle_id: z.string().uuid(),
  stake_amount: z.number().int().positive(),
  cycle_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cycle_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  max_boxes: z.number().int().default(31),
})

export async function clientRoutes(app: FastifyInstance): Promise<void> {
  app.get('/clients', { preHandler: requireAuth }, async (req, reply) => {
    const q = clientQuerySchema.parse(req.query)

    // Collectors can only see their assigned clients
    const effectiveCollectorId = req.actor.role === 'COLLECTOR' ? req.actor.userId : q.collector_id

    const inactiveDaysSetting = await prisma.setting.findUnique({ where: { key: 'inactive_days' } })
    const inactiveDays = (inactiveDaysSetting?.value as number) ?? 5

    const where: Record<string, unknown> = {
      ...(effectiveCollectorId ? { collectorId: effectiveCollectorId } : {}),
      ...(q.zone_id ? { zoneId: q.zone_id } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.q ? {
        OR: [
          { firstName: { contains: q.q, mode: 'insensitive' } },
          { lastName: { contains: q.q, mode: 'insensitive' } },
          { carnetNumber: { contains: q.q } },
          { phone: { contains: q.q } },
        ],
      } : {}),
    }

    // inactive filter: clients with open cycle but no collection in last N days
    if (q.inactive === 'true') {
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - inactiveDays)
      where['cycles'] = {
        some: {
          status: 'OPEN',
          collections: { every: { collectedAt: { lt: cutoff }, voidedAt: null } },
        },
      }
    }

    const [clients, total] = await Promise.all([
      prisma.client.findMany({
        where,
        skip: (q.page - 1) * q.page_size,
        take: q.page_size,
        orderBy: { createdAt: 'desc' },
        include: {
          collector: { select: { id: true, firstName: true, lastName: true } },
          zone: { select: { id: true, name: true } },
          cycles: { where: { status: 'OPEN' }, select: { id: true, stakeAmount: true, totalPaid: true, boxesFilled: true, endDate: true }, take: 1 },
        },
      }),
      prisma.client.count({ where }),
    ])

    return reply.send({ data: clients, total, page: q.page, page_size: q.page_size })
  })

  // ── Direct client creation (online-only from mobile) ─────────────────────
  const WEB_BATCH_ID = 'b0000099-0000-0000-0000-000000000099'

  app.post('/clients', { preHandler: requireAuth }, async (req, reply) => {
    const body = createClientSchema.safeParse(req.body)
    if (!body.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })
    const c = body.data
    const collectorId = req.actor.userId

    // Idempotency: already created → return existing
    const existing = await prisma.client.findUnique({
      where: { id: c.id },
      include: { cycles: { where: { id: c.cycle_id } } },
    })
    if (existing) {
      return reply.send({ client: existing, cycle: existing.cycles[0] ?? null })
    }

    let assignedCarnet!: string
    let createdClient: any
    let createdCycle: any

    await prisma.$transaction(async (tx) => {
      if (!c.carnet_number) {
        const last = await tx.carnetSticker.findFirst({ orderBy: { carnetNumber: 'desc' } })
        const n = last ? parseInt(last.carnetNumber.replace('TP-', ''), 10) + 1 : 1
        assignedCarnet = `TP-${n.toString().padStart(6, '0')}`
        await tx.carnetSticker.create({
          data: { carnetNumber: assignedCarnet, batchId: WEB_BATCH_ID, assignedCollectorId: collectorId, status: 'USED', usedByClientId: c.id },
        })
      } else {
        assignedCarnet = c.carnet_number
        const sticker = await tx.carnetSticker.findUnique({ where: { carnetNumber: assignedCarnet } })
        if (!sticker) throw new AppError('STICKER_NOT_FOUND', `Carnet ${assignedCarnet} inconnu`, 422)
        if (sticker.status === 'USED') throw new AppError('STICKER_ALREADY_USED', `Carnet ${assignedCarnet} déjà utilisé`, 422)
        await tx.carnetSticker.update({ where: { carnetNumber: assignedCarnet }, data: { status: 'USED', usedByClientId: c.id } })
      }

      createdClient = await tx.client.create({
        data: {
          id: c.id, carnetNumber: assignedCarnet,
          firstName: c.first_name, lastName: c.last_name,
          phone: c.phone, phoneAlt: c.phone_alt ?? null,
          addressText: c.address_text, landmark: c.landmark ?? null,
          latitude: c.latitude, longitude: c.longitude, gpsAccuracyM: c.gps_accuracy_m,
          zoneId: c.zone_id ?? null,
          collectorId, registeredById: req.actor.userId,
          registeredAt: new Date(c.registered_at),
          status: 'ACTIVE', smsOptOut: c.sms_opt_out,
          activity: c.activity ?? null, notes: c.notes ?? null,
        },
      })

      createdCycle = await tx.cycle.create({
        data: {
          id: c.cycle_id, clientId: c.id, cycleSequence: 1,
          startDate: new Date(c.cycle_start), endDate: new Date(c.cycle_end),
          stakeAmount: c.stake_amount, maxBoxes: c.max_boxes,
          status: 'OPEN', totalPaid: 0, boxesFilled: 0,
        },
      })
    })

    await writeAudit({
      actorId: req.actor.userId, actorRole: req.actor.role,
      action: 'CREATE_CLIENT_DIRECT', entity: 'clients', entityId: c.id,
      before: null, after: createdClient, ip: req.ip, deviceId: req.actor.deviceId,
    })

    return reply.code(201).send({ client: createdClient, cycle: createdCycle })
  })

  app.get('/clients/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const client = await prisma.client.findUnique({
      where: { id },
      include: {
        collector: { select: { id: true, firstName: true, lastName: true, phone: true } },
        zone: true,
        cycles: {
          orderBy: { cycleSequence: 'desc' },
          include: {
            collections: {
              where: { voidedAt: null },
              orderBy: { collectedAt: 'desc' },
              take: 50,
            },
            payout: true,
          },
        },
        carnetSticker: true,
      },
    })

    if (!client) return reply.code(404).send({ error: notFound('Client', id) })

    // Collectors can only see their own clients
    if (req.actor.role === 'COLLECTOR' && client.collectorId !== req.actor.userId) {
      return reply.code(403).send({ error: forbidden('Access denied') })
    }

    return reply.send(client)
  })

  app.patch('/clients/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = patchClientSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const client = await prisma.client.findUnique({ where: { id } })
    if (!client) return reply.code(404).send({ error: notFound('Client', id) })

    if (req.actor.role === 'COLLECTOR' && client.collectorId !== req.actor.userId) {
      return reply.code(403).send({ error: forbidden() })
    }

    // If collector is updating GPS, require a reason (not enforced here — handled client-side; server just stores it)
    const updated = await prisma.client.update({
      where: { id },
      data: {
        phoneAlt: body.data.phone_alt,
        landmark: body.data.landmark,
        addressText: body.data.address_text,
        notes: body.data.notes,
        smsOptOut: body.data.sms_opt_out,
        photoUrl: body.data.photo_url,
        placePhotoUrl: body.data.place_photo_url,
        latitude: body.data.latitude,
        longitude: body.data.longitude,
        gpsAccuracyM: body.data.gps_accuracy_m,
        zoneId: body.data.zone_id,
      },
    })

    await writeAudit({
      actorId: req.actor.userId, actorRole: req.actor.role,
      action: 'UPDATE_CLIENT', entity: 'clients', entityId: id,
      before: client, after: updated, ip: req.ip, deviceId: req.actor.deviceId,
    })

    return reply.send(updated)
  })

  app.post('/clients/:id/reassign', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = reassignSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const [client, newCollector] = await Promise.all([
      prisma.client.findUnique({ where: { id } }),
      prisma.user.findUnique({ where: { id: body.data.to_collector_id, role: 'COLLECTOR', isActive: true } }),
    ])

    if (!client) return reply.code(404).send({ error: notFound('Client', id) })
    if (!newCollector) return reply.code(404).send({ error: notFound('Collector', body.data.to_collector_id) })

    await prisma.$transaction([
      prisma.client.update({ where: { id }, data: { collectorId: body.data.to_collector_id } }),
      prisma.clientAssignment.create({
        data: {
          id: crypto.randomUUID(),
          clientId: id,
          fromCollectorId: client.collectorId,
          toCollectorId: body.data.to_collector_id,
          changedById: req.actor.userId,
          reason: body.data.reason,
          changedAt: new Date(),
        },
      }),
    ])

    await writeAudit({
      actorId: req.actor.userId, actorRole: req.actor.role,
      action: 'REASSIGN_CLIENT', entity: 'clients', entityId: id,
      before: { collectorId: client.collectorId },
      after: { collectorId: body.data.to_collector_id, reason: body.data.reason },
      ip: req.ip,
    })

    return reply.code(204).send()
  })

  app.post('/clients/:id/suspend', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = suspendCloseSchema.safeParse(req.body)
    const client = await prisma.client.findUnique({ where: { id } })
    if (!client) return reply.code(404).send({ error: notFound('Client', id) })

    await prisma.client.update({ where: { id }, data: { status: 'SUSPENDED' } })
    await writeAudit({ actorId: req.actor.userId, actorRole: req.actor.role, action: 'SUSPEND_CLIENT', entity: 'clients', entityId: id, ip: req.ip })
    return reply.code(204).send()
  })

  app.post('/clients/:id/close', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const client = await prisma.client.findUnique({ where: { id } })
    if (!client) return reply.code(404).send({ error: notFound('Client', id) })

    await prisma.client.update({ where: { id }, data: { status: 'CLOSED' } })
    await writeAudit({ actorId: req.actor.userId, actorRole: req.actor.role, action: 'CLOSE_CLIENT', entity: 'clients', entityId: id, ip: req.ip })
    return reply.code(204).send()
  })

  // QR image endpoint — returns a base64 PNG for office printing
  app.get('/clients/:id/qr', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const client = await prisma.client.findUnique({
      where: { id },
      select: { id: true, carnetNumber: true, firstName: true, lastName: true, collectorId: true },
    })
    if (!client) return reply.code(404).send({ error: notFound('Client', id) })
    if (req.actor.role === 'COLLECTOR' && client.collectorId !== req.actor.userId) {
      return reply.code(403).send({ error: forbidden() })
    }
    const qrPayload = buildQrPayload(client.carnetNumber)
    const qrImage = await QRCode.toDataURL(qrPayload, { errorCorrectionLevel: 'M', width: 300, margin: 2 })
    return reply.send({
      carnet_number: client.carnetNumber,
      qr_payload: qrPayload,
      qr_image: qrImage,
      name: `${client.firstName} ${client.lastName}`,
    })
  })

  // QR verification endpoint (used by app to find a client by scanning their carnet)
  app.post('/clients/verify-qr', { preHandler: requireAuth }, async (req, reply) => {
    const body = verifyQrSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const { valid, carnetNumber } = verifyQrPayload(body.data.payload)
    if (!valid) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'QR code invalide ou falsifié' } })

    const sticker = await prisma.carnetSticker.findUnique({ where: { carnetNumber } })
    if (!sticker) return reply.code(404).send({ error: notFound('Sticker', carnetNumber) })

    // Collectors can only use stickers assigned to them
    if (req.actor.role === 'COLLECTOR' && sticker.assignedCollectorId !== req.actor.userId) {
      return reply.code(403).send({ error: { code: 'STICKER_NOT_ASSIGNED', message: 'Ce carnet ne vous est pas assigné' } })
    }

    if (sticker.status === 'USED') {
      return reply.code(422).send({ error: { code: 'STICKER_ALREADY_USED', message: 'Ce carnet est déjà utilisé' } })
    }

    if (sticker.status === 'LOST' || sticker.status === 'VOID') {
      return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: `Ce carnet est marqué ${sticker.status}` } })
    }

    return reply.send({ valid: true, carnet_number: carnetNumber, status: sticker.status })
  })

  // GeoJSON endpoint for map
  app.get('/map/clients', { preHandler: requireAuth }, async (req, reply) => {
    const { collector_id, zone_id, status } = req.query as Record<string, string>
    const effectiveCollectorId = req.actor.role === 'COLLECTOR' ? req.actor.userId : collector_id

    const clients = await prisma.client.findMany({
      where: {
        ...(effectiveCollectorId ? { collectorId: effectiveCollectorId } : {}),
        ...(zone_id ? { zoneId: zone_id } : {}),
        ...(status ? { status: status as never } : {}),
      },
      select: { id: true, firstName: true, lastName: true, carnetNumber: true, latitude: true, longitude: true, status: true, collectorId: true },
    })

    const geojson = {
      type: 'FeatureCollection',
      features: clients.map((c) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [c.longitude, c.latitude] },
        properties: {
          id: c.id, name: `${c.firstName} ${c.lastName}`,
          carnet_number: c.carnetNumber, status: c.status, collector_id: c.collectorId,
        },
      })),
    }
    return reply.send(geojson)
  })
}
