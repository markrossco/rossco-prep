import 'server-only'
import { createClient } from '@supabase/supabase-js'

/**
 * Server-only client using the secret key. It bypasses row level security,
 * so it is used ONLY inside admin server actions after the caller has been
 * verified as a signed-in admin with two-factor sign-in.
 */
export function createAdminClient() {
  const key = process.env.SUPABASE_SECRET_KEY
  if (!key) throw new Error('SUPABASE_SECRET_KEY is not set on the server')
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
