'use server'

import { revalidatePath } from 'next/cache'
import { actionDb, friendly, isUuid } from '@/lib/db'
import type { FormState } from '@/components/action-form'

type Db = Awaited<ReturnType<typeof actionDb>>['supabase']

const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()
const oops = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : 'Something went wrong.' })
const qtyOf = (s: string) => Math.trunc(Number(s))

function refresh(jobId: string) {
  revalidatePath(`/prep/${jobId}`)
  revalidatePath(`/checkin/${jobId}`)
  revalidatePath(`/jobs/${jobId}`)
  revalidatePath('/jobs')
  revalidatePath('/warehouse')
  revalidatePath('/checkin')
  revalidatePath('/receive')
  revalidatePath('/activity')
}

/** Prep: the quantity box adds that many to the line's prepped total, stamped with who did it. */
export async function prepLine(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const lineId = text(fd, 'line_id')
    const jobId = text(fd, 'job_id')
    const qty = qtyOf(text(fd, 'qty'))
    if (!isUuid(lineId) || !isUuid(jobId)) return { error: 'Missing line.' }
    if (!Number.isFinite(qty) || qty < 1) return { error: 'Enter how many you have prepped (1 or more).' }
    const { error } = await supabase.from('line_events').insert({ line_id: lineId, action: 'prepped', qty })
    if (error) return { error: friendly(error.message) }
    refresh(jobId)
    return { ok: true }
  } catch (e) {
    return oops(e)
  }
}

export async function unprepLine(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const lineId = text(fd, 'line_id')
    const jobId = text(fd, 'job_id')
    const qty = qtyOf(text(fd, 'qty'))
    if (!isUuid(lineId) || !isUuid(jobId)) return { error: 'Missing line.' }
    if (!Number.isFinite(qty) || qty < 1) return { error: 'Enter how many to take off (1 or more).' }
    const { error } = await supabase.from('line_events').insert({ line_id: lineId, action: 'unprepped', qty })
    if (error) return { error: friendly(error.message) }
    refresh(jobId)
    return { ok: true }
  } catch (e) {
    return oops(e)
  }
}

export async function markJob(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const jobId = text(fd, 'job_id')
    const status = text(fd, 'status')
    if (!isUuid(jobId) || !['prepping', 'prepped', 'out', 'returned'].includes(status)) return { error: 'Missing job or status.' }
    const { error } = await supabase.rpc('set_job_status', { p_job: jobId, p_status: status })
    if (error) return { error: friendly(error.message) }
    refresh(jobId)
    return { ok: true, message: status === 'out' ? 'Marked out.' : 'Done.' }
  } catch (e) {
    return oops(e)
  }
}

type Progress = { line_id: string; prepped_qty: number; returned_qty: number; missing_qty: number; damaged_qty: number }

/** Lines that went out (prepped) and still have something to come back, with how much. */
async function outstanding(supabase: Db, jobId: string) {
  const [{ data: lines }, { data: progress }] = await Promise.all([
    supabase.from('job_lines').select('id, type:equipment_types(kind)').eq('job_id', jobId).is('archived_at', null),
    supabase.from('line_progress').select('line_id, prepped_qty, returned_qty, missing_qty, damaged_qty').eq('job_id', jobId),
  ])
  const prog = new Map(((progress ?? []) as Progress[]).map((p) => [p.line_id, p]))
  const out: { id: string; remaining: number }[] = []
  for (const l of (lines ?? []) as unknown as { id: string; type: { kind: string } | null }[]) {
    if (l.type?.kind === 'kit') continue
    const p = prog.get(l.id)
    if (!p) continue
    const remaining = p.prepped_qty - p.returned_qty - p.missing_qty - p.damaged_qty
    if (remaining > 0) out.push({ id: l.id, remaining })
  }
  return out
}

/** Check-in. mode "all" books everything still out as returned OK. Otherwise reads ret_, mis_ and dam_ boxes per line. */
export async function checkInJob(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const jobId = text(fd, 'job_id')
    if (!isUuid(jobId)) return { error: 'Missing job.' }
    const note = text(fd, 'note') || null
    const open = await outstanding(supabase, jobId)
    if (!open.length) return { error: 'Everything that went out is already booked back.' }

    const work: { id: string; ret: number; mis: number; dam: number }[] = []
    if (text(fd, 'mode') === 'all') {
      for (const l of open) work.push({ id: l.id, ret: l.remaining, mis: 0, dam: 0 })
    } else {
      for (const l of open) {
        const ret = qtyOf(text(fd, `ret_${l.id}`) || '0')
        const mis = qtyOf(text(fd, `mis_${l.id}`) || '0')
        const dam = qtyOf(text(fd, `dam_${l.id}`) || '0')
        if (![ret, mis, dam].every((n) => Number.isFinite(n) && n >= 0)) return { error: 'Quantities must be whole numbers, 0 or more.' }
        if (ret + mis + dam > l.remaining) return { error: `You entered more than is still out on one line (${l.remaining} still out). Nothing was booked.` }
        if (ret + mis + dam > 0) work.push({ id: l.id, ret, mis, dam })
      }
      if (!work.length) return { error: 'Enter a quantity against at least one line.' }
    }

    let done = 0
    for (const w of work) {
      const { error } = await supabase.rpc('check_in_line', {
        p_line: w.id,
        p_returned: w.ret,
        p_missing: w.mis,
        p_damaged: w.dam,
        p_note: note,
      })
      if (error) {
        refresh(jobId)
        return { error: `${friendly(error.message)}${done ? ` (${done} lines were booked before this one.)` : ''}` }
      }
      done++
    }
    refresh(jobId)
    return { ok: true, message: `Booked back ${done} ${done === 1 ? 'line' : 'lines'}.` }
  } catch (e) {
    return oops(e)
  }
}

/** After receiving, mark the whole order received once every line on it is in. */
async function settleOrder(supabase: Db, orderId: string) {
  const [{ data: order }, { data: lines }] = await Promise.all([
    supabase.from('sub_hire_orders').select('status').eq('id', orderId).maybeSingle(),
    supabase.from('job_lines').select('id, qty_required').eq('sub_hire_id', orderId).is('archived_at', null),
  ])
  if (!order || !['requested', 'confirmed'].includes(order.status) || !lines?.length) return
  const { data: progress } = await supabase
    .from('line_progress')
    .select('line_id, received_qty')
    .in('line_id', lines.map((l) => l.id))
  const got = new Map((progress ?? []).map((p: { line_id: string; received_qty: number }) => [p.line_id, p.received_qty]))
  if (lines.every((l) => (got.get(l.id) ?? 0) >= l.qty_required)) {
    await supabase.from('sub_hire_orders').update({ status: 'received' }).eq('id', orderId)
  }
}

function refreshOrder(orderId: string, jobId: string) {
  revalidatePath(`/receive/${orderId}`)
  refresh(jobId)
}

export async function receiveLine(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const lineId = text(fd, 'line_id')
    const orderId = text(fd, 'order_id')
    const jobId = text(fd, 'job_id')
    const qty = qtyOf(text(fd, 'qty'))
    if (!isUuid(lineId) || !isUuid(orderId) || !isUuid(jobId)) return { error: 'Missing line.' }
    if (!Number.isFinite(qty) || qty < 1) return { error: 'Enter how many arrived (1 or more).' }
    const { error } = await supabase.from('line_events').insert({ line_id: lineId, action: 'received_sub_hire', qty })
    if (error) return { error: friendly(error.message) }
    await settleOrder(supabase, orderId)
    refreshOrder(orderId, jobId)
    return { ok: true }
  } catch (e) {
    return oops(e)
  }
}

/** Receive everything still outstanding on an order in one go. */
export async function receiveOrder(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const orderId = text(fd, 'order_id')
    const jobId = text(fd, 'job_id')
    if (!isUuid(orderId) || !isUuid(jobId)) return { error: 'Missing order.' }
    const { data: lines } = await supabase.from('job_lines').select('id, qty_required').eq('sub_hire_id', orderId).is('archived_at', null)
    const { data: progress } = await supabase
      .from('line_progress')
      .select('line_id, received_qty')
      .in('line_id', (lines ?? []).map((l) => l.id))
    const got = new Map((progress ?? []).map((p: { line_id: string; received_qty: number }) => [p.line_id, p.received_qty]))
    let n = 0
    for (const l of lines ?? []) {
      const left = l.qty_required - (got.get(l.id) ?? 0)
      if (left < 1) continue
      const { error } = await supabase.from('line_events').insert({ line_id: l.id, action: 'received_sub_hire', qty: left })
      if (error) return { error: friendly(error.message) }
      n++
    }
    if (!n && !(lines ?? []).length) {
      // An order with no lines can still be marked received
      const { error } = await supabase.from('sub_hire_orders').update({ status: 'received' }).eq('id', orderId)
      if (error) return { error: friendly(error.message) }
    }
    await settleOrder(supabase, orderId)
    refreshOrder(orderId, jobId)
    return { ok: true, message: n ? `Received ${n} ${n === 1 ? 'line' : 'lines'}.` : 'Marked received.' }
  } catch (e) {
    return oops(e)
  }
}

export async function returnOrder(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const orderId = text(fd, 'order_id')
    const jobId = text(fd, 'job_id')
    if (!isUuid(orderId) || !isUuid(jobId)) return { error: 'Missing order.' }
    const { data, error } = await supabase
      .from('sub_hire_orders')
      .update({ status: 'returned' })
      .eq('id', orderId)
      .eq('status', 'received')
      .select('id')
    if (error) return { error: friendly(error.message) }
    if (!data?.length) return { error: 'Only a received order can be marked returned to the supplier.' }
    refreshOrder(orderId, jobId)
    return { ok: true, message: 'Marked returned to the supplier.' }
  } catch (e) {
    return oops(e)
  }
}
