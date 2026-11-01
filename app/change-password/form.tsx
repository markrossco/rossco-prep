'use client'

import { useActionState, useState } from 'react'
import { changePassword, type FormState } from './actions'

export default function ChangePasswordForm({ forced }: { forced: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(changePassword, undefined)
  const [show, setShow] = useState(false)
  return (
    <form action={action} className="card">
      <h1 style={{ marginTop: 0 }}>{forced ? 'Choose your own password' : 'Change password'}</h1>
      {forced && <p className="lead">You are signed in with a temporary password. Pick a new one to carry on.</p>}
      <label htmlFor="password">New password</label>
      <input id="password" name="password" type={show ? 'text' : 'password'} autoComplete="new-password" minLength={12} required autoFocus />
      <label htmlFor="confirm">Type it again</label>
      <input id="confirm" name="confirm" type={show ? 'text' : 'password'} autoComplete="new-password" minLength={12} required />
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400, marginTop: 10 }}>
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} style={{ width: 20, minHeight: 20 }} />
        Show passwords
      </label>
      {state?.error && <p className="error" role="alert">{state.error}</p>}
      <p style={{ marginTop: 20 }}>
        <button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save password'}</button>
      </p>
    </form>
  )
}
