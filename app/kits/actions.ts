'use server'

import { revalidatePath } from 'next/cache'
import { actionDb, friendly, isUuid } from '@/lib/db'
import type { FormState } from '@/components/action-form'

const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()
const INCLUSIONS = ['mandatory', 'default', 'optional']

export async function addContent(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase, role } = await actionDb()
    const parent = text(fd, 'parent_type_id')
    const name = text(fd, 'item_name').replace(/\s+/g, ' ')
    const inclusion = text(fd, 'inclusion')
    const qty = Math.trunc(Number(text(fd, 'qty_per_parent') || '1'))
    if (!isUuid(parent)) return { error: 'Missing kit.' }
    if (!name) return { error: 'Choose an item to add.' }
    if (!INCLUSIONS.includes(inclusion)) return { error: 'Choose mandatory, default or optional.' }
    if (!Number.isFinite(qty) || qty < 1) return { error: 'The quantity must be 1 or more.' }

    const { data: found } = await supabase.from('equipment_types').select('id').eq('name', name).limit(1)
    if (!found?.length) return { error: 'Pick the item from the list, spelled as it appears.' }
    const child = found[0].id

    const { data: existing } = await supabase
      .from('type_accessories')
      .select('id, archived_at')
      .eq('parent_type_id', parent)
      .eq('child_type_id', child)
      .limit(1)
    if (existing?.length) {
      if (!existing[0].archived_at) return { error: 'That item is already in the contents.' }
      if (role !== 'admin') return { error: 'That item was removed earlier. Only an admin can put it back.' }
      const { error } = await supabase
        .from('type_accessories')
        .update({ archived_at: null, inclusion, qty_per_parent: qty })
        .eq('id', existing[0].id)
      if (error) return { error: friendly(error.message) }
    } else {
      const { error } = await supabase
        .from('type_accessories')
        .insert({ parent_type_id: parent, child_type_id: child, inclusion, qty_per_parent: qty })
      if (error) return { error: friendly(error.message) }
    }
    revalidatePath(`/kits/${parent}`)
    revalidatePath('/kits')
    return { ok: true, message: 'Added.' }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}

export async function updateContent(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const id = text(fd, 'id')
    const parent = text(fd, 'parent_type_id')
    const inclusion = text(fd, 'inclusion')
    const qty = Math.trunc(Number(text(fd, 'qty_per_parent') || '1'))
    if (!isUuid(id) || !INCLUSIONS.includes(inclusion)) return { error: 'Missing content.' }
    if (!Number.isFinite(qty) || qty < 1) return { error: 'The quantity must be 1 or more.' }
    const { data, error } = await supabase
      .from('type_accessories')
      .update({ inclusion, qty_per_parent: qty })
      .eq('id', id)
      .select('id')
    if (error) return { error: friendly(error.message) }
    if (!data?.length) return { error: 'Nothing was saved. Only an admin or office lead can edit contents.' }
    revalidatePath(`/kits/${parent}`)
    return { ok: true, message: 'Saved.' }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}

export async function removeContent(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const id = text(fd, 'id')
    const parent = text(fd, 'parent_type_id')
    if (!isUuid(id)) return { error: 'Missing content.' }
    const { data, error } = await supabase
      .from('type_accessories')
      .update({ archived_at: new Date().toISOString() })
      .eq('id', id)
      .select('id')
    if (error) return { error: friendly(error.message) }
    if (!data?.length) return { error: 'Nothing was removed. Only an admin or office lead can edit contents.' }
    revalidatePath(`/kits/${parent}`)
    revalidatePath('/kits')
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}
