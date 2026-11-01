'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { actionDb, friendly, isUuid } from '@/lib/db'
import type { FormState } from '@/components/action-form'

const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()
const flag = (fd: FormData, k: string) => fd.get(k) === 'on'
const tagList = (s: string) =>
  s.split(',').map((t) => t.trim()).filter(Boolean)
const KINDS = ['stock', 'consumable', 'kit']

export async function createItem(_prev: FormState, fd: FormData): Promise<FormState> {
  let newId = ''
  try {
    const { supabase, role } = await actionDb()
    const name = text(fd, 'name')
    const kind = text(fd, 'kind')
    const category = text(fd, 'category_id')
    if (!name) return { error: 'Enter a name.' }
    if (!KINDS.includes(kind)) return { error: 'Choose what kind of item this is.' }
    const qty = Math.trunc(Number(text(fd, 'opening_qty') || '0'))
    if (!Number.isFinite(qty) || qty < 0) return { error: 'The quantity must be 0 or more.' }

    const { data, error } = await supabase
      .from('equipment_types')
      .insert({
        name,
        kind,
        category_id: isUuid(category) ? category : null,
        tags: tagList(text(fd, 'tags')),
        can_sub_hire: flag(fd, 'can_sub_hire'),
        barcode: text(fd, 'barcode') || null,
        description: text(fd, 'description') || null,
      })
      .select('id')
      .single()
    if (error || !data) return { error: friendly(error?.message ?? 'Could not add the item.') }
    newId = data.id

    if (qty > 0 && kind === 'stock') {
      if (role === 'office' || role === 'warehouse') {
        return { error: 'The item was added with none owned. A lead or admin adds the quantity.' }
      }
      const { error: ae } = await supabase
        .from('stock_adjustments')
        .insert({ type_id: newId, delta: qty, reason: 'purchase', note: 'Opening quantity' })
      if (ae) return { error: `The item was added, but the quantity was refused: ${friendly(ae.message)}` }
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
  revalidatePath('/equipment')
  redirect(`/equipment/${newId}`)
}

export async function updateItem(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const id = text(fd, 'id')
    if (!isUuid(id)) return { error: 'Missing item.' }
    const name = text(fd, 'name')
    const kind = text(fd, 'kind')
    const category = text(fd, 'category_id')
    if (!name) return { error: 'Enter a name.' }
    if (!KINDS.includes(kind)) return { error: 'Choose what kind of item this is.' }
    const weight = text(fd, 'weight_kg')
    const { data, error } = await supabase
      .from('equipment_types')
      .update({
        name,
        kind,
        category_id: isUuid(category) ? category : null,
        tags: tagList(text(fd, 'tags')),
        can_sub_hire: flag(fd, 'can_sub_hire'),
        active: flag(fd, 'active'),
        accessory_only: flag(fd, 'accessory_only'),
        barcode: text(fd, 'barcode') || null,
        weight_kg: weight === '' ? null : Number(weight),
        description: text(fd, 'description') || null,
        notes: text(fd, 'notes') || null,
      })
      .eq('id', id)
      .select('id')
    if (error) return { error: friendly(error.message) }
    if (!data?.length) return { error: 'Nothing was saved. You may not have permission to edit equipment.' }
    revalidatePath('/equipment')
    revalidatePath(`/equipment/${id}`)
    return { ok: true, message: 'Saved.' }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}

export async function adjustStock(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase, role } = await actionDb()
    const id = text(fd, 'id')
    const delta = Math.trunc(Number(text(fd, 'delta')))
    const reason = text(fd, 'reason')
    const note = text(fd, 'note')
    if (!isUuid(id)) return { error: 'Missing item.' }
    if (!Number.isFinite(delta) || delta === 0) return { error: 'Enter how many to add (for example 2) or remove (for example -1).' }
    if (!['purchase', 'disposal', 'write-off', 'correction'].includes(reason)) return { error: 'Choose a reason.' }
    if (role !== 'admin' && !note) return { error: 'Add a note saying why.' }
    const { error } = await supabase
      .from('stock_adjustments')
      .insert({ type_id: id, delta, reason, note: note || null })
    if (error) return { error: friendly(error.message) }
    revalidatePath('/equipment')
    revalidatePath(`/equipment/${id}`)
    return { ok: true, message: 'Quantity updated.' }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}

export async function addAsset(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const typeId = text(fd, 'type_id')
    const assetNo = text(fd, 'asset_no')
    if (!isUuid(typeId)) return { error: 'Missing item.' }
    if (!assetNo) return { error: 'Enter the asset number.' }
    const { error } = await supabase
      .from('asset_register')
      .insert({ type_id: typeId, asset_no: assetNo, serial_no: text(fd, 'serial_no') || null })
    if (error) return { error: friendly(error.message) }
    revalidatePath(`/equipment/${typeId}`)
    return { ok: true, message: 'Asset added.' }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}

export async function setAssetStatus(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase } = await actionDb()
    const id = text(fd, 'id')
    const typeId = text(fd, 'type_id')
    const status = text(fd, 'status')
    if (!isUuid(id) || !['in_service', 'retired'].includes(status)) return { error: 'Missing asset.' }
    const { data, error } = await supabase.from('asset_register').update({ status }).eq('id', id).select('id')
    if (error) return { error: friendly(error.message) }
    if (!data?.length) return { error: 'Nothing was changed. You may not have permission.' }
    revalidatePath(`/equipment/${typeId}`)
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}

export async function setArchived(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { supabase, role } = await actionDb()
    if (role !== 'admin') return { error: 'Only an admin can archive or restore equipment.' }
    const id = text(fd, 'id')
    if (!isUuid(id)) return { error: 'Missing item.' }
    const archive = text(fd, 'archive') === 'yes'
    const { error } = await supabase
      .from('equipment_types')
      .update({ archived_at: archive ? new Date().toISOString() : null })
      .eq('id', id)
    if (error) return { error: friendly(error.message) }
    revalidatePath('/equipment')
    revalidatePath(`/equipment/${id}`)
    return { ok: true, message: archive ? 'Archived.' : 'Restored.' }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}
