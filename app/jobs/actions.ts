'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { actionDb, friendly, isUuid } from '@/lib/db'
import { isDay, STATUSES, ORDER_STATUSES } from '@/lib/jobs'
import type { FormState } from '@/components/action-form'

type Db = Awaited<ReturnType<typeof actionDb>>['supabase']

const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()
const oops = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : 'Something went wrong.' })
const escLike = (s: string) => s.replace(/[%_\\]/g, (m) => `\\${m}`)

/** Find a client, venue or supplier by its exact name (any capitals), or add it when the box was ticked. */
async function pickByName(
  supabase: Db,
  table: 'organisations' | 'venues',
  rawName: string,
  addNew: boolean,
  extra: Record<string, unknown>,
  label: string,
): Promise<{ id?: string; error?: string }> {
  const name = rawName.replace(/\s+/g, ' ').trim()
  if (!name) return {}
  const { data } = await supabase.from(table).select('id').ilike('name', escLike(name)).is('archived_at', null).limit(1)
  if (data?.length) return { id: data[0].id }
  if (!addNew) return { error: `"${name}" is not in the list. Pick the ${label} from the list, or tick the box to add it as new.` }
  const { data: made, error } = await supabase.from(table).insert({ name, ...extra }).select('id').single()
  if (error) return { error: friendly(error.message) }
  return { id: made.id }
}

function readJob(fd: FormData) {
  return {
    ref: text(fd, 'ref'),
    name: text(fd, 'name'),
    out_date: text(fd, 'out_date'),
    return_date: text(fd, 'return_date'),
    notes: text(fd, 'notes') || null,
  }
}

function checkJob(j: ReturnType<typeof readJob>): string | null {
  if (!j.ref) return 'Enter the job reference (the ROS number).'
  if (!j.name) return 'Enter a job name.'
  if (!isDay(j.out_date) || !isDay(j.return_date)) return 'Enter both dates.'
  if (j.return_date < j.out_date) return 'The return date is before the out date.'
  return null
}

export async function createJob(_prev: FormState, fd: FormData): Promise<FormState> {
  let id: string
  try {
    const { supabase } = await actionDb()
    const job = readJob(fd)
    const bad = checkJob(job)
    if (bad) return { error: bad }
    const status = text(fd, 'status') || 'provisional'
    if (!STATUSES.some((s) => s.value === status) || ['returned', 'closed'].includes(status)) {
      return { error: 'Choose provisional or confirmed.' }
    }
    const client = await pickByName(supabase, 'organisations', text(fd, 'client_name'), fd.get('new_client') === 'on', { is_client: true }, 'client')
    if (client.error) return { error: client.error }
    const venue = await pickByName(supabase, 'venues', text(fd, 'venue_name'), fd.get('new_venue') === 'on', {}, 'venue')
    if (venue.error) return { error: venue.error }
    const { data, error } = await supabase
      .from('jobs')
      .insert({ ...job, status, client_id: client.id ?? null, venue_id: venue.id ?? null })
      .select('id')
      .single()
    if (error) return { error: friendly(error.message) }
    id = data.id
  } catch (e) {
    return oops(e)
  }
  revalidatePath('/jobs')
  redirect(`/jobs/${id}`)
}

export async function updateJob(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const id = text(fd, 'id')
    if (!isUuid(id)) return { error: 'Missing job.' }
    const job = readJob(fd)
    const bad = checkJob(job)
    if (bad) return { error: bad }
    const client = await pickByName(supabase, 'organisations', text(fd, 'client_name'), fd.get('new_client') === 'on', { is_client: true }, 'client')
    if (client.error) return { error: client.error }
    const venue = await pickByName(supabase, 'venues', text(fd, 'venue_name'), fd.get('new_venue') === 'on', {}, 'venue')
    if (venue.error) return { error: venue.error }
    const { data, error } = await supabase
      .from('jobs')
      .update({ ...job, client_id: client.id ?? null, venue_id: venue.id ?? null })
      .eq('id', id)
      .select('id')
    if (error) return { error: friendly(error.message) }
    if (!data?.length) return { error: 'Nothing was saved. Only office roles can edit a job.' }
    revalidatePath(`/jobs/${id}`)
    revalidatePath('/jobs')
    return { ok: true, message: 'Saved.' }
  } catch (e) {
    return oops(e)
  }
}

export async function setStatus(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const id = text(fd, 'id')
    const status = text(fd, 'status')
    if (!isUuid(id) || !STATUSES.some((s) => s.value === status)) return { error: 'Missing job or status.' }
    const { error } = await supabase.rpc('set_job_status', { p_job: id, p_status: status })
    if (error) return { error: friendly(error.message) }
    revalidatePath(`/jobs/${id}`)
    revalidatePath('/jobs')
    return { ok: true, message: 'Status changed.' }
  } catch (e) {
    return oops(e)
  }
}

/** After a change, say in plain words if the job is short on anything. A warning only. */
async function shortageNote(supabase: Db, jobId: string) {
  const { data } = await supabase.rpc('job_shortages', { p_job: jobId })
  const short = ((data ?? []) as { type_name: string; short_by: number }[]).filter((r) => r.short_by > 0)
  if (!short.length) return ''
  const names = short.slice(0, 3).map((r) => `${r.type_name} (short by ${r.short_by})`).join(', ')
  return ` Warning: this job is short on ${short.length === 1 ? '1 item' : `${short.length} items`}: ${names}${short.length > 3 ? ' and more' : ''}. See the top of the page.`
}

export async function addToJob(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const jobId = text(fd, 'job_id')
    const name = text(fd, 'item_name').replace(/\s+/g, ' ')
    const qty = Math.trunc(Number(text(fd, 'qty') || '1'))
    const source = text(fd, 'source') || 'own'
    const order = text(fd, 'order_id')
    if (!isUuid(jobId)) return { error: 'Missing job.' }
    if (!name) return { error: 'Choose an item to add.' }
    if (!Number.isFinite(qty) || qty < 1) return { error: 'The quantity must be 1 or more.' }
    if (!['own', 'sub_hire'].includes(source)) return { error: 'Choose own stock or sub-hire.' }
    if (order && !isUuid(order)) return { error: 'Missing sub-hire order.' }

    const { data: found } = await supabase
      .from('equipment_types')
      .select('id, owned_qty, kind, active')
      .ilike('name', escLike(name))
      .is('archived_at', null)
      .limit(1)
    if (!found?.length) return { error: 'Pick the item from the list, spelled as it appears.' }
    const t = found[0]
    if (source === 'own' && !t.active) return { error: 'That item is switched off, so it cannot be added from our own stock.' }

    const { data, error } = await supabase.rpc('add_to_job', {
      p_job: jobId,
      p_type: t.id,
      p_qty: qty,
      p_source: source,
      p_sub_hire: source === 'sub_hire' && order ? order : null,
    })
    if (error) return { error: friendly(error.message) }
    const res = data as { merged: boolean; skipped: string[] }
    let msg = res.merged ? 'Added to the existing line.' : 'Added.'
    if (res.skipped?.length) msg += ` Left out because they are switched off: ${res.skipped.join(', ')}.`
    msg += await shortageNote(supabase, jobId)
    revalidatePath(`/jobs/${jobId}`)
    revalidatePath('/jobs')
    return { ok: true, message: msg }
  } catch (e) {
    return oops(e)
  }
}

export async function addFreeText(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const jobId = text(fd, 'job_id')
    const description = text(fd, 'description').replace(/\s+/g, ' ')
    const qty = Math.trunc(Number(text(fd, 'qty') || '1'))
    if (!isUuid(jobId)) return { error: 'Missing job.' }
    if (!description) return { error: 'Describe the item.' }
    if (!Number.isFinite(qty) || qty < 1) return { error: 'The quantity must be 1 or more.' }
    const { error } = await supabase.from('job_lines').insert({ job_id: jobId, description, qty_required: qty, source: 'own' })
    if (error) return { error: friendly(error.message) }
    revalidatePath(`/jobs/${jobId}`)
    return { ok: true, message: 'Added.' }
  } catch (e) {
    return oops(e)
  }
}

export async function updateLineQty(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const id = text(fd, 'id')
    const jobId = text(fd, 'job_id')
    const qty = Math.trunc(Number(text(fd, 'qty')))
    if (!isUuid(id) || !isUuid(jobId)) return { error: 'Missing line.' }
    if (!Number.isFinite(qty) || qty < 0) return { error: 'The quantity must be 0 or more.' }
    const { data, error } = await supabase.from('job_lines').update({ qty_required: qty }).eq('id', id).select('id')
    if (error) return { error: friendly(error.message) }
    if (!data?.length) return { error: 'Nothing was saved. Only office roles can edit a list.' }
    revalidatePath(`/jobs/${jobId}`)
    revalidatePath('/jobs')
    return { ok: true, message: 'Saved.' + (await shortageNote(supabase, jobId)) }
  } catch (e) {
    return oops(e)
  }
}

export async function removeLine(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const id = text(fd, 'id')
    const jobId = text(fd, 'job_id')
    if (!isUuid(id) || !isUuid(jobId)) return { error: 'Missing line.' }
    const { data, error } = await supabase
      .from('job_lines')
      .update({ archived_at: new Date().toISOString() })
      .eq('id', id)
      .select('id')
    if (error) return { error: friendly(error.message) }
    if (!data?.length) return { error: 'Nothing was removed. Only office roles can edit a list.' }
    revalidatePath(`/jobs/${jobId}`)
    revalidatePath('/jobs')
    return { ok: true }
  } catch (e) {
    return oops(e)
  }
}

export async function coverShortage(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const jobId = text(fd, 'job_id')
    const typeId = text(fd, 'type_id')
    const order = text(fd, 'order_id')
    const qty = Math.trunc(Number(text(fd, 'qty')))
    if (!isUuid(jobId) || !isUuid(typeId)) return { error: 'Missing job or item.' }
    if (!Number.isFinite(qty) || qty < 1) return { error: 'The quantity must be 1 or more.' }
    if (order && !isUuid(order)) return { error: 'Missing sub-hire order.' }
    const { data, error } = await supabase.rpc('cover_with_sub_hire', {
      p_job: jobId,
      p_type: typeId,
      p_qty: qty,
      p_sub_hire: order || null,
    })
    if (error) return { error: friendly(error.message) }
    revalidatePath(`/jobs/${jobId}`)
    revalidatePath('/jobs')
    return { ok: true, message: `Moved ${data} to sub-hire.` }
  } catch (e) {
    return oops(e)
  }
}

export async function createOrder(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const jobId = text(fd, 'job_id')
    if (!isUuid(jobId)) return { error: 'Missing job.' }
    const from = text(fd, 'hire_from')
    const to = text(fd, 'hire_to')
    const expected = text(fd, 'expected_date')
    if ((from && !isDay(from)) || (to && !isDay(to)) || (expected && !isDay(expected))) return { error: 'Check the dates.' }
    if (from && to && to < from) return { error: 'The hire ends before it starts.' }
    const supplierName = text(fd, 'supplier_name')
    if (!supplierName) return { error: 'Enter the supplier.' }
    const supplier = await pickByName(supabase, 'organisations', supplierName, fd.get('new_supplier') === 'on', { is_supplier: true }, 'supplier')
    if (supplier.error) return { error: supplier.error }
    // Remember that this organisation is a supplier (best effort)
    await supabase.from('organisations').update({ is_supplier: true }).eq('id', supplier.id!).eq('is_supplier', false)
    const { error } = await supabase.from('sub_hire_orders').insert({
      job_id: jobId,
      supplier_id: supplier.id,
      supplier_ref: text(fd, 'supplier_ref') || null,
      hire_from: from || null,
      hire_to: to || null,
      expected_at: expected ? `${expected}T12:00:00Z` : null,
      notes: text(fd, 'notes') || null,
    })
    if (error) return { error: friendly(error.message) }
    revalidatePath(`/jobs/${jobId}`)
    revalidatePath('/jobs')
    return { ok: true, message: 'Order added.' }
  } catch (e) {
    return oops(e)
  }
}

export async function updateOrder(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const id = text(fd, 'id')
    const jobId = text(fd, 'job_id')
    const status = text(fd, 'status')
    if (!isUuid(id) || !isUuid(jobId)) return { error: 'Missing order.' }
    if (!ORDER_STATUSES.some((s) => s.value === status)) return { error: 'Choose a status.' }
    const { data, error } = await supabase
      .from('sub_hire_orders')
      .update({ status, supplier_ref: text(fd, 'supplier_ref') || null })
      .eq('id', id)
      .select('id')
    if (error) return { error: friendly(error.message) }
    if (!data?.length) return { error: 'Nothing was saved.' }
    revalidatePath(`/jobs/${jobId}`)
    revalidatePath('/jobs')
    return { ok: true, message: 'Saved.' }
  } catch (e) {
    return oops(e)
  }
}

export async function removeOrder(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const id = text(fd, 'id')
    const jobId = text(fd, 'job_id')
    if (!isUuid(id) || !isUuid(jobId)) return { error: 'Missing order.' }
    const { data, error } = await supabase
      .from('sub_hire_orders')
      .update({ archived_at: new Date().toISOString() })
      .eq('id', id)
      .select('id')
    if (error) return { error: friendly(error.message) }
    if (!data?.length) return { error: 'Nothing was removed. Only office roles can remove an order.' }
    revalidatePath(`/jobs/${jobId}`)
    revalidatePath('/jobs')
    return { ok: true }
  } catch (e) {
    return oops(e)
  }
}
