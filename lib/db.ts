import 'server-only'
import { createClient } from '@/lib/supabase/server'

/** Signed-in database client for a server action. The database rules decide what is allowed. */
export async function actionDb() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Please sign in again.')
  const { data: profile } = await supabase.from('profiles').select('role, active').eq('id', user.id).single()
  if (!profile || !profile.active) throw new Error('Your account is switched off.')
  return { supabase, user, role: profile.role as string }
}

/** Plain-words version of a database error. The rule messages written in the database pass through as they are. */
export function friendly(message: string) {
  if (/row-level security|permission denied/i.test(message)) return 'You do not have permission to do that.'
  if (/equipment_types_name_ci|equipment_types_name_key/.test(message)) return 'An item with that name already exists.'
  if (/asset_register_asset_no_key/.test(message)) return 'That asset number is already used.'
  if (/type_accessories_parent_type_id_child_type_id_key/.test(message)) return 'That item is already in the contents.'
  return message
}

export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
