import 'server-only'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import type { Role } from '@/lib/roles'

export type Profile = {
  id: string
  full_name: string
  role: Role
  active: boolean
  must_change_password: boolean
}

/** Signed-in user, their profile and sign-in level. Redirects to /login if not signed in. */
export async function requireSession() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, role, active, must_change_password')
    .eq('id', user.id)
    .single<Profile>()
  if (!profile || !profile.active) redirect('/login?error=inactive')
  const { data: claims } = await supabase.auth.getClaims()
  const aal = (claims?.claims as { aal?: string } | undefined)?.aal ?? 'aal1'
  return { supabase, user, profile, aal }
}

/** Admin who has completed two-factor sign-in. Anyone else is sent home. */
export async function requireAdmin() {
  const s = await requireSession()
  if (s.profile.role !== 'admin' || s.aal !== 'aal2') redirect('/')
  return s
}
