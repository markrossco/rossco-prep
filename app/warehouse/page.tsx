import Link from 'next/link'
import Topbar from '@/components/topbar'
import { requireSession } from '@/lib/session'
import { fmtDate, statusLabel } from '@/lib/jobs'

type Row = {
  id: string
  ref: string
  name: string
  status: string
  out_date: string
  return_date: string
  client_name: string | null
  lines_total: number
  lines_prepped: number
  sub_hire_open: number
}

const dayString = (offset: number) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
}

export default async function WarehousePage() {
  const { profile, supabase } = await requireSession()
  const today = dayString(0)
  const weekAhead = dayString(7)

  const [{ data: going }, { data: out }] = await Promise.all([
    supabase
      .from('job_list')
      .select('id, ref, name, status, out_date, return_date, client_name, lines_total, lines_prepped, sub_hire_open')
      .is('archived_at', null)
      .in('status', ['confirmed', 'prepping', 'prepped'])
      .lte('out_date', weekAhead)
      .order('out_date')
      .order('ref')
      .returns<Row[]>(),
    supabase
      .from('job_list')
      .select('id, ref, name, status, out_date, return_date, client_name, lines_total, lines_prepped, sub_hire_open')
      .is('archived_at', null)
      .eq('status', 'out')
      .order('return_date')
      .order('ref')
      .returns<Row[]>(),
  ])

  return (
    <>
      <Topbar name={profile.full_name} role={profile.role} />
      <div className="shell">
        <h1>Today and this week</h1>
        <p className="lead">
          <Link href="/">Home</Link> · <Link href="/receive">Sub-hire receipt</Link> · <Link href="/report">Report lost or damaged</Link>
        </p>

        <h2>To prep and send out (next 7 days)</h2>
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>Out</th><th>Job</th><th>Client</th><th>Status</th><th className="num">Prepped</th><th></th></tr>
            </thead>
            <tbody>
              {(going ?? []).map((j) => (
                <tr key={j.id}>
                  <td>{fmtDate(j.out_date)}{j.out_date < today && <span className="badge warn">overdue</span>}{j.out_date === today && <span className="badge good">today</span>}</td>
                  <td><strong>{j.ref}</strong> {j.name}</td>
                  <td className="muted">{j.client_name ?? '-'}</td>
                  <td>
                    <span className="badge">{statusLabel(j.status)}</span>
                    {j.sub_hire_open > 0 && <span className="badge warn" title="A sub-hire order has not arrived yet"> sub-hire due</span>}
                  </td>
                  <td className="num">{j.lines_total > 0 ? `${j.lines_prepped} / ${j.lines_total}` : '-'}</td>
                  <td><Link className="btn small" href={`/prep/${j.id}`}>Prep</Link></td>
                </tr>
              ))}
              {(going ?? []).length === 0 && <tr><td colSpan={6} className="muted">Nothing waiting to go out in the next week.</td></tr>}
            </tbody>
          </table>
        </div>

        <h2>Out now, coming back</h2>
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>Back</th><th>Job</th><th>Client</th><th></th></tr>
            </thead>
            <tbody>
              {(out ?? []).map((j) => (
                <tr key={j.id}>
                  <td>{fmtDate(j.return_date)}{j.return_date < today && <span className="badge warn">late</span>}{j.return_date === today && <span className="badge good">today</span>}</td>
                  <td><strong>{j.ref}</strong> {j.name}</td>
                  <td className="muted">{j.client_name ?? '-'}</td>
                  <td><Link className="btn small" href={`/checkin/${j.id}`}>Check in</Link></td>
                </tr>
              ))}
              {(out ?? []).length === 0 && <tr><td colSpan={4} className="muted">No jobs are out.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
