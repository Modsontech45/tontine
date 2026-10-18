import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireRoles, requireAuth } from '../middleware/auth'
import { notFound, AppError } from '../lib/errors'
import { writeAudit } from '../lib/audit'
import { generateStickerPdf } from '../services/stickerService'

const createBatchSchema = z.object({
  from_number: z.number().int().min(1),
  to_number: z.number().int().min(1),
}).refine((d) => d.to_number >= d.from_number, { message: 'to_number must be >= from_number' })
  .refine((d) => d.to_number - d.from_number < 500, { message: 'Batch size must be < 500' })

const assignSchema = z.object({
  collector_id: z.string().uuid(),
  carnet_numbers: z.array(z.string().min(1)).optional(),
  from_number: z.number().int().optional(),
  to_number: z.number().int().optional(),
})

export async function stickerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/sticker-batches', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN') }, async (req, reply) => {
    const body = createBatchSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const { from_number, to_number } = body.data
    const batchId = crypto.randomUUID()

    // Check for number conflicts
    const existing = await prisma.carnetSticker.findFirst({
      where: {
        carnetNumber: { in: Array.from({ length: to_number - from_number + 1 }, (_, i) => `TP-${String(from_number + i).padStart(6, '0')}`) },
      },
    })
    if (existing) {
      return reply.code(409).send({ error: { code: 'CONFLICT', message: `Sticker ${existing.carnetNumber} already exists` } })
    }

    const batch = await prisma.stickerBatch.create({
      data: { id: batchId, fromNumber: from_number, toNumber: to_number, printedAt: new Date(), createdById: req.actor.userId },
    })

    // Create all sticker records
    const stickers = []
    for (let n = from_number; n <= to_number; n++) {
      stickers.push({ carnetNumber: `TP-${String(n).padStart(6, '0')}`, batchId, status: 'AVAILABLE' as const })
    }
    await prisma.carnetSticker.createMany({ data: stickers })

    // Generate PDF
    const labels = stickers.map((s) => ({ carnetNumber: s.carnetNumber }))
    const pdf = await generateStickerPdf(labels)

    await writeAudit({
      actorId: req.actor.userId, actorRole: req.actor.role,
      action: 'CREATE_STICKER_BATCH', entity: 'sticker_batches', entityId: batchId,
      after: { from_number, to_number, count: stickers.length }, ip: req.ip,
    })

    reply.header('Content-Type', 'application/pdf')
    reply.header('Content-Disposition', `attachment; filename="stickers-TP${String(from_number).padStart(6,'0')}-TP${String(to_number).padStart(6,'0')}.pdf"`)
    reply.header('X-Batch-Id', batchId)
    return reply.send(pdf)
  })

  app.post('/stickers/assign', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN') }, async (req, reply) => {
    const body = assignSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const { collector_id, carnet_numbers, from_number, to_number } = body.data

    const collector = await prisma.user.findUnique({ where: { id: collector_id, role: 'COLLECTOR', isActive: true } })
    if (!collector) return reply.code(404).send({ error: notFound('Collector', collector_id) })

    let numbers: string[]
    if (carnet_numbers) {
      numbers = carnet_numbers
    } else if (from_number !== undefined && to_number !== undefined) {
      numbers = Array.from({ length: to_number - from_number + 1 }, (_, i) => `TP-${String(from_number + i).padStart(6, '0')}`)
    } else {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Provide carnet_numbers or from_number + to_number' } })
    }

    const stickers = await prisma.carnetSticker.findMany({ where: { carnetNumber: { in: numbers } } })
    const notAvailable = stickers.filter((s) => s.status !== 'AVAILABLE')
    if (notAvailable.length > 0) {
      return reply.code(422).send({ error: { code: 'CONFLICT', message: `Stickers not available: ${notAvailable.map((s) => s.carnetNumber).join(', ')}` } })
    }

    await prisma.carnetSticker.updateMany({
      where: { carnetNumber: { in: numbers } },
      data: { assignedCollectorId: collector_id, status: 'ASSIGNED' },
    })

    await writeAudit({
      actorId: req.actor.userId, actorRole: req.actor.role,
      action: 'ASSIGN_STICKERS', entity: 'carnet_stickers',
      after: { collector_id, count: numbers.length }, ip: req.ip,
    })

    return reply.send({ assigned: numbers.length, collector_id })
  })

  app.get('/stickers', { preHandler: requireAuth }, async (req, reply) => {
    const { status, collector_id, page = '1', page_size = '50' } = req.query as Record<string, string>
    const pg = parseInt(page)
    const ps = Math.min(parseInt(page_size), 100)

    // Collectors can only see their own sticker stock
    const effectiveCollectorId = req.actor.role === 'COLLECTOR' ? req.actor.userId : collector_id

    const where = {
      ...(status ? { status: status as never } : {}),
      ...(effectiveCollectorId ? { assignedCollectorId: effectiveCollectorId } : {}),
    }

    const [stickers, total] = await Promise.all([
      prisma.carnetSticker.findMany({
        where, skip: (pg - 1) * ps, take: ps, orderBy: { carnetNumber: 'asc' },
        include: { client: { select: { id: true, firstName: true, lastName: true } } },
      }),
      prisma.carnetSticker.count({ where }),
    ])

    return reply.send({ data: stickers, total, page: pg, page_size: ps })
  })

  app.get('/stickers/:carnetNumber', { preHandler: requireAuth }, async (req, reply) => {
    const { carnetNumber } = req.params as { carnetNumber: string }
    const sticker = await prisma.carnetSticker.findUnique({ where: { carnetNumber }, include: { client: { select: { id: true, firstName: true, lastName: true } } } })
    if (!sticker) return reply.code(404).send({ error: notFound('CarnetSticker', carnetNumber) })
    return reply.send(sticker)
  })

  app.patch('/stickers/:carnetNumber/mark-lost', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN') }, async (req, reply) => {
    const { carnetNumber } = req.params as { carnetNumber: string }
    const sticker = await prisma.carnetSticker.findUnique({ where: { carnetNumber } })
    if (!sticker) return reply.code(404).send({ error: notFound('CarnetSticker', carnetNumber) })
    if (sticker.status === 'USED') return reply.code(422).send({ error: { code: 'CONFLICT', message: 'Cannot mark a used sticker as lost' } })

    await prisma.carnetSticker.update({ where: { carnetNumber }, data: { status: 'LOST' } })
    await writeAudit({ actorId: req.actor.userId, actorRole: req.actor.role, action: 'MARK_STICKER_LOST', entity: 'carnet_stickers', ip: req.ip })
    return reply.code(204).send()
  })
}
