'use client'

import { useActionState } from 'react'
import { signIn, type FormState } from './actions'

export default function LoginForm({ notice }: { notice?: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(signIn, undefined)
  return (
    <form action={action} className="card">
      <h1 style={{ marginTop: 0 }}>Rossco Prep</h1>
      <p className="lead">Sign in with your own account.</p>
      {notice && <p className="error">{notice}</p>}
      <label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      <label htmlFor="password">Password</label>
      <input id="password" name="password" type="password" autoComplete="current-password" required />
      {state?.error && <p className="error" role="alert">{state.error}</p>}
      <p style={{ marginTop: 20 }}>
        <button type="submit" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
      </p>
    </form>
  )
}
