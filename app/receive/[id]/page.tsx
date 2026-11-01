import Link from 'next/link'
import { notFound } from 'next/navigation'
import Topbar from '@/components/topbar'
import ActionForm from '@/components/action-form'
import { requireSession } from '@/lib/session'
import { isUuid } from '@/lib/db'
import { fmtDate, orderStatusLabel } from '@/lib/jobs'
import { receiveLine, receiveOrder, returnOrder } from '../../warehouse/actions'

type Order = {
  id: string
  job_id: string
  supplier_ref: string | null
  status: string
  expected_at: string | null
  hire_from: string | null
  hire_to: string | null
  notes: string | null
  supplier: { name: string } | null
  job: { ref: string; name: string } | null
}
type Line = { id: string; description: string | null; qty_required: number; type: { name: string } | null }

export default async function ReceiveOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()
  const { profile, supabase } = await requireSession()

  const { data } = await supabase
    .from('sub_hire_orders')
    .select('id, job_id, supplier_ref, status, expected_at, hire_from, hire_to, notes, supplier:organisations(name), job:jobs(ref, name)')
    .eq('id', id)
    .is('archived_at', null)
    .maybeSingle()
  if (!data) notFound()
  const order = data as unknown as Order

  const { data: lineData } = await supabase
    .from('job_lines')
    .select('id, description, qty_required, type:equipment_types(name)')
    .eq('sub_hire_id', id)
    .is('archived_at', null)
    .order('added_at')
  const lines = (lineData ?? []) as unknown as Line[]
  const { data: progData } = lines.length
    ? await supabase.from('line_progress').select('line_id, received_qty').in('line_id', lines.map((l) => l.id))
    : { data: [] }
  const got = new Map((progData ?? []).map((p: { line_id: string; received_qty: number }) => [p.line_id, p.received_qty]))
  const waiting = order.status === 'requested' || order.status === 'confirmed'

  return (
    <>
      <Topbar name={profile.full_name} role={profile.role} />
      <div className="shell">
        <h1>{order.supplier?.name ?? 'Sub-hire order'}{order.supplier_ref ? ` · ${order.supplier_ref}` : ''}</h1>
        <p className="lead">
          <Link href="/">Home</Link> · <Link href="/receive">Sub-hire receipt</Link> · <Link href={`/jobs/${order.job_id}`}>Job {order.job?.ref}</Link>
        </p>
        <div className="stats">
          <div className="stat"><strong>{orderStatusLabel(order.status)}</strong><span>Status</span></div>
          <div className="stat"><strong>{fmtDate(order.expected_at)}</strong><span>Expected</span></div>
          <div className="stat"><strong style={{ fontSize: 16 }}>{order.hire_from || order.hire_to ? `${fmtDate(order.hire_from)} to ${fmtDate(order.hire_to)}` : '-'}</strong><span>Hire period</span></div>
          <div className="stat"><strong style={{ fontSize: 16 }}>{order.job ? `${order.job.ref} ${order.job.name}` : '-'}</strong><span>Job</span></div>
        </div>
        {order.notes && <p className="card" style={{ whiteSpace: 'pre-wrap' }}>{order.notes}</p>}

        {waiting && (
          <section className="card" style={{ maxWidth: 640, marginBottom: 20 }}>
            <h2 style={{ marginTop: 0 }}>Everything arrived</h2>
            <ActionForm action={receiveOrder} submit="Receive the whole order" small>
              <input type="hidden" name="order_id" value={id} />
              <input type="hidden" name="job_id" value={order.job_id} />
            </ActionForm>
          </section>
        )}

        <div className="card table-wrap">
          <table>
            <thead><tr><th>Item</th><th className="num">Ordered</th><th className="num">Received</th><th>Receive how many</th></tr></thead>
            <tbody>
              {lines.map((l) => {
                const r = got.get(l.id) ?? 0
                const left = l.qty_required - r
                const name = l.type?.name ?? l.description ?? ''
                return (
                  <tr key={l.id}>
                    <td>{name}</td>
                    <td className="num">{l.qty_required}</td>
                    <td className="num">{r >= l.qty_required ? <span className="badge good">{r}</span> : r}</td>
                    <td>
                      {left > 0 && (
                        <ActionForm action={receiveLine} submit="Receive" small inline>
                          <input type="hidden" name="line_id" value={l.id} />
                          <input type="hidden" name="order_id" value={id} />
                          <input type="hidden" name="job_id" value={order.job_id} />
                          <input name="qty" inputMode="numeric" defaultValue={left} aria-label={`How many ${name} arrived`} style={{ width: 70 }} />
                        </ActionForm>
                      )}
                    </td>
                  </tr>
                )
              })}
              {lines.length === 0 && <tr><td colSpan={4} className="muted">No lines on this order yet. The office adds them on the job page.</td></tr>}
            </tbody>
          </table>
        </div>

        {order.status === 'received' && (
          <section className="card" style={{ maxWidth: 640, marginTop: 20 }}>
            <h2 style={{ marginTop: 0 }}>Sending it back</h2>
            <p className="muted" style={{ marginTop: 0 }}>Once the hire has been collected by the supplier or returned to them.</p>
            <ActionForm action={returnOrder} submit="Mark returned to the supplier" small secondary>
              <input type="hidden" name="order_id" value={id} />
              <input type="hidden" name="job_id" value={order.job_id} />
            </ActionForm>
          </section>
        )}
      </div>
    </>
  )
}
