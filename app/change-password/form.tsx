'use client'

import { useActionState } from 'react'
import { changePassword, type FormState } from './actions'

export default function ChangePasswordForm({ forced }: { forced: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(changePassword, undefined)
  return (
    <form action={action} className="card">
      <h1 style={{ marginTop: 0 }}>{forced ? 'Choose your own password' : 'Change password'}</h1>
      {forced && <p className="lead">You are signed in with a temporary password. Pick a new one to carry on.</p>}
      <label htmlFor="password">New password</label>
      <input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required autoFocus />
      <label htmlFor="confirm">Type it again</label>
      <input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={12} required />
      {state?.error && <p className="error" role="alert">{state.error}</p>}
      <p style={{ marginTop: 20 }}>
        <button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save password'}</button>
      </p>
    </form>
  )
}
