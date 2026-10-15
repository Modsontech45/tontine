import { describe, it, expect } from 'vitest'
import {
  computeBoxes,
  computeCommission,
  validateCollectionAmount,
  maxAllowedAmount,
  validateStakeAmount,
} from '../services/cycleService'
import { AppError } from '../lib/errors'

describe('computeBoxes', () => {
  it('fills boxes from total paid', () => {
    expect(computeBoxes(3000, 1000, 31)).toEqual({ boxesFilled: 3, remainder: 0 })
  })

  it('handles partial payment (appoint)', () => {
    expect(computeBoxes(2500, 1000, 31)).toEqual({ boxesFilled: 2, remainder: 500 })
  })

  it('carries remainder across multiple collections', () => {
    // 500 F paid, stake = 1000 → 0 boxes, 500 F remainder
    expect(computeBoxes(500, 1000, 31)).toEqual({ boxesFilled: 0, remainder: 500 })
    // 500 more → 1000 total → 1 box
    expect(computeBoxes(1000, 1000, 31)).toEqual({ boxesFilled: 1, remainder: 0 })
  })

  it('caps at max_boxes', () => {
    expect(computeBoxes(35000, 1000, 31)).toEqual({ boxesFilled: 31, remainder: 4000 })
  })

  it('zero paid → zero boxes', () => {
    expect(computeBoxes(0, 1000, 31)).toEqual({ boxesFilled: 0, remainder: 0 })
  })

  it('exact full cycle', () => {
    expect(computeBoxes(31000, 1000, 31)).toEqual({ boxesFilled: 31, remainder: 0 })
  })
})

describe('computeCommission', () => {
  it('ONE_STAKE: equals stake amount when boxes > 0', () => {
    expect(computeCommission('ONE_STAKE', 1, 15000, 1000, 15)).toBe(1000)
  })

  it('ONE_STAKE: zero when no boxes filled', () => {
    expect(computeCommission('ONE_STAKE', 1, 0, 1000, 0)).toBe(0)
  })

  it('PERCENT: computes percentage of total', () => {
    expect(computeCommission('PERCENT', 5, 10000, 500, 10)).toBe(500)
  })

  it('PERCENT: floors the result (no fractions)', () => {
    // 7% of 1000 = 70
    expect(computeCommission('PERCENT', 7, 1000, 500, 2)).toBe(70)
  })

  it('FIXED: returns fixed amount when boxes > 0', () => {
    expect(computeCommission('FIXED', 2000, 31000, 1000, 31)).toBe(2000)
  })

  it('FIXED: zero when no boxes', () => {
    expect(computeCommission('FIXED', 2000, 0, 1000, 0)).toBe(0)
  })
})

describe('validateCollectionAmount', () => {
  const cycle = { totalPaid: 5000, stakeAmount: 1000, maxBoxes: 31 }

  it('accepts valid amount', () => {
    expect(() => validateCollectionAmount(2000, cycle)).not.toThrow()
  })

  it('rejects zero amount', () => {
    expect(() => validateCollectionAmount(0, cycle)).toThrow(AppError)
  })

  it('rejects negative amount', () => {
    expect(() => validateCollectionAmount(-500, cycle)).toThrow(AppError)
  })

  it('rejects amount that would overflow max_boxes', () => {
    // max = 31*1000 = 31000; paid = 5000; remaining = 26000; amount = 27000 → overflow
    expect(() => validateCollectionAmount(27000, cycle)).toThrow(AppError)
    const err = (() => { try { validateCollectionAmount(27000, cycle) } catch (e) { return e as AppError } })()
    expect(err?.code).toBe('CYCLE_FULL')
    expect(err?.details?.max_allowed).toBe(26000)
  })

  it('accepts exact remaining amount', () => {
    expect(() => validateCollectionAmount(26000, cycle)).not.toThrow()
  })

  it('returns correct CYCLE_FULL details', () => {
    const almostFull = { totalPaid: 30500, stakeAmount: 500, maxBoxes: 31 }
    // max = 31*500 = 15500; paid = 30500 → already over? No: 30500 > 15500 means...
    // Let me fix: totalPaid = 14500, max = 15500, remaining = 1000
    const c2 = { totalPaid: 14500, stakeAmount: 500, maxBoxes: 31 }
    expect(() => validateCollectionAmount(1500, c2)).toThrow(AppError)
    const err = (() => { try { validateCollectionAmount(1500, c2) } catch (e) { return e as AppError } })()
    expect(err?.details?.max_allowed).toBe(1000)
  })
})

describe('maxAllowedAmount', () => {
  it('computes remaining capacity', () => {
    expect(maxAllowedAmount({ totalPaid: 5000, stakeAmount: 1000, maxBoxes: 31 })).toBe(26000)
  })

  it('zero when full', () => {
    expect(maxAllowedAmount({ totalPaid: 31000, stakeAmount: 1000, maxBoxes: 31 })).toBe(0)
  })

  it('full capacity when nothing paid', () => {
    expect(maxAllowedAmount({ totalPaid: 0, stakeAmount: 500, maxBoxes: 31 })).toBe(15500)
  })
})

describe('validateStakeAmount', () => {
  it('accepts valid stake', () => {
    expect(() => validateStakeAmount(1000, 100, 10000, 25)).not.toThrow()
  })

  it('rejects below minimum', () => {
    expect(() => validateStakeAmount(50, 100, 10000, 25)).toThrow(AppError)
  })

  it('rejects above maximum', () => {
    expect(() => validateStakeAmount(15000, 100, 10000, 25)).toThrow(AppError)
  })

  it('rejects non-multiple of step', () => {
    expect(() => validateStakeAmount(1010, 100, 10000, 25)).toThrow(AppError)
  })

  it('accepts boundary values', () => {
    expect(() => validateStakeAmount(100, 100, 10000, 25)).not.toThrow()
    expect(() => validateStakeAmount(10000, 100, 10000, 25)).not.toThrow()
  })
})
