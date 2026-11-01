import Link from 'next/link'
import Topbar from '@/components/topbar'
import { requireSession } from '@/lib/session'

type Ev = {
  at: string
  action: string
  qty: number
  note: string | null
  line: { description: string | null; type: { name: string } | null; job: { id: string; ref: string } | null } | null
}

const LABEL: Record<string, string> = {
  prepped: 'Prepped',
  unprepped: 'Took off prep',
  returned: 'Returned OK',
  missing_on_return: 'Missing on return',
  damaged_on_return: 'Damaged on return',
  received_sub_hire: 'Received sub-hire',
}
const stamp = (s: string) =>
  new Date(s).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export default async function ActivityPage() {
  const { profile, user, supabase } = await requireSession()
  const { data } = await supabase
    .from('line_events')
    .select('at, action, qty, note, line:job_lines(description, type:equipment_types(name), job:jobs(id, ref))')
    .eq('user_id', user.id)
    .order('at', { ascending: false })
    .limit(150)
  const events = (data ?? []) as unknown as Ev[]

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
  const day = (e: Ev) => new Date(e.at).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
  const sum = (action: string, onlyToday: boolean) =>
    events.filter((e) => e.action === action && (!onlyToday || day(e) === today)).reduce((n, e) => n + e.qty, 0)

  return (
    <>
      <Topbar name={profile.full_name} role={profile.role} />
      <div className="shell">
        <h1>My activity</h1>
        <p className="lead"><Link href="/">Home</Link></p>
        <div className="stats">
          <div className="stat"><strong>{sum('prepped', true) - sum('unprepped', true)}</strong><span>Items prepped today</span></div>
          <div className="stat"><strong>{sum('returned', true)}</strong><span>Items checked in today</span></div>
          <div className="stat"><strong>{sum('received_sub_hire', true)}</strong><span>Sub-hire received today</span></div>
        </div>
        <div className="card table-wrap">
          <table>
            <thead><tr><th>When</th><th>What</th><th className="num">Qty</th><th>Item</th><th>Job</th><th>Note</th></tr></thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={i}>
                  <td className="muted">{stamp(e.at)}</td>
                  <td>{LABEL[e.action] ?? e.action}</td>
                  <td className="num">{e.qty}</td>
                  <td>{e.line?.type?.name ?? e.line?.description ?? '-'}</td>
                  <td>{e.line?.job ? <Link href={`/jobs/${e.line.job.id}`}>{e.line.job.ref}</Link> : '-'}</td>
                  <td className="muted">{e.note ?? ''}</td>
                </tr>
              ))}
              {events.length === 0 && <tr><td colSpan={6} className="muted">Nothing recorded yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ marginTop: 12 }}>Showing your latest 150 entries.</p>
      </div>
    </>
  )
}
