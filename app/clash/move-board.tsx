'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { moveLine, subHireFromClash } from './actions'

export type Card = {
  lineId: string
  jobId: string
  ref: string
  name: string
  status: string
  outDate: string
  returnDate: string
  qty: number
  prepped: number
  mandatory: boolean
  inKit: boolean
}

export type Target = { id: string; ref: string; name: string; status: string; outDate: string; returnDate: string }

const short = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

/**
 * The jobs using an item on the chosen day. Office staff can drag a job's card onto another job,
 * or use the boxes under the card (which also work on a phone). The database checks every move.
 */
export default function MoveBoard({
  typeId,
  cards,
  targets,
  winFrom,
  winTo,
  canEdit,
}: {
  typeId: string
  cards: Card[]
  targets: Target[]
  winFrom: string
  winTo: string
  canEdit: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [qtys, setQtys] = useState<Record<string, number>>({})
  const [picks, setPicks] = useState<Record<string, string>>({})
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const qtyFor = (c: Card) => qtys[c.lineId] ?? 1

  function run(fn: () => Promise<{ ok?: boolean; error?: string; message?: string } | undefined>) {
    setMsg(null)
    start(async () => {
      const r = await fn()
      if (r?.error) setMsg({ ok: false, text: r.error })
      else {
        setMsg({ ok: true, text: r?.message ?? 'Done.' })
        router.refresh()
      }
    })
  }

  function move(c: Card, toJob: string) {
    if (!toJob) {
      setMsg({ ok: false, text: 'Choose the job to move it to.' })
      return
    }
    const fd = new FormData()
    fd.set('line_id', c.lineId)
    fd.set('to_job', toJob)
    fd.set('qty', String(qtyFor(c)))
    run(() => moveLine(undefined, fd))
  }

  function subHire(c: Card) {
    const fd = new FormData()
    fd.set('job_id', c.jobId)
    fd.set('type_id', typeId)
    fd.set('qty', String(qtyFor(c)))
    run(() => subHireFromClash(undefined, fd))
  }

  const zones = targets.filter((t) => t.outDate <= winTo && t.returnDate >= winFrom).slice(0, 40)
  const dragging = cards.find((c) => c.lineId === drag) ?? null

  return (
    <div className="stack">
      {msg && (
        <p className={msg.ok ? 'ok-text' : 'error'} role={msg.ok ? 'status' : 'alert'} style={{ margin: 0 }}>
          {msg.text}
        </p>
      )}

      <div className="move-cards">
        {cards.map((c) => {
          const locked = c.mandatory
          const moveable = canEdit && !locked
          return (
            <div
              key={c.lineId}
              className={`move-card${drag === c.lineId ? ' dragging' : ''}`}
              draggable={moveable && !pending}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', c.lineId)
                e.dataTransfer.effectAllowed = 'move'
                setDrag(c.lineId)
              }}
              onDragEnd={() => {
                setDrag(null)
                setOver(null)
              }}
            >
              <div className="move-head">
                <a href={`/jobs/${c.jobId}`}>
                  <strong>{c.ref}</strong> {c.name}
                </a>
                <span className="badge">{c.status}</span>
              </div>
              <div className="muted" style={{ fontSize: 13 }}>
                {short(c.outDate)} to {short(c.returnDate)} · needs <strong>{c.qty}</strong>
                {c.prepped > 0 ? ` · ${c.prepped} prepped` : ''}
                {c.inKit ? ' · inside a kit' : ''}
              </div>
              {locked && <div className="muted" style={{ fontSize: 13 }}>Mandatory kit content: stays with its kit.</div>}
              {moveable && (
                <div className="move-controls">
                  <label className="sr-only" htmlFor={`q-${c.lineId}`}>How many</label>
                  <input
                    id={`q-${c.lineId}`}
                    type="number"
                    min={1}
                    max={c.qty}
                    value={qtyFor(c)}
                    onChange={(e) => setQtys({ ...qtys, [c.lineId]: Math.trunc(Number(e.target.value)) || 1 })}
                    aria-label="How many to move"
                  />
                  <label className="sr-only" htmlFor={`t-${c.lineId}`}>Move to job</label>
                  <select
                    id={`t-${c.lineId}`}
                    value={picks[c.lineId] ?? ''}
                    onChange={(e) => setPicks({ ...picks, [c.lineId]: e.target.value })}
                  >
                    <option value="">Move to job…</option>
                    {targets
                      .filter((t) => t.id !== c.jobId)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.ref} {t.name} ({short(t.outDate)} to {short(t.returnDate)})
                        </option>
                      ))}
                  </select>
                  <button type="button" className="small" disabled={pending} onClick={() => move(c, picks[c.lineId] ?? '')}>
                    Move
                  </button>
                  <button type="button" className="small secondary" disabled={pending} onClick={() => subHire(c)}>
                    Sub-hire instead
                  </button>
                </div>
              )}
            </div>
          )
        })}
        {cards.length === 0 && <p className="muted">No live job has this item out on that day.</p>}
      </div>

      {canEdit && cards.some((c) => !c.mandatory) && zones.length > 0 && (
        <div>
          <p className="muted" style={{ margin: '0 0 8px', fontSize: 14 }}>
            Or drag a job above onto one of these jobs, which run in the dates shown on the grid.
            {dragging ? ` Moving ${qtyFor(dragging)} from ${dragging.ref}.` : ''}
          </p>
          <div className="drop-zones">
            {zones.map((t) => (
              <div
                key={t.id}
                className={`drop-zone${over === t.id ? ' over' : ''}`}
                onDragOver={(e) => {
                  if (!drag) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  setOver(t.id)
                }}
                onDragLeave={() => setOver((o) => (o === t.id ? null : o))}
                onDrop={(e) => {
                  e.preventDefault()
                  const id = e.dataTransfer.getData('text/plain') || drag
                  const c = cards.find((x) => x.lineId === id)
                  setOver(null)
                  setDrag(null)
                  if (c) move(c, t.id)
                }}
              >
                <strong>{t.ref}</strong> {t.name}
                <div className="muted" style={{ fontSize: 12 }}>
                  {short(t.outDate)} to {short(t.returnDate)} · {t.status}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
