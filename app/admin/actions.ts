'use server'

import { randomInt } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { ROLES, type Role } from '@/lib/roles'

export type ActionState = { ok?: boolean; error?: string; tempPassword?: string; email?: string } | undefined

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

function tempPassword() {
  let out = ''
  for (let i = 0; i < 16; i++) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}

/** Verifies the caller is an active admin who has completed two-factor sign-in. */
async function requireAdminCaller() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')
  const { data: claims } = await supabase.auth.getClaims()
  if ((claims?.claims as { aal?: string } | undefined)?.aal !== 'aal2') throw new Error('Two-factor sign-in required')
  const { data: p } = await supabase.from('profiles').select('role, active').eq('id', user.id).single()
  if (!p || p.role !== 'admin' || !p.active) throw new Error('Admins only')
  return { callerId: user.id }
}

const validRole = (r: string): r is Role => ROLES.some((x) => x.value === r)

async function otherActiveAdmins(excludingId: string) {
  const admin = createAdminClient()
  const { count } = await admin
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'admin')
    .eq('active', true)
    .neq('id', excludingId)
  return count ?? 0
}

export async function createUser(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    await requireAdminCaller()
    const email = String(formData.get('email') ?? '').trim().toLowerCase()
    const fullName = String(formData.get('full_name') ?? '').trim()
    const role = String(formData.get('role') ?? '')
    if (!email.includes('@') || !fullName || !validRole(role)) return { error: 'Enter a name, a valid email and a role.' }

    const admin = createAdminClient()
    const password = tempPassword()
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    })
    if (error || !data.user) return { error: error?.message ?? 'Could not create the user.' }

    const { error: pe } = await admin
      .from('profiles')
      .update({ full_name: fullName, role, active: true, must_change_password: true })
      .eq('id', data.user.id)
    if (pe) return { error: `User created but the role could not be set: ${pe.message}` }

    revalidatePath('/admin')
    return { ok: true, tempPassword: password, email }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}

export async function setRole(formData: FormData) {
  const { callerId } = await requireAdminCaller()
  const id = String(formData.get('id') ?? '')
  const role = String(formData.get('role') ?? '')
  if (!id || !validRole(role)) return
  if (id === callerId && role !== 'admin') return // cannot demote yourself
  const admin = createAdminClient()
  if (role !== 'admin' && (await otherActiveAdmins(id)) === 0) {
    const { data: cur } = await admin.from('profiles').select('role').eq('id', id).single()
    if (cur?.role === 'admin') return // keep at least one admin
  }
  await admin.from('profiles').update({ role }).eq('id', id)
  revalidatePath('/admin')
}

export async function setActive(formData: FormData) {
  const { callerId } = await requireAdminCaller()
  const id = String(formData.get('id') ?? '')
  const active = String(formData.get('active') ?? '') === 'true'
  if (!id) return
  if (id === callerId && !active) return // cannot switch yourself off
  const admin = createAdminClient()
  if (!active) {
    const { data: cur } = await admin.from('profiles').select('role').eq('id', id).single()
    if (cur?.role === 'admin' && (await otherActiveAdmins(id)) === 0) return
  }
  await admin.from('profiles').update({ active }).eq('id', id)
  // Also block sign-in at the account level while switched off
  await admin.auth.admin.updateUserById(id, { ban_duration: active ? 'none' : '876000h' })
  revalidatePath('/admin')
}

export async function resetPassword(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    await requireAdminCaller()
    const id = String(formData.get('id') ?? '')
    if (!id) return { error: 'Missing user.' }
    const admin = createAdminClient()
    const password = tempPassword()
    const { error } = await admin.auth.admin.updateUserById(id, { password })
    if (error) return { error: error.message }
    await admin.from('profiles').update({ must_change_password: true }).eq('id', id)
    revalidatePath('/admin')
    return { ok: true, tempPassword: password }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}
