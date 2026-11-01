'use client'

import { useActionState } from 'react'
import { createUser, resetPassword, type ActionState } from './actions'
import { ROLES } from '@/lib/roles'

export function NewUserForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(createUser, undefined)
  return (
    <form action={action} className="card">
      <h2 style={{ marginTop: 0 }}>Add a user</h2>
      <div className="row">
        <div>
          <label htmlFor="full_name">Full name</label>
          <input id="full_name" name="full_name" required />
        </div>
        <div>
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" required />
        </div>
        <div>
          <label htmlFor="role">Role</label>
          <select id="role" name="role" defaultValue="warehouse">
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>
      </div>
      {state?.error && <p className="error" role="alert">{state.error}</p>}
      {state?.ok && state.tempPassword && (
        <div className="notice">
          <strong>{state.email} created.</strong> Give them this temporary password. It is shown once and they
          must change it when they first sign in:
          <p className="mono">{state.tempPassword}</p>
        </div>
      )}
      <p style={{ marginTop: 16 }}>
        <button type="submit" disabled={pending}>{pending ? 'Adding…' : 'Add user'}</button>
      </p>
    </form>
  )
}

export function ResetPasswordButton({ id }: { id: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(resetPassword, undefined)
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="secondary small" disabled={pending}>
        {pending ? '…' : 'Reset password'}
      </button>
      {state?.error && <span className="error"> {state.error}</span>}
      {state?.ok && state.tempPassword && (
        <span className="mono" style={{ fontSize: 14, marginLeft: 8 }}>{state.tempPassword}</span>
      )}
    </form>
  )
}
