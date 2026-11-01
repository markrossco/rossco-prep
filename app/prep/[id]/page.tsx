import { Fragment } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import Topbar from '@/components/topbar'
import ActionForm from '@/components/action-form'
import { requireSession } from '@/lib/session'
import { isUuid } from '@/lib/db'
import { FINISHED, fmtDate, statusLabel } from '@/lib/jobs'
import { markJob, prepLine, unprepLine } from '../../warehouse/actions'

type Job = {
  id: string
  ref: string
  name: string
  status: string
  out_date: string
  return_date: string
  notes: string | null
  client: { name: string } | null
  venue: { name: string } | null
}
type Line = {
  id: string
  description: string | null
  qty_required: number
  source: 'own' | 'sub_hire'
  parent_line_id: string | null
  added_late: boolean
  type: { name: string; kind: string } | null
}
type Prog = { line_id: string; prepped_qty: number; received_qty: number; last_event_at: string | null; last_user_id: string | null }

export default async function PrepPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()
  const { profile, supabase } = await requireSession()

  const { data: job } = await supabase
    .from('jobs')
    .select('id, ref, name, status, out_date, return_date, notes, client:organisations(name), venue:venues(name)')
    .eq('id', id)
    .is('archived_at', null)
    .maybeSingle<Job>()
  if (!job) notFound()
  const finished = FINISHED.includes(job.status)

  const [{ data: lineData }, { data: progData }] = await Promise.all([
    supabase
      .from('job_lines')
      .select('id, description, qty_required, source, parent_line_id, added_late, type:equipment_types(name, kind)')
      .eq('job_id', id)
      .is('archived_at', null)
      .order('added_at')
      .order('id'),
    supabase.from('line_progress').select('line_id, prepped_qty, received_qty, last_event_at, last_user_id').eq('job_id', id),
  ])
  const lines = (lineData ?? []) as unknown as Line[]
  const prog = new Map(((progData ?? []) as Prog[]).map((p) => [p.line_id, p]))
  const userIds = [...new Set(((progData ?? []) as Prog[]).map((p) => p.last_user_id).filter((u): u is string => !!u))]
  const { data: people } = userIds.length ? await supabase.from('profiles').select('id, full_name').in('id', userIds) : { data: [] }
  const who = new Map((people ?? []).map((p: { id: string; full_name: string }) => [p.id, p.full_name.split(' ')[0] || p.full_name]))

  const real = lines.filter((l) => l.type?.kind !== 'kit' && l.qty_required > 0)
  const doneCount = real.filter((l) => (prog.get(l.id)?.prepped_qty ?? 0) >= l.qty_required).length
  const tops = lines.filter((l) => !l.parent_line_id)
  const kids = (pid: string) => lines.filter((c) => c.parent_line_id === pid)

  const row = (l: Line, child: boolean) => {
    const isKit = l.type?.kind === 'kit'
    const p = prog.get(l.id)
    const prepped = p?.prepped_qty ?? 0
    const received = p?.received_qty ?? 0
    const remaining = Math.max(0, l.qty_required - prepped)
    const waitingForSubHire = l.source === 'sub_hire' && received - prepped < 1
    const name = l.type?.name ?? l.description ?? ''
    if (isKit) {
      return (
        <tr key={l.id}>
          <td colSpan={4}><strong>{name}</strong> <span className="badge">kit</span></td>
        </tr>
      )
    }
    if (l.qty_required === 0) return null
    return (
      <tr key={l.id}>
        <td style={child ? { paddingLeft: 28 } : undefined}>
          {name}{' '}
          {l.type?.kind === 'consumable' && <span className="badge">consumable</span>}
          {l.added_late && <span className="badge warn" title="Added after prep started">late</span>}
          {l.source === 'sub_hire' && <span className="badge">sub-hire · {received} of {l.qty_required} received</span>}
        </td>
        <td className="num">
          <strong>{prepped}</strong> / {l.qty_required}
          {prepped >= l.qty_required && <span className="badge good">done</span>}
          {p?.last_user_id && prepped > 0 && (
            <div className="muted" style={{ fontSize: 12 }}>{who.get(p.last_user_id) ?? ''}</div>
          )}
        </td>
        <td>
          {!finished && remaining > 0 && !waitingForSubHire && (
            <ActionForm action={prepLine} submit="Prep" small inline>
              <input type="hidden" name="line_id" value={l.id} />
              <input type="hidden" name="job_id" value={id} />
              <input
                name="qty"
                inputMode="numeric"
                defaultValue={l.source === 'sub_hire' ? Math.min(remaining, received - prepped) : remaining}
                aria-label={`How many of ${name} you have prepped`}
                style={{ width: 70 }}
              />
            </ActionForm>
          )}
          {!finished && remaining > 0 && waitingForSubHire && (
            <span className="muted">Receive the sub-hire first (<Link href="/receive">Sub-hire receipt</Link>)</span>
          )}
        </td>
        <td>
          {!finished && prepped > 0 && (
            <ActionForm action={unprepLine} submit="Take off" small secondary inline>
              <input type="hidden" name="line_id" value={l.id} />
              <input type="hidden" name="job_id" value={id} />
              <input name="qty" inputMode="numeric" defaultValue="1" aria-label={`How many of ${name} to take off`} style={{ width: 60 }} />
            </ActionForm>
          )}
        </td>
      </tr>
    )
  }

  return (
    <>
      <Topbar name={profile.full_name} role={profile.role} />
      <div className="shell">
        <h1>Prep: {job.ref} · {job.name}</h1>
        <p className="lead">
          <Link href="/">Home</Link> · <Link href="/warehouse">Today and this week</Link> · <Link href={`/jobs/${id}`}>Full job page</Link>
        </p>
        <div className="stats">
          <div className="stat"><strong>{statusLabel(job.status)}</strong><span>Status</span></div>
          <div className="stat"><strong>{fmtDate(job.out_date)}</strong><span>Out</span></div>
          <div className="stat"><strong>{fmtDate(job.return_date)}</strong><span>Back</span></div>
          <div className="stat"><strong>{doneCount} / {real.length}</strong><span>Lines fully prepped</span></div>
          <div className="stat"><strong style={{ fontSize: 16 }}>{job.client?.name ?? '-'}</strong><span>Client</span></div>
        </div>
        {job.notes && <p className="card" style={{ whiteSpace: 'pre-wrap' }}>{job.notes}</p>}

        <div className="card" style={{ marginTop: 12 }}>
          {['confirmed', 'prepping', 'prepped'].includes(job.status) && (
            <>
              {doneCount < real.length && (
                <p className="muted" style={{ marginTop: 0 }}>
                  {real.length - doneCount} {real.length - doneCount === 1 ? 'line is' : 'lines are'} not fully prepped yet.
                </p>
              )}
              <ActionForm action={markJob} submit="Mark the job out" small>
                <input type="hidden" name="job_id" value={id} />
                <input type="hidden" name="status" value="out" />
              </ActionForm>
            </>
          )}
          {job.status === 'out' && (
            <p style={{ margin: 0 }}>This job is out. <Link href={`/checkin/${id}`}>Go to check-in</Link> when it comes back.</p>
          )}
          {job.status === 'returned' && <p style={{ margin: 0 }}>This job is back in the warehouse.</p>}
          {job.status === 'provisional' && <p className="muted" style={{ margin: 0 }}>This job is still provisional. The office confirms it before prep.</p>}
          {finished && job.status !== 'returned' && <p className="muted" style={{ margin: 0 }}>This job is {statusLabel(job.status).toLowerCase()}.</p>}
        </div>

        <h2>Equipment list</h2>
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>Item</th><th className="num">Prepped</th><th>Prep how many</th><th></th></tr>
            </thead>
            <tbody>
              {tops.map((t) => (
                <Fragment key={t.id}>
                  {row(t, false)}
                  {kids(t.id).map((c) => row(c, true))}
                </Fragment>
              ))}
              {tops.length === 0 && <tr><td colSpan={4} className="muted">Nothing on the list yet. The office adds it on the job page.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
