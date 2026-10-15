import { FastifyReply, FastifyRequest } from 'fastify'
import { Role } from '@prisma/client'
import { forbidden, unauthorized } from '../lib/errors'
import { prisma } from '../lib/prisma'

declare module 'fastify' {
  interface FastifyRequest {
    actor: {
      userId: string
      role: Role
      deviceId?: string
    }
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify()
    const payload = request.user as { userId: string; role: Role; deviceId?: string }
    request.actor = payload
  } catch {
    reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Token invalide ou expiré' } })
    return
  }

  if (request.actor.deviceId) {
    const device = await prisma.device.findUnique({ where: { id: request.actor.deviceId } })
    if (!device || device.status === 'REVOKED') {
      reply.code(401).send({ error: { code: 'DEVICE_REVOKED', message: 'Appareil révoqué' } })
      return
    }
    if (device.status === 'PENDING') {
      reply.code(403).send({ error: { code: 'DEVICE_PENDING', message: 'Appareil en attente d\'approbation' } })
      return
    }
  }
}

export function requireRoles(...roles: Role[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireAuth(request, reply)
    if (reply.sent) return
    if (!roles.includes(request.actor.role)) {
      reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Accès refusé' } })
    }
  }
}
