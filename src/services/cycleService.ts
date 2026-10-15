import { Prisma, PrismaClient } from '@prisma/client'
import { AppError } from '../lib/errors'

export type CommissionStrategy = 'ONE_STAKE' | 'PERCENT' | 'FIXED'

export interface BoxState {
  boxesFilled: number
  remainder: number
}

export function computeBoxes(totalPaid: number, stakeAmount: number, maxBoxes: number): BoxState {
  const boxesFilled = Math.min(maxBoxes, Math.floor(totalPaid / stakeAmount))
  const remainder = totalPaid - boxesFilled * stakeAmount
  return { boxesFilled, remainder }
}

export function computeCommission(
  strategy: CommissionStrategy,
  value: number,
  totalPaid: number,
  stakeAmount: number,
  boxesFilled: number,
): number {
  if (boxesFilled === 0) return 0
  switch (strategy) {
    case 'ONE_STAKE':
      return stakeAmount
    case 'PERCENT':
      return Math.floor(totalPaid * (value / 100))
    case 'FIXED':
      return value
  }
}

export function maxAllowedAmount(cycle: { totalPaid: number; stakeAmount: number; maxBoxes: number }): number {
  return cycle.maxBoxes * cycle.stakeAmount - cycle.totalPaid
}

export function validateCollectionAmount(
  amount: number,
  cycle: { totalPaid: number; stakeAmount: number; maxBoxes: number },
): void {
  if (amount <= 0) throw new AppError('VALIDATION_ERROR', 'Le montant doit être positif', 400)
  const remaining = maxAllowedAmount(cycle)
  if (amount > remaining) {
    throw new AppError(
      'CYCLE_FULL',
      `Montant trop élevé. Maximum autorisé: ${remaining} F (cycle complet à ${cycle.maxBoxes} mises)`,
      422,
      { max_allowed: remaining, current_total: cycle.totalPaid },
    )
  }
}

type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

export async function applyCollectionToCycle(
  cycleId: string,
  amount: number,
  tx: TxClient,
): Promise<{ boxesFilled: number; totalPaid: number; remainder: number }> {
  // Lock the cycle row for the duration of the transaction
  const cycles = await tx.$queryRaw<Array<{
    id: string; total_paid: number; stake_amount: number; max_boxes: number; status: string
  }>>`SELECT id, total_paid, stake_amount, max_boxes, status FROM cycles WHERE id = ${cycleId}::uuid FOR UPDATE`

  const cycle = cycles[0]
  if (!cycle) throw new AppError('NOT_FOUND', `Cycle not found: ${cycleId}`, 404)
  if (cycle.status !== 'OPEN') throw new AppError('CYCLE_NOT_OPEN', 'Ce cycle n\'est plus ouvert', 422)

  const newTotal = cycle.total_paid + amount
  const max = cycle.max_boxes * cycle.stake_amount
  if (newTotal > max) {
    throw new AppError('CYCLE_FULL', `Montant trop élevé. Maximum: ${max - cycle.total_paid} F`, 422, {
      max_allowed: max - cycle.total_paid,
    })
  }

  const { boxesFilled, remainder } = computeBoxes(newTotal, cycle.stake_amount, cycle.max_boxes)

  await tx.cycle.update({
    where: { id: cycleId },
    data: { totalPaid: newTotal, boxesFilled },
  })

  return { boxesFilled, totalPaid: newTotal, remainder }
}

export async function revertCollectionFromCycle(
  cycleId: string,
  amount: number,
  tx: TxClient,
): Promise<void> {
  const cycles = await tx.$queryRaw<Array<{
    id: string; total_paid: number; stake_amount: number; max_boxes: number
  }>>`SELECT id, total_paid, stake_amount, max_boxes FROM cycles WHERE id = ${cycleId}::uuid FOR UPDATE`

  const cycle = cycles[0]
  if (!cycle) throw new AppError('NOT_FOUND', `Cycle not found: ${cycleId}`, 404)

  const newTotal = Math.max(0, cycle.total_paid - amount)
  const { boxesFilled } = computeBoxes(newTotal, cycle.stake_amount, cycle.max_boxes)

  await tx.cycle.update({
    where: { id: cycleId },
    data: { totalPaid: newTotal, boxesFilled },
  })
}

export async function getSettings(tx: TxClient): Promise<{
  commissionStrategy: CommissionStrategy
  commissionValue: number
  stakeMin: number
  stakeMax: number
  stakeStep: number
  cycleDefaultLength: number
  gpsAlertDistanceM: number
  inactiveDays: number
}> {
  const rows = await tx.setting.findMany({
    where: { key: { in: ['commission_strategy', 'commission_value', 'stake_min', 'stake_max', 'stake_step', 'cycle_default_length', 'gps_alert_distance_m', 'inactive_days'] } },
  })
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  return {
    commissionStrategy: (map['commission_strategy'] as CommissionStrategy) ?? 'ONE_STAKE',
    commissionValue: (map['commission_value'] as number) ?? 1,
    stakeMin: (map['stake_min'] as number) ?? 100,
    stakeMax: (map['stake_max'] as number) ?? 10000,
    stakeStep: (map['stake_step'] as number) ?? 25,
    cycleDefaultLength: (map['cycle_default_length'] as number) ?? 31,
    gpsAlertDistanceM: (map['gps_alert_distance_m'] as number) ?? 300,
    inactiveDays: (map['inactive_days'] as number) ?? 5,
  }
}

export function validateStakeAmount(stake: number, stakeMin: number, stakeMax: number, stakeStep: number): void {
  if (stake < stakeMin || stake > stakeMax) {
    throw new AppError('VALIDATION_ERROR', `La mise doit être entre ${stakeMin} F et ${stakeMax} F`, 400)
  }
  if (stake % stakeStep !== 0) {
    throw new AppError('VALIDATION_ERROR', `La mise doit être un multiple de ${stakeStep} F`, 400)
  }
}
