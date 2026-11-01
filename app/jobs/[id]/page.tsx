import { Fragment } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import Topbar from '@/components/topbar'
import ActionForm from '@/components/action-form'
import { requireSession } from '@/lib/session'
import { isUuid } from '@/lib/db'
import { isOffice } from '@/lib/roles'
import { FINISHED, fmtDate, ORDER_STATUSES, orderStatusLabel, STATUSES, statusLabel } from '@/lib/jobs'
import JobFields from '../job-fields'
import {
  addFreeText,
  addKitContents,
  addToJob,
  coverShortage,
  createOrder,
  removeLine,
  removeOrder,
  setStatus,
  updateJob,
  updateLineQty,
  updateOrder,
} from '../actions'

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
  type_id: string | null
  description: string | null
  qty_required: number
  source: 'own' | 'sub_hire'
  sub_hire_id: string | null
  parent_line_id: string | null
  mandatory: boolean
  added_late: boolean
  added_at: string
  type: { name: string; kind: string } | null
}
type Order = {
  id: string
  supplier_ref: string | null
  hire_from: string | null
  hire_to: string | null
  expected_at: string | null
  status: string
  notes: string | null
  supplier: { name: string } | null
}
type Accessory = {
  parent_type_id: string
  child_type_id: string
  inclusion: string
  qty_per_parent: number
  child: { name: string; kind: string; owned_qty: number; active: boolean; archived_at: string | null }
}
type Short = {
  type_id: string
  type_name: string
  required: number
  owned: number
  in_issue: number
  min_free: number
  worst_day: string
  short_by: number
}

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()
  const { profile, supabase } = await requireSession()
  const office = isOffice(profile.role)

  const { data: job } = await supabase
    .from('jobs')
    .select('id, ref, name, status, out_date, return_date, notes, client:organisations(name), venue:venues(name)')
    .eq('id', id)
    .is('archived_at', null)
    .maybeSingle<Job>()
  if (!job) notFound()
  const finished = FINISHED.includes(job.status)

  const [{ data: lineData }, { data: progress }, { data: shortData }, { data: orderData }, names] = await Promise.all([
    supabase
      .from('job_lines')
      .select('id, type_id, description, qty_required, source, sub_hire_id, parent_line_id, mandatory, added_late, added_at, type:equipment_types(name, kind)')
      .eq('job_id', id)
      .is('archived_at', null)
      .order('added_at')
      .order('id'),
    supabase.from('line_progress').select('line_id, prepped_qty, received_qty').eq('job_id', id),
    supabase.rpc('job_shortages', { p_job: id }),
    supabase
      .from('sub_hire_orders')
      .select('id, supplier_ref, hire_from, hire_to, expected_at, status, notes, supplier:organisations(name)')
      .eq('job_id', id)
      .is('archived_at', null)
      .order('created_at'),
    office
      ? Promise.all([
          supabase.from('equipment_types').select('name').eq('active', true).is('archived_at', null).order('name').limit(3000),
          supabase.from('organisations').select('name').is('archived_at', null).eq('active', true).order('name').limit(3000),
          supabase.from('venues').select('name').is('archived_at', null).eq('active', true).order('name').limit(3000),
        ])
      : Promise.resolve(null),
  ])

  const lines = (lineData ?? []) as unknown as Line[]
  const orders = (orderData ?? []) as unknown as Order[]
  const shorts = ((shortData ?? []) as Short[]).filter((s) => s.short_by > 0)
  const shortByType = new Map(shorts.map((s) => [s.type_id, s]))
  const prog = new Map((progress ?? []).map((p: { line_id: string; prepped_qty: number; received_qty: number }) => [p.line_id, p]))
  const orderName = new Map(orders.map((o) => [o.id, `${o.supplier?.name ?? 'Supplier'}${o.supplier_ref ? ` (${o.supplier_ref})` : ''}`]))
  const orderLineCount = new Map<string, number>()
  for (const l of lines) if (l.sub_hire_id) orderLineCount.set(l.sub_hire_id, (orderLineCount.get(l.sub_hire_id) ?? 0) + 1)

  // Kit titles first, then their contents, in the order they were added
  const tops = lines.filter((l) => !l.parent_line_id)
  const childrenOf = (id: string) => lines.filter((c) => c.parent_line_id === id)

  // What each kit on this job could still take: its listed contents that are not on the job yet
  const kitTypeIds = [...new Set(tops.filter((l) => l.type?.kind === 'kit' && l.type_id).map((l) => l.type_id as string))]
  const { data: accData } = kitTypeIds.length
    ? await supabase
        .from('type_accessories')
        .select('parent_type_id, child_type_id, inclusion, qty_per_parent, sort, child:equipment_types!child_type_id(name, kind, owned_qty, active, archived_at)')
        .in('parent_type_id', kitTypeIds)
        .is('archived_at', null)
        .order('sort')
        .order('created_at')
    : { data: [] }
  const accessories = (accData ?? []) as unknown as Accessory[]
  const choicesFor = (kitLine: Line) => {
    const have = new Set(childrenOf(kitLine.id).map((c) => c.type_id))
    const rank = { mandatory: 0, default: 1, optional: 2 } as Record<string, number>
    return accessories
      .filter((a) => a.parent_type_id === kitLine.type_id && !have.has(a.child_type_id) && a.child && a.child.active && !a.child.archived_at)
      .sort((a, b) => (rank[a.inclusion] ?? 3) - (rank[b.inclusion] ?? 3) || a.child.name.localeCompare(b.child.name))
  }

  const [itemNames, orgNames, venueNames] = names ?? [null, null, null]

  const renderLine = (l: Line) => {
    const isKit = l.type?.kind === 'kit'
    const child = !!l.parent_line_id
    const p = prog.get(l.id)
    const short = l.source === 'own' && l.type_id ? shortByType.get(l.type_id) : undefined
    const canEditLine = office && !finished
    const canRemove = canEditLine && !(l.mandatory && child)
    return (
      <tr key={l.id}>
        <td style={child ? { paddingLeft: 28 } : undefined}>
          {isKit ? <strong>{l.type?.name}</strong> : l.type_id ? <Link href={`/equipment/${l.type_id}`}>{l.type?.name}</Link> : <span>{l.description}</span>}{' '}
          {isKit && <span className="badge">kit</span>}
          {l.type?.kind === 'consumable' && <span className="badge">consumable</span>}
          {!l.type_id && <span className="badge">other</span>}
          {l.mandatory && child && <span className="badge" title="Always included with the kit">always included</span>}
          {l.added_late && <span className="badge warn" title="Added after prep started">late</span>}
          {short && <span className="badge warn" title={`Short by ${short.short_by} on ${fmtDate(short.worst_day)}`}>short by {short.short_by}</span>}
        </td>
        <td className="muted">
          {l.source === 'own' ? 'Own stock' : `Sub-hire${l.sub_hire_id ? `: ${orderName.get(l.sub_hire_id) ?? ''}` : ': no order yet'}`}
        </td>
        <td className="num">
          {canEditLine ? (
            <ActionForm action={updateLineQty} submit="Save" small secondary inline>
              <input type="hidden" name="id" value={l.id} />
              <input type="hidden" name="job_id" value={job.id} />
              <input name="qty" inputMode="numeric" defaultValue={l.qty_required} aria-label="Quantity required" style={{ width: 70 }} />
            </ActionForm>
          ) : (
            l.qty_required
          )}
        </td>
        <td className="num">{isKit ? '-' : `${p?.prepped_qty ?? 0} / ${l.qty_required}`}</td>
        <td>
          {canRemove && (
            <ActionForm action={removeLine} submit="Remove" small secondary inline>
              <input type="hidden" name="id" value={l.id} />
              <input type="hidden" name="job_id" value={job.id} />
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
        <h1>{job.ref} · {job.name}</h1>
        <p className="lead">
          <Link href="/">Home</Link> · <Link href="/jobs">Jobs</Link>
        </p>

        <div className="stats">
          <div className="stat"><strong>{statusLabel(job.status)}</strong><span>Status</span></div>
          <div className="stat"><strong>{fmtDate(job.out_date)}</strong><span>Out</span></div>
          <div className="stat"><strong>{fmtDate(job.return_date)}</strong><span>Back</span></div>
          <div className="stat"><strong style={{ fontSize: 16 }}>{job.client?.name ?? '-'}</strong><span>Client</span></div>
          <div className="stat"><strong style={{ fontSize: 16 }}>{job.venue?.name ?? '-'}</strong><span>Venue</span></div>
        </div>
        {job.notes && <p className="card" style={{ whiteSpace: 'pre-wrap' }}>{job.notes}</p>}

        {office && (
          <div className="card" style={{ marginTop: 12 }}>
            <ActionForm action={setStatus} submit="Change status" small inline>
              <input type="hidden" name="id" value={job.id} />
              <label htmlFor="job-status" style={{ margin: 0 }}>Status</label>
              <select id="job-status" name="status" defaultValue={job.status}>
                {STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </ActionForm>
            <details style={{ marginTop: 14 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Edit the job details</summary>
              <div style={{ marginTop: 12 }}>
                <ActionForm action={updateJob} submit="Save details">
                  <input type="hidden" name="id" value={job.id} />
                  <JobFields
                    idPrefix="edit"
                    d={{
                      ref: job.ref,
                      name: job.name,
                      client_name: job.client?.name,
                      venue_name: job.venue?.name,
                      out_date: job.out_date,
                      return_date: job.return_date,
                      notes: job.notes ?? '',
                    }}
                    clients={(orgNames?.data ?? []).map((c) => c.name)}
                    venues={(venueNames?.data ?? []).map((v) => v.name)}
                  />
                </ActionForm>
              </div>
            </details>
          </div>
        )}

        {finished && <p className="muted" style={{ marginTop: 12 }}>This job is {statusLabel(job.status).toLowerCase()}, so its list cannot be changed.</p>}

        {shorts.length > 0 && (
          <section className="card" style={{ marginTop: 20, borderColor: 'var(--danger)' }}>
            <h2 style={{ marginTop: 0 }}>Short on {shorts.length === 1 ? '1 item' : `${shorts.length} items`}</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              This is a warning, not a block. Cover it with a sub-hire, or sort it out in the clash view later.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Item</th><th className="num">Needed</th><th className="num">Owned</th><th className="num">In issue</th><th className="num">Short by</th><th>Tightest day</th>{office && !finished && <th></th>}</tr>
                </thead>
                <tbody>
                  {shorts.map((s) => (
                    <tr key={s.type_id}>
                      <td><Link href={`/equipment/${s.type_id}`}>{s.type_name}</Link></td>
                      <td className="num">{s.required}</td>
                      <td className="num">{s.owned}</td>
                      <td className="num">{s.in_issue}</td>
                      <td className="num"><span className="neg">{s.short_by}</span></td>
                      <td>{fmtDate(s.worst_day)}</td>
                      {office && !finished && (
                        <td>
                          <ActionForm action={coverShortage} submit="Move to sub-hire" small inline>
                            <input type="hidden" name="job_id" value={job.id} />
                            <input type="hidden" name="type_id" value={s.type_id} />
                            <input type="hidden" name="qty" value={Math.min(s.short_by, s.required)} />
                            <select name="order_id" aria-label="Sub-hire order">
                              <option value="">No order yet</option>
                              {orders.map((o) => (
                                <option key={o.id} value={o.id}>{orderName.get(o.id)}</option>
                              ))}
                            </select>
                          </ActionForm>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <h2>Equipment list</h2>
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>From</th>
                <th className="num">Required</th>
                <th className="num">Prepped</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tops.map((t) => {
                const choices = t.type?.kind === 'kit' && office && !finished ? choicesFor(t) : []
                const kids = childrenOf(t.id)
                return (
                  <Fragment key={t.id}>
                    {renderLine(t)}
                    {kids.map(renderLine)}
                    {choices.length > 0 && (
                      <tr>
                        <td colSpan={5} style={{ paddingLeft: 28 }}>
                          <details open={kids.length === 0}>
                            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                              Choose contents for {t.type?.name} ({choices.length} available)
                            </summary>
                            <div style={{ marginTop: 10 }}>
                              <ActionForm action={addKitContents} submit="Add the ones I have chosen" small>
                                <input type="hidden" name="job_id" value={job.id} />
                                <input type="hidden" name="line_id" value={t.id} />
                                <div className="table-wrap">
                                  <table>
                                    <thead><tr><th>Item</th><th></th><th className="num">Owned</th><th className="num">Quantity</th></tr></thead>
                                    <tbody>
                                      {choices.map((a) => (
                                        <tr key={a.child_type_id}>
                                          <td>{a.child.name}</td>
                                          <td className="muted">
                                            {a.inclusion === 'optional' ? 'Optional' : 'Normally included'}
                                          </td>
                                          <td className="num">{a.child.kind === 'stock' ? a.child.owned_qty : '-'}</td>
                                          <td className="num">
                                            <input
                                              name={`qty_${a.child_type_id}`}
                                              inputMode="numeric"
                                              placeholder="0"
                                              aria-label={`Quantity of ${a.child.name}`}
                                              style={{ width: 70 }}
                                            />
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </ActionForm>
                            </div>
                          </details>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
              {tops.length === 0 && <tr><td colSpan={5} className="muted">Nothing on the list yet.</td></tr>}
            </tbody>
          </table>
        </div>

        {office && !finished && (
          <div className="stack" style={{ marginTop: 20 }}>
            <section className="card" style={{ maxWidth: 760 }}>
              <h2 style={{ marginTop: 0 }}>Add to the list</h2>
              <p className="muted" style={{ marginTop: 0 }}>
                A kit brings its included contents with it. If there is not enough free, it still goes on and shows as a warning.
              </p>
              <ActionForm action={addToJob} submit="Add" clearOnSuccess>
                <input type="hidden" name="job_id" value={job.id} />
                <label htmlFor="item_name">Item</label>
                <input id="item_name" name="item_name" list="job-item-names" autoComplete="off" placeholder="Start typing the name" />
                <datalist id="job-item-names">
                  {(itemNames?.data ?? []).map((n) => (
                    <option key={n.name} value={n.name} />
                  ))}
                </datalist>
                <div className="row">
                  <div>
                    <label htmlFor="qty">Quantity</label>
                    <input id="qty" name="qty" inputMode="numeric" defaultValue="1" />
                  </div>
                  <div>
                    <label htmlFor="source">From</label>
                    <select id="source" name="source" defaultValue="own">
                      <option value="own">Our own stock</option>
                      <option value="sub_hire">Sub-hire</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="order_id">Sub-hire order (if sub-hire)</label>
                    <select id="order_id" name="order_id" defaultValue="">
                      <option value="">No order yet</option>
                      {orders.map((o) => (
                        <option key={o.id} value={o.id}>{orderName.get(o.id)}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </ActionForm>
            </section>

            <section className="card" style={{ maxWidth: 760 }}>
              <h2 style={{ marginTop: 0 }}>Add something not in the register</h2>
              <ActionForm action={addFreeText} submit="Add" clearOnSuccess>
                <input type="hidden" name="job_id" value={job.id} />
                <div className="row">
                  <div>
                    <label htmlFor="description">Description</label>
                    <input id="description" name="description" autoComplete="off" />
                  </div>
                  <div>
                    <label htmlFor="free_qty">Quantity</label>
                    <input id="free_qty" name="qty" inputMode="numeric" defaultValue="1" />
                  </div>
                </div>
              </ActionForm>
            </section>
          </div>
        )}

        <h2>Sub-hire orders</h2>
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>Supplier</th><th>Hire</th><th>Expected</th><th className="num">Lines</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>{o.supplier?.name ?? '-'}{o.supplier_ref ? <span className="muted"> · {o.supplier_ref}</span> : null}</td>
                  <td>{o.hire_from || o.hire_to ? `${fmtDate(o.hire_from)} to ${fmtDate(o.hire_to)}` : '-'}</td>
                  <td>{fmtDate(o.expected_at)}</td>
                  <td className="num">{orderLineCount.get(o.id) ?? 0}</td>
                  <td>
                    {office ? (
                      <ActionForm action={updateOrder} submit="Save" small inline>
                        <input type="hidden" name="id" value={o.id} />
                        <input type="hidden" name="job_id" value={job.id} />
                        <input type="hidden" name="supplier_ref" value={o.supplier_ref ?? ''} />
                        <select name="status" defaultValue={o.status} aria-label="Order status">
                          {ORDER_STATUSES.map((s) => (
                            <option key={s.value} value={s.value}>{s.label}</option>
                          ))}
                        </select>
                      </ActionForm>
                    ) : (
                      <span className="badge">{orderStatusLabel(o.status)}</span>
                    )}
                  </td>
                  <td>
                    {office && (
                      <ActionForm action={removeOrder} submit="Remove" small secondary inline>
                        <input type="hidden" name="id" value={o.id} />
                        <input type="hidden" name="job_id" value={job.id} />
                      </ActionForm>
                    )}
                  </td>
                </tr>
              ))}
              {orders.length === 0 && <tr><td colSpan={6} className="muted">No sub-hire orders on this job.</td></tr>}
            </tbody>
          </table>
        </div>

        {office && !finished && (
          <section className="card" style={{ marginTop: 20, maxWidth: 760 }}>
            <h2 style={{ marginTop: 0 }}>Add a sub-hire order</h2>
            <ActionForm action={createOrder} submit="Add the order" clearOnSuccess>
              <input type="hidden" name="job_id" value={job.id} />
              <div className="row">
                <div>
                  <label htmlFor="supplier_name">Supplier</label>
                  <input id="supplier_name" name="supplier_name" list="job-suppliers" autoComplete="off" placeholder="Start typing the name" />
                  <label className="check" htmlFor="new_supplier">
                    <input id="new_supplier" type="checkbox" name="new_supplier" /> Add as a new supplier if not in the list
                  </label>
                </div>
                <div>
                  <label htmlFor="supplier_ref">Supplier reference</label>
                  <input id="supplier_ref" name="supplier_ref" autoComplete="off" />
                </div>
              </div>
              <datalist id="job-suppliers">
                {(orgNames?.data ?? []).map((n) => (
                  <option key={n.name} value={n.name} />
                ))}
              </datalist>
              <div className="row">
                <div>
                  <label htmlFor="hire_from">Hire from</label>
                  <input id="hire_from" type="date" name="hire_from" defaultValue={job.out_date} />
                </div>
                <div>
                  <label htmlFor="hire_to">Hire to</label>
                  <input id="hire_to" type="date" name="hire_to" defaultValue={job.return_date} />
                </div>
                <div>
                  <label htmlFor="expected_date">Expected in the warehouse</label>
                  <input id="expected_date" type="date" name="expected_date" />
                </div>
              </div>
              <label htmlFor="order_notes">Notes</label>
              <input id="order_notes" name="notes" autoComplete="off" />
            </ActionForm>
          </section>
        )}
      </div>
    </>
  )
}
