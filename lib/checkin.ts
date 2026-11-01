import 'server-only'
import type { actionDb } from '@/lib/db'

type Db = Awaited<ReturnType<typeof actionDb>>['supabase']

/** Kit already reported on a job (Quick report or Issues) that has not yet been booked back as damaged or missing. */
export type Pending = Map<string, { damaged: number; missing: number }>

export async function pendingReports(
  supabase: Db,
  jobId: string,
  lines: { id: string; type_id: string | null }[],
  booked: Map<string, { damaged_qty: number; missing_qty: number }>,
): Promise<Pending> {
  const { data } = await supabase.from('stock_issues').select('type_id, issue, qty').eq('job_id', jobId)
  const reported = new Map<string, { damaged: number; missing: number }>()
  for (const i of (data ?? []) as { type_id: string; issue: string; qty: number }[]) {
    const r = reported.get(i.type_id) ?? { damaged: 0, missing: 0 }
    if (i.issue === 'damaged') r.damaged += i.qty
    if (i.issue === 'missing') r.missing += i.qty
    reported.set(i.type_id, r)
  }
  const pending: Pending = new Map()
  for (const [typeId, r] of reported) {
    let bd = 0
    let bm = 0
    for (const l of lines) {
      if (l.type_id !== typeId) continue
      bd += booked.get(l.id)?.damaged_qty ?? 0
      bm += booked.get(l.id)?.missing_qty ?? 0
    }
    const damaged = Math.max(0, r.damaged - bd)
    const missing = Math.max(0, r.missing - bm)
    if (damaged || missing) pending.set(typeId, { damaged, missing })
  }
  return pending
}

/** Hand out what is pending for an item to one line, never more than is still out on it. */
export function takeFor(pending: Pending, typeId: string | null, remaining: number) {
  const p = typeId ? pending.get(typeId) : undefined
  if (!p) return { dam: 0, mis: 0 }
  const dam = Math.min(p.damaged, remaining)
  const mis = Math.min(p.missing, remaining - dam)
  p.damaged -= dam
  p.missing -= mis
  return { dam, mis }
}
