import Link from 'next/link'
import Topbar from '@/components/topbar'
import { requireSession } from '@/lib/session'
import { isOffice } from '@/lib/roles'
import { FINISHED, fmtDate, statusLabel, STATUSES } from '@/lib/jobs'

type Row = {
  id: string
  ref: string
  name: string
  status: string
  out_date: string
  return_date: string
  client_name: string | null
  venue_name: string | null
  lines_total: number
  lines_prepped: number
  sub_hire_open: number
}

const LIMIT = 300

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { profile, supabase } = await requireSession()
  const sp = await searchParams
  const q = (sp.q ?? '').trim().replace(/[,()]/g, ' ')
  const show = sp.show ?? 'live'
  const status = sp.status ?? ''

  let query = supabase.from('job_list').select('*', { count: 'exact' }).is('archived_at', null)
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`
    query = query.or(`ref.ilike.${like},name.ilike.${like},client_name.ilike.${like},venue_name.ilike.${like}`)
  }
  if (STATUSES.some((s) => s.value === status)) query = query.eq('status', status)
  else if (show === 'live') query = query.not('status', 'in', `(${FINISHED.join(',')})`)
  else if (show === 'finished') query = query.in('status', FINISHED)

  const { data, count } = await query
    .order('out_date', { ascending: show === 'live' })
    .order('ref')
    .limit(LIMIT)
    .returns<Row[]>()
  const rows = data ?? []

  return (
    <>
      <Topbar name={profile.full_name} role={profile.role} />
      <div className="shell">
        <h1>Jobs</h1>
        <p className="lead">
          List view · <Link href="/calendar">Calendar view</Link>
          {isOffice(profile.role) && (
            <>
              {' '}· <Link href="/jobs/new">New job</Link>
            </>
          )}
        </p>

        <form method="get" className="card filters">
          <div>
            <label htmlFor="q">Search</label>
            <input id="q" name="q" defaultValue={q} placeholder="Reference, name, client or venue" />
          </div>
          <div>
            <label htmlFor="show">Show</label>
            <select id="show" name="show" defaultValue={show}>
              <option value="live">Live jobs, soonest first</option>
              <option value="finished">Returned, closed and cancelled</option>
              <option value="all">Everything, latest first</option>
            </select>
          </div>
          <div>
            <label htmlFor="status">Status</label>
            <select id="status" name="status" defaultValue={status}>
              <option value="">Any</option>
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
          <div>
            <button type="submit">Search</button>
          </div>
        </form>

        <p className="lead" style={{ marginTop: 16 }}>
          {count ?? rows.length} {count === 1 ? 'job' : 'jobs'}
          {rows.length < (count ?? 0) ? `, showing the first ${LIMIT}.` : ''}
        </p>

        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ref</th>
                <th>Job</th>
                <th>Client</th>
                <th>Venue</th>
                <th>Out</th>
                <th>Back</th>
                <th>Status</th>
                <th className="num">Prepped</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/jobs/${r.id}`}>{r.ref}</Link></td>
                  <td>{r.name}</td>
                  <td className="muted">{r.client_name ?? '-'}</td>
                  <td className="muted">{r.venue_name ?? '-'}</td>
                  <td>{fmtDate(r.out_date)}</td>
                  <td>{fmtDate(r.return_date)}</td>
                  <td>
                    <span className="badge">{statusLabel(r.status)}</span>
                    {r.sub_hire_open > 0 && <span className="badge warn" title="Sub-hire orders not yet received"> sub-hire</span>}
                  </td>
                  <td className="num">{r.lines_total > 0 ? `${r.lines_prepped} / ${r.lines_total}` : '-'}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={8} className="muted">No jobs match.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
