'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Enrol = { id: string; qr: string; secret: string }

export default function MfaForm() {
  const router = useRouter()
  const supabase = createClient()
  const [factorId, setFactorId] = useState<string | null>(null)
  const [enrol, setEnrol] = useState<Enrol | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase.auth.mfa.listFactors()
      if (cancelled) return
      if (error) {
        setError(error.message)
        setReady(true)
        return
      }
      const verified = data.totp.find((f) => f.status === 'verified')
      if (verified) {
        setFactorId(verified.id)
        setReady(true)
        return
      }
      // Clear any half-finished set-up, then start a fresh one
      for (const f of data.all.filter((x) => x.status === 'unverified')) {
        await supabase.auth.mfa.unenroll({ factorId: f.id })
      }
      const res = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Rossco Prep' })
      if (cancelled) return
      if (res.error) {
        setError(res.error.message)
      } else {
        setEnrol({ id: res.data.id, qr: res.data.totp.qr_code, secret: res.data.totp.secret })
        setFactorId(res.data.id)
      }
      setReady(true)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!factorId) return
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() })
    setBusy(false)
    if (error) {
      setError('That code was not accepted. Wait for a new one and try again.')
      setCode('')
      return
    }
    router.replace('/')
    router.refresh()
  }

  return (
    <form onSubmit={submit} className="card">
      <h1 style={{ marginTop: 0 }}>{enrol ? 'Set up two-factor sign-in' : 'Two-factor sign-in'}</h1>
      {!ready && <p className="lead">Loading…</p>}
      {enrol && (
        <>
          <p className="lead">
            Admin accounts need a six-digit code from an authenticator app (Microsoft Authenticator, Google
            Authenticator, 1Password). Scan this, then type the code the app shows.
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={enrol.qr} alt="QR code for your authenticator app" width={200} height={200} />
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>
            Cannot scan? Enter this key in the app instead:
            <br />
            <span className="mono" style={{ fontSize: 14 }}>{enrol.secret}</span>
          </p>
        </>
      )}
      {ready && !enrol && factorId && <p className="lead">Enter the six-digit code from your authenticator app.</p>}
      {ready && factorId && (
        <>
          <label htmlFor="code">Six-digit code</label>
          <input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            required
            autoFocus
          />
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {ready && factorId && (
        <p style={{ marginTop: 20 }}>
          <button type="submit" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Continue'}</button>
        </p>
      )}
    </form>
  )
}
