'use server'

import { revalidatePath } from 'next/cache'
import { actionDb, friendly, isUuid } from '@/lib/db'
import type { FormState } from '@/components/action-form'

const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()
const oops = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : 'Something went wrong.' })

function refresh() {
  revalidatePath('/clash')
  revalidatePath('/jobs')
  revalidatePath('/jobs/[id]', 'page')
  revalidatePath('/equipment')
}

/** Move some of an item from one job's list to another job's list. The database checks every rule. */
export async function moveLine(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const lineId = text(fd, 'line_id')
    const toJob = text(fd, 'to_job')
    const qty = Math.trunc(Number(text(fd, 'qty')))
    if (!isUuid(lineId)) return { error: 'Missing line.' }
    if (!isUuid(toJob)) return { error: 'Choose the job to move it to.' }
    if (!Number.isFinite(qty) || qty < 1) return { error: 'The quantity must be 1 or more.' }
    const { error } = await supabase.rpc('move_line_qty', { p_line: lineId, p_to_job: toJob, p_qty: qty })
    if (error) return { error: friendly(error.message) }
    refresh()
    return { ok: true, message: `Moved ${qty}.` }
  } catch (e) {
    return oops(e)
  }
}

/** Cover a clash by moving some of an item on one job over to sub-hire. */
export async function subHireFromClash(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const jobId = text(fd, 'job_id')
    const typeId = text(fd, 'type_id')
    const qty = Math.trunc(Number(text(fd, 'qty')))
    if (!isUuid(jobId) || !isUuid(typeId)) return { error: 'Missing job or item.' }
    if (!Number.isFinite(qty) || qty < 1) return { error: 'The quantity must be 1 or more.' }
    const { data, error } = await supabase.rpc('cover_with_sub_hire', {
      p_job: jobId,
      p_type: typeId,
      p_qty: qty,
      p_sub_hire: null,
    })
    if (error) return { error: friendly(error.message) }
    refresh()
    return { ok: true, message: `Moved ${data} to sub-hire.` }
  } catch (e) {
    return oops(e)
  }
}
