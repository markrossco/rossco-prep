'use client'

import { useActionState, useEffect, useRef, type ReactNode } from 'react'

export type FormState = { ok?: boolean; error?: string; message?: string } | undefined

type Props = {
  action: (prev: FormState, formData: FormData) => Promise<FormState>
  submit: string
  children?: ReactNode
  secondary?: boolean
  small?: boolean
  inline?: boolean
  clearOnSuccess?: boolean
}

/** A form that shows the server's answer (done, or the reason it was refused) under the fields. */
export default function ActionForm({ action, submit, children, secondary, small, inline, clearOnSuccess }: Props) {
  const [state, run, pending] = useActionState<FormState, FormData>(action, undefined)
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (state?.ok && clearOnSuccess) ref.current?.reset()
  }, [state, clearOnSuccess])
  const cls = ['', secondary ? 'secondary' : '', small ? 'small' : ''].join(' ').trim()
  return (
    <form action={run} ref={ref} className={inline ? 'inline-form' : undefined}>
      {children}
      {inline ? null : <div style={{ height: 12 }} />}
      <button type="submit" className={cls || undefined} disabled={pending}>
        {pending ? 'Working…' : submit}
      </button>
      {state?.error && <p className="error" role="alert">{state.error}</p>}
      {state?.ok && state.message && <p className="ok-text" role="status">{state.message}</p>}
    </form>
  )
}
