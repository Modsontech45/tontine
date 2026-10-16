export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'CYCLE_FULL'
  | 'CYCLE_NOT_OPEN'
  | 'CLIENT_NOT_ASSIGNED'
  | 'STICKER_NOT_FOUND'
  | 'STICKER_ALREADY_USED'
  | 'STICKER_NOT_ASSIGNED'
  | 'DEVICE_REVOKED'
  | 'DEVICE_PENDING'
  | 'ONE_OPEN_CYCLE'
  | 'CONFLICT'
  | 'INTERNAL_ERROR'

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly message: string,
    public readonly statusCode: number = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function notFound(entity: string, id?: string): AppError {
  return new AppError('NOT_FOUND', `${entity} not found${id ? `: ${id}` : ''}`, 404)
}

export function forbidden(msg = 'Access denied'): AppError {
  return new AppError('FORBIDDEN', msg, 403)
}

export function unauthorized(msg = 'Unauthorized'): AppError {
  return new AppError('UNAUTHORIZED', msg, 401)
}
