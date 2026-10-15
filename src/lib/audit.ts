import { prisma } from './prisma'

interface AuditParams {
  actorId?: string
  actorRole?: string
  action: string
  entity: string
  entityId?: string
  before?: unknown
  after?: unknown
  ip?: string
  deviceId?: string
}

export async function writeAudit(params: AuditParams): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId: params.actorId,
      actorRole: params.actorRole,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId,
      before: params.before as never,
      after: params.after as never,
      ip: params.ip,
      deviceId: params.deviceId,
    },
  })
}
