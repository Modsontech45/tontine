import { createHmac } from 'crypto'
import { env } from './env'

export function computeQrChecksum(carnetNumber: string): string {
  return createHmac('sha256', env.QR_SECRET)
    .update(carnetNumber)
    .digest('hex')
    .slice(0, 4)
}

export function buildQrPayload(carnetNumber: string): string {
  return `${carnetNumber}|${computeQrChecksum(carnetNumber)}`
}

export function verifyQrPayload(payload: string): { valid: boolean; carnetNumber: string } {
  const [carnetNumber, checksum] = payload.split('|')
  if (!carnetNumber || !checksum) return { valid: false, carnetNumber: '' }
  const expected = computeQrChecksum(carnetNumber)
  return { valid: expected === checksum, carnetNumber }
}
