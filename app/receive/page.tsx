import Link from 'next/link'
import Topbar from '@/components/topbar'
import { requireSession } from '@/lib/session'
import { fmtDate, orderStatusLabel } from '@/lib/jobs'

type Order = {
  id: string
  supplier_ref: string | null
  status: string
  expected_at: string | null
  hire_from: string | null
  hire_to: string | null
  supplier: { name: string } | null
  job: { ref: string; name: string } | null
}

export default async function ReceiveList() {
  const { profile, supabase } = await requireSession()
  const { data } = await supabase
    .from('sub_hire_orders')
    .select('id, supplier_ref, status, expected_at, hire_from, hire_to, supplier:organisations(name), job:jobs!inner(ref, name, status, archived_at)')
    .is('archived_at', null)
    .in('status', ['requested', 'confirmed', 'received'])
    .order('expected_at', { ascending: true, nullsFirst: false })
    .limit(200)
  const orders = (data ?? []) as unknown as Order[]
  const waiting = orders.filter((o) => o.status !== 'received')
  const inHouse = orders.filter((o) => o.status === 'received')

  const table = (rows: Order[], empty: string) => (
    <div className="card table-wrap">
      <table>
        <thead><tr><th>Expected</th><th>Supplier</th><th>Job</th><th>Hire</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id}>
              <td>{fmtDate(o.expected_at)}</td>
              <td>{o.supplier?.name ?? '-'}{o.supplier_ref ? <span className="muted"> · {o.supplier_ref}</span> : null}</td>
              <td>{o.job ? <><strong>{o.job.ref}</strong> {o.job.name}</> : '-'}</td>
              <td className="muted">{o.hire_from || o.hire_to ? `${fmtDate(o.hire_from)} to ${fmtDate(o.hire_to)}` : '-'}</td>
              <td><span className="badge">{orderStatusLabel(o.status)}</span></td>
              <td><Link className="btn small" href={`/receive/${o.id}`}>Open</Link></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={6} className="muted">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  )

  return (
    <>
      <Topbar name={profile.full_name} role={profile.role} />
      <div className="shell">
        <h1>Sub-hire receipt</h1>
        <p className="lead"><Link href="/">Home</Link> · <Link href="/warehouse">Today and this week</Link></p>
        <h2>Waiting to arrive</h2>
        {table(waiting, 'No sub-hire orders are waiting.')}
        <h2>Here, to go back to the supplier</h2>
        {table(inHouse, 'Nothing is waiting to go back.')}
      </div>
    </>
  )
}
