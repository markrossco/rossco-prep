'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export type FormState = { error?: string } | undefined

export async function signIn(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  const password = String(formData.get('password') ?? '')
  if (!email || !password) return { error: 'Enter your email and password.' }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) {
    if (error.code === 'invalid_credentials') return { error: 'That email and password do not match.' }
    if (error.code === 'over_request_rate_limit') return { error: 'Too many attempts. Wait a few minutes and try again.' }
    if (error.code === 'user_banned') return { error: 'This account is switched off. Ask an admin.' }
    return { error: `Sign-in is not working (${error.code ?? error.status ?? 'unknown'}). Tell the person who looks after the system.` }
  }
  redirect('/')
}
