'use server'

import { revalidatePath } from 'next/cache'
import { actionDb, friendly, isUuid } from '@/lib/db'
import type { FormState } from '@/components/action-form'

const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()

export async function reportIssue(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase, user } = await actionDb()
    let typeId = text(fd, 'type_id')
    const issue = text(fd, 'issue')
    const qty = Math.trunc(Number(text(fd, 'qty') || '1'))
    const assetNo = text(fd, 'asset_no')
    if (!['damaged', 'missing', 'in_repair'].includes(issue)) return { error: 'Choose damaged, missing or in repair.' }
    if (!Number.isFinite(qty) || qty < 1) return { error: 'The quantity must be 1 or more.' }

    if (!isUuid(typeId)) {
      const name = text(fd, 'item_name').replace(/\s+/g, ' ')
      if (!name) return { error: 'Choose the item.' }
      const { data } = await supabase.from('equipment_types').select('id').eq('name', name).limit(1)
      if (!data?.length) return { error: 'Pick the item from the list, spelled as it appears.' }
      typeId = data[0].id
    }

    let assetId: string | null = null
    if (assetNo) {
      const { data } = await supabase
        .from('asset_register')
        .select('id')
        .eq('type_id', typeId)
        .eq('asset_no', assetNo)
        .limit(1)
      if (!data?.length) return { error: 'No asset with that number for this item. Leave it blank if the item has no asset number.' }
      assetId = data[0].id
    }

    const { error } = await supabase.from('stock_issues').insert({
      type_id: typeId,
      asset_id: assetId,
      qty: assetId ? 1 : qty,
      issue,
      note: text(fd, 'note') || null,
      reported_by: user.id,
    })
    if (error) return { error: friendly(error.message) }
    revalidatePath('/issues')
    revalidatePath('/equipment')
    revalidatePath(`/equipment/${typeId}`)
    return { ok: true, message: 'Reported. It now counts as out of service.' }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}

export async function resolveIssue(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase, user } = await actionDb()
    const id = text(fd, 'id')
    const resolution = text(fd, 'resolution')
    if (!isUuid(id)) return { error: 'Missing issue.' }
    if (!['repaired', 'found', 'written_off', 'replaced'].includes(resolution)) return { error: 'Choose how it was resolved.' }
    const { data, error } = await supabase
      .from('stock_issues')
      .update({ status: 'resolved', resolution, resolved_by: user.id, resolved_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'open')
      .select('id, type_id')
    if (error) return { error: friendly(error.message) }
    if (!data?.length) return { error: 'Nothing was changed. You may not have permission, or it is already resolved.' }
    revalidatePath('/issues')
    revalidatePath('/equipment')
    revalidatePath(`/equipment/${data[0].type_id}`)
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}
