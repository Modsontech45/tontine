import { formatInTimeZone, toZonedTime } from 'date-fns-tz'

const TZ = 'Africa/Lome'

export function businessDate(ts: Date): Date {
  const zoned = toZonedTime(ts, TZ)
  zoned.setHours(0, 0, 0, 0)
  return zoned
}

export function currentBusinessDate(): Date {
  return businessDate(new Date())
}

export function formatDateFr(d: Date): string {
  return formatInTimeZone(d, TZ, 'dd/MM/yyyy')
}

export function formatAmountFr(amountFcfa: number): string {
  return new Intl.NumberFormat('fr-TG').format(amountFcfa) + ' F'
}
