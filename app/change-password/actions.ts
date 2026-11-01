'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export type FormState = { error?: string } | undefined

export async function changePassword(_prev: FormState, formData: FormData): Promise<FormState> {
  const password = String(formData.get('password') ?? '')
  const confirm = String(formData.get('confirm') ?? '')
  if (password.length < 12) return { error: 'Use at least 12 characters. A few random words is fine.' }
  if (password !== confirm) return { error: 'The two passwords do not match.' }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { error } = await supabase.auth.updateUser({ password })
  if (error) return { error: error.message }

  const { error: flagError } = await supabase
    .from('profiles')
    .update({ must_change_password: false })
    .eq('id', user.id)
  if (flagError) return { error: 'Password saved, but the account could not be updated. Try again.' }

  redirect('/')
}
