import Link from 'next/link'
import Topbar from '@/components/topbar'
import { requireSession } from '@/lib/session'
import { fmtDate } from '@/lib/jobs'

type Row = { id: string; ref: string; name: string; return_date: string; client_name: string | null }

export default async function CheckinList() {
  const { profile, supabase } = await requireSession()
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
  const { data } = await supabase
    .from('job_list')
    .select('id, ref, name, return_date, client_name')
    .is('archived_at', null)
    .eq('status', 'out')
    .order('return_date')
    .order('ref')
    .returns<Row[]>()

  return (
    <>
      <Topbar name={profile.full_name} role={profile.role} />
      <div className="shell">
        <h1>Return check-in</h1>
        <p className="lead"><Link href="/">Home</Link> · <Link href="/warehouse">Today and this week</Link></p>
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Back</th><th>Job</th><th>Client</th><th></th></tr></thead>
            <tbody>
              {(data ?? []).map((j) => (
                <tr key={j.id}>
                  <td>{fmtDate(j.return_date)}{j.return_date < today && <span className="badge warn">late</span>}{j.return_date === today && <span className="badge good">today</span>}</td>
                  <td><strong>{j.ref}</strong> {j.name}</td>
                  <td className="muted">{j.client_name ?? '-'}</td>
                  <td><Link className="btn small" href={`/checkin/${j.id}`}>Check in</Link></td>
                </tr>
              ))}
              {(data ?? []).length === 0 && <tr><td colSpan={4} className="muted">No jobs are out, so there is nothing to check in.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
