import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireRoles } from '../middleware/auth'
import { requestOtp, verifyOtp } from '../lib/otp'

const VALID_PURPOSES = ['CONFIRM_HANDOVER', 'DEACTIVATE_USER', 'VOID_COLLECTION', 'RESET_PASSWORD'] as const

export async function otpRoutes(app: FastifyInstance) {
  app.post('/otp/request', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CASHIER') }, async (req, reply) => {
    const body = z.object({ purpose: z.enum(VALID_PURPOSES) }).safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const result = await requestOtp(req.actor.userId, body.data.purpose)
    if (result === 'no_email') {
      return reply.code(422).send({ error: { code: 'NO_EMAIL', message: 'Aucun email configuré pour ce compte. Contactez un administrateur.' } })
    }
    return reply.send({ sent: true })
  })

  app.post('/otp/verify', { preHandler: requireRoles('SUPER_ADMIN', 'ADMIN', 'CASHIER') }, async (req, reply) => {
    const body = z.object({ purpose: z.enum(VALID_PURPOSES), code: z.string().length(6) }).safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })

    const valid = await verifyOtp(req.actor.userId, body.data.purpose, body.data.code)
    if (!valid) return reply.code(422).send({ error: { code: 'INVALID_OTP', message: 'Code invalide ou expiré.' } })
    return reply.send({ valid: true })
  })
}
