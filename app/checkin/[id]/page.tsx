import { Fragment } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import Topbar from '@/components/topbar'
import ActionForm from '@/components/action-form'
import { requireSession } from '@/lib/session'
import { isUuid } from '@/lib/db'
import { fmtDate, statusLabel } from '@/lib/jobs'
import { pendingReports, takeFor } from '@/lib/checkin'
import { checkInJob } from '../../warehouse/actions'

type Job = { id: string; ref: string; name: string; status: string; out_date: string; return_date: string; client: { name: string } | null }
type Reported = {
  id: string
  type_name: string
  qty: number
  issue: string
  status: string
  note: string | null
  photo_path: string | null
  reported_by_name: string | null
  reported_at: string
}
type Line = {
  id: string
  type_id: string | null
  description: string | null
  source: 'own' | 'sub_hire'
  parent_line_id: string | null
  type: { name: string; kind: string } | null
}
type Prog = { line_id: string; prepped_qty: number; returned_qty: number; missing_qty: number; damaged_qty: number }

export default async function CheckinPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()
  const { profile, supabase } = await requireSession()

  const { data: job } = await supabase
    .from('jobs')
    .select('id, ref, name, status, out_date, return_date, client:organisations(name)')
    .eq('id', id)
    .is('archived_at', null)
    .maybeSingle<Job>()
  if (!job) notFound()

  const [{ data: lineData }, { data: progData }] = await Promise.all([
    supabase
      .from('job_lines')
      .select('id, type_id, description, source, parent_line_id, type:equipment_types(name, kind)')
      .eq('job_id', id)
      .is('archived_at', null)
      .order('added_at')
      .order('id'),
    supabase.from('line_progress').select('line_id, prepped_qty, returned_qty, missing_qty, damaged_qty').eq('job_id', id),
  ])
  const lines = (lineData ?? []) as unknown as Line[]
  const prog = new Map(((progData ?? []) as Prog[]).map((p) => [p.line_id, p]))
  const pending = await pendingReports(supabase, id, lines, prog)

  // Kit reported on this job already, with photos
  const { data: reportedData } = await supabase
    .from('issue_list')
    .select('id, type_name, qty, issue, status, note, photo_path, reported_by_name, reported_at')
    .eq('job_id', id)
    .order('reported_at')
  const reported = (reportedData ?? []) as Reported[]
  const photoPaths = reported.map((r) => r.photo_path).filter((p): p is string => !!p)
  const signed = photoPaths.length ? await supabase.storage.from('issue-photos').createSignedUrls(photoPaths, 3600) : null
  const photoUrl = new Map((signed?.data ?? []).filter((x) => x.signedUrl).map((x) => [x.path as string, x.signedUrl]))
  const reportedByType = new Map<string, string>()
  for (const l of lines) {
    const p = l.type_id ? pending.get(l.type_id) : undefined
    if (l.type_id && p && (p.damaged || p.missing)) {
      reportedByType.set(l.type_id, [p.damaged ? `${p.damaged} reported damaged` : '', p.missing ? `${p.missing} reported missing` : ''].filter(Boolean).join(', '))
    }
  }
  // Pre-fill each line with what was already reported, then hand out what is left to the next line of the same item
  const prefill = new Map<string, { dam: number; mis: number }>()
  for (const l of lines) {
    const { out, back } = { out: prog.get(l.id)?.prepped_qty ?? 0, back: (prog.get(l.id)?.returned_qty ?? 0) + (prog.get(l.id)?.missing_qty ?? 0) + (prog.get(l.id)?.damaged_qty ?? 0) }
    if (out - back > 0 && l.type?.kind !== 'kit') prefill.set(l.id, takeFor(pending, l.type_id, out - back))
  }
  const info = (l: Line) => {
    const p = prog.get(l.id)
    const out = p?.prepped_qty ?? 0
    const back = (p?.returned_qty ?? 0) + (p?.missing_qty ?? 0) + (p?.damaged_qty ?? 0)
    return { out, back, remaining: out - back, p }
  }

  const items = lines.filter((l) => l.type?.kind !== 'kit' && info(l).out > 0)
  const open = items.filter((l) => info(l).remaining > 0)
  const tops = lines.filter((l) => !l.parent_line_id)
  const kids = (pid: string) => lines.filter((c) => c.parent_line_id === pid)
  const canBook = open.length > 0

  const row = (l: Line, child: boolean) => {
    if (l.type?.kind === 'kit') return null
    const { out, back, remaining, p } = info(l)
    if (out === 0) return null
    const name = l.type?.name ?? l.description ?? ''
    const pre = prefill.get(l.id) ?? { dam: 0, mis: 0 }
    return (
      <tr key={l.id}>
        <td style={child ? { paddingLeft: 28 } : undefined}>
          {name}{' '}
          {pre.dam + pre.mis > 0 && (
            <span className="badge warn">
              {[pre.dam ? `${pre.dam} reported damaged` : '', pre.mis ? `${pre.mis} reported missing` : ''].filter(Boolean).join(', ')}
            </span>
          )}
          {l.source === 'sub_hire' && <span className="badge">sub-hire</span>}
          {l.type?.kind === 'consumable' && <span className="badge">consumable</span>}
        </td>
        <td className="num">{out}</td>
        <td className="num muted">
          {back > 0 ? `${p?.returned_qty ?? 0} ok${p?.missing_qty ? `, ${p.missing_qty} missing` : ''}${p?.damaged_qty ? `, ${p.damaged_qty} damaged` : ''}` : '-'}
        </td>
        <td className="num">{remaining > 0 ? <strong>{remaining}</strong> : <span className="badge good">all back</span>}</td>
        {remaining > 0 ? (
          <>
            <td><input name={`ret_${l.id}`} inputMode="numeric" defaultValue={remaining - pre.dam - pre.mis} aria-label={`${name} returned OK`} style={{ width: 64 }} /></td>
            <td><input name={`mis_${l.id}`} inputMode="numeric" placeholder="0" defaultValue={pre.mis || undefined} aria-label={`${name} missing`} style={{ width: 64 }} /></td>
            <td><input name={`dam_${l.id}`} inputMode="numeric" placeholder="0" defaultValue={pre.dam || undefined} aria-label={`${name} damaged`} style={{ width: 64 }} /></td>
          </>
        ) : (
          <td colSpan={3}></td>
        )}
      </tr>
    )
  }

  return (
    <>
      <Topbar name={profile.full_name} role={profile.role} />
      <div className="shell">
        <h1>Check in: {job.ref} · {job.name}</h1>
        <p className="lead">
          <Link href="/">Home</Link> · <Link href="/checkin">Return check-in</Link> · <Link href={`/jobs/${id}`}>Full job page</Link>
        </p>
        <div className="stats">
          <div className="stat"><strong>{statusLabel(job.status)}</strong><span>Status</span></div>
          <div className="stat"><strong>{fmtDate(job.return_date)}</strong><span>Due back</span></div>
          <div className="stat"><strong>{open.length}</strong><span>Lines still out</span></div>
          <div className="stat"><strong style={{ fontSize: 16 }}>{job.client?.name ?? '-'}</strong><span>Client</span></div>
        </div>

        {items.length === 0 && <p className="card">Nothing was prepped on this job, so there is nothing to check in.</p>}

        {reported.length > 0 && (
          <section className="card" style={{ marginBottom: 20, borderColor: 'var(--danger)' }}>
            <h2 style={{ marginTop: 0 }}>Already reported on this job</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              These are filled in below. Check them against what comes back. They will not be reported twice.
            </p>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Item</th><th>Issue</th><th className="num">Qty</th><th>Reported by</th><th>Note</th></tr></thead>
                <tbody>
                  {reported.map((r) => (
                    <tr key={r.id}>
                      <td>{r.type_name}</td>
                      <td>{r.issue === 'damaged' ? 'Damaged' : r.issue === 'missing' ? 'Missing' : 'In repair'}{r.status === 'resolved' && <span className="badge good">resolved</span>}</td>
                      <td className="num">{r.qty}</td>
                      <td className="muted">{r.reported_by_name ?? 'unknown'} · {new Date(r.reported_at).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                      <td className="muted">
                        {r.note ?? ''}
                        {r.photo_path && photoUrl.get(r.photo_path) ? (
                          <>
                            {' '}
                            <a href={photoUrl.get(r.photo_path) ?? '#'} target="_blank" rel="noreferrer">Photo</a>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {canBook && (
          <>
            <section className="card" style={{ maxWidth: 640 }}>
              <h2 style={{ marginTop: 0 }}>Everything came back fine</h2>
              <p className="muted" style={{ marginTop: 0 }}>
                Books every line still out as returned OK{reportedByType.size > 0 ? ', except kit already reported damaged or missing, which is booked back as reported' : ''}.
              </p>
              <ActionForm action={checkInJob} submit="Book everything back" small>
                <input type="hidden" name="job_id" value={id} />
                <input type="hidden" name="mode" value="all" />
              </ActionForm>
            </section>

            <h2>Or book back line by line</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              The first box is pre-filled with everything still out. If something is missing or damaged, lower that number and enter the
              missing or damaged ones. Missing and damaged items become open issues straight away.
            </p>
          </>
        )}

        {items.length > 0 && (
          <ActionForm action={checkInJob} submit="Book back what I have entered" clearOnSuccess={false}>
            <input type="hidden" name="job_id" value={id} />
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Item</th><th className="num">Went out</th><th className="num">Booked back</th><th className="num">Still out</th>
                    {canBook && <><th>Back OK</th><th>Missing</th><th>Damaged</th></>}
                  </tr>
                </thead>
                <tbody>
                  {tops.map((t) => (
                    <Fragment key={t.id}>
                      {row(t, false)}
                      {kids(t.id).map((c) => row(c, true))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            {canBook && (
              <>
                <label htmlFor="note">Note for anything missing or damaged (optional)</label>
                <input id="note" name="note" autoComplete="off" />
              </>
            )}
          </ActionForm>
        )}
      </div>
    </>
  )
}
