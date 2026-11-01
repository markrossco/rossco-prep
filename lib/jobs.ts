export const STATUSES = [
  { value: 'provisional', label: 'Provisional' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'prepping', label: 'Prepping' },
  { value: 'prepped', label: 'Prepped' },
  { value: 'out', label: 'Out' },
  { value: 'returned', label: 'Returned' },
  { value: 'closed', label: 'Closed' },
  { value: 'cancelled', label: 'Cancelled' },
] as const

export const statusLabel = (s: string) => STATUSES.find((x) => x.value === s)?.label ?? s

export const ORDER_STATUSES = [
  { value: 'requested', label: 'Requested' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'received', label: 'Received' },
  { value: 'returned', label: 'Returned to supplier' },
] as const

export const orderStatusLabel = (s: string) => ORDER_STATUSES.find((x) => x.value === s)?.label ?? s

/** 12 Nov 2026 (dates are plain calendar dates, so no time zone shifting) */
export function fmtDate(d: string | null | undefined) {
  if (!d) return '-'
  const day = d.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return d
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))

/** Statuses that count as finished: no shortages, no changes */
export const FINISHED = ['returned', 'closed', 'cancelled']
