import Link from 'next/link'
import { notFound } from 'next/navigation'
import Topbar from '@/components/topbar'
import ActionForm from '@/components/action-form'
import { requireSession } from '@/lib/session'
import { isUuid } from '@/lib/db'
import { isOffice } from '@/lib/roles'
import { addAsset, adjustStock, setArchived, setAssetStatus, updateItem } from '../actions'
import { reportIssue, resolveIssue } from '@/app/issues/actions'
import ItemFields from '../item-fields'

type Reg = {
  id: string
  name: string
  kind: string
  active: boolean
  archived_at: string | null
  owned_qty: number
  open_issue_qty: number
  booked_today: number | null
  free_today: number | null
  assets_listed: number
  asset_count_differs: boolean
}
type Full = {
  id: string
  name: string
  kind: string
  category_id: string | null
  tags: string[]
  can_sub_hire: boolean
  active: boolean
  accessory_only: boolean
  barcode: string | null
  description: string | null
  weight_kg: number | null
  notes: string | null
  currentrms_id: number | null
}
type Asset = { id: string; asset_no: string; serial_no: string | null; status: string; archived_at: string | null }
type Issue = {
  id: string
  asset_no: string | null
  qty: number
  issue: string
  status: string
  resolution: string | null
  note: string | null
  reported_by_name: string | null
  reported_at: string
  days_open: number
}
type Adj = { id: string; delta: number; reason: string; note: string | null; at: string; user_id: string | null }

const when = (s: string) => new Date(s).toLocaleDateString('en-GB', { timeZone: 'Europe/London' })
const ISSUE_LABEL: Record<string, string> = { damaged: 'Damaged', missing: 'Missing', in_repair: 'In repair' }
const STATUS_LABEL: Record<string, string> = {
  in_service: 'In service', damaged: 'Damaged', missing: 'Missing', in_repair: 'In repair', retired: 'Retired',
}

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()
  const { profile, supabase } = await requireSession()
  const role = profile.role

  const [{ data: reg }, { data: full }] = await Promise.all([
    supabase.from('equipment_register').select('*').eq('id', id).maybeSingle<Reg>(),
    supabase.from('equipment_types').select('*').eq('id', id).maybeSingle<Full>(),
  ])
  if (!reg || !full) notFound()

  const [{ data: assets }, { data: issues }, { data: adjs }, { data: people }, { data: cats }, { data: contents }] =
    await Promise.all([
      supabase.from('asset_register').select('id, asset_no, serial_no, status, archived_at').eq('type_id', id).is('archived_at', null).order('asset_no').returns<Asset[]>(),
      supabase.from('issue_list').select('*').eq('type_id', id).order('reported_at', { ascending: false }).limit(30).returns<Issue[]>(),
      supabase.from('stock_adjustments').select('id, delta, reason, note, at, user_id').eq('type_id', id).order('at', { ascending: false }).limit(10).returns<Adj[]>(),
      supabase.from('profiles').select('id, full_name'),
      supabase.from('categories').select('id, name, sort, department:departments(name, sort)').is('archived_at', null).order('sort'),
      supabase
        .from('type_accessories')
        .select('id, inclusion, qty_per_parent, child:equipment_types!child_type_id(id, name)')
        .eq('parent_type_id', id)
        .is('archived_at', null)
        .order('sort'),
    ])
  const who = new Map((people ?? []).map((p) => [p.id, p.full_name]))
  const categories = ((cats ?? []) as unknown as { id: string; name: string; department: { name: string; sort: number } | null }[])
    .sort((a, b) => (a.department?.sort ?? 99) - (b.department?.sort ?? 99))
    .map((c) => ({ id: c.id, label: `${c.department?.name ?? ''} / ${c.name}` }))
  const kids = (contents ?? []) as unknown as { id: string; inclusion: string; qty_per_parent: number; child: { id: string; name: string } }[]

  const canEdit = isOffice(role)
  const canAsset = canEdit || role === 'warehouse_lead'
  const canResolve = role === 'admin' || role === 'office_lead' || role === 'warehouse_lead'
  const canKits = role === 'admin' || role === 'office_lead'
  const open = (issues ?? []).filter((i) => i.status === 'open')
  const past = (issues ?? []).filter((i) => i.status !== 'open')
  const isStock = full.kind === 'stock'

  return (
    <>
      <Topbar name={profile.full_name} role={role} />
      <div className="shell">
        <h1>
          {full.name}{' '}
          {full.kind !== 'stock' && <span className="badge">{full.kind === 'kit' ? 'kit' : 'consumable'}</span>}{' '}
          {!full.active && <span className="badge">off</span>}{' '}
          {reg.archived_at && <span className="badge">archived</span>}
        </h1>
        <p className="lead"><Link href="/equipment">Equipment register</Link></p>

        {isStock ? (
          <div className="stats">
            <div className="stat"><strong>{reg.owned_qty}</strong><span>Owned</span></div>
            <div className="stat"><strong className={reg.open_issue_qty ? 'neg' : undefined}>{reg.open_issue_qty}</strong><span>In issue</span></div>
            <div className="stat"><strong>{reg.booked_today ?? 0}</strong><span>Booked today</span></div>
            <div className="stat"><strong className={(reg.free_today ?? 0) < 0 ? 'neg' : undefined}>{reg.free_today ?? 0}</strong><span>Free today</span></div>
          </div>
        ) : (
          <p className="lead">
            {full.kind === 'kit'
              ? 'A kit title holds no stock. Its contents are counted as their own items.'
              : 'A consumable is never short, so it has no counts.'}
          </p>
        )}

        <div className="stack">
          {full.kind !== 'consumable' && (
            <section className="card">
              <h2 style={{ marginTop: 0 }}>Contents</h2>
              {kids.length === 0 ? (
                <p className="muted">Nothing listed.</p>
              ) : (
                <ul>
                  {kids.map((k) => (
                    <li key={k.id}>
                      {k.qty_per_parent} × <Link href={`/equipment/${k.child.id}`}>{k.child.name}</Link>{' '}
                      <span className="badge">{k.inclusion}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p><Link href={`/kits/${id}`}>{canKits ? 'Edit contents' : 'View contents'}</Link></p>
            </section>
          )}

          {isStock && (
            <section className="card">
              <h2 style={{ marginTop: 0 }}>Issues</h2>
              {open.length === 0 && <p className="muted">No open issues.</p>}
              {open.map((i) => (
                <div key={i.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                  <strong>{i.qty} × {ISSUE_LABEL[i.issue] ?? i.issue}</strong>
                  {i.asset_no && <> · asset {i.asset_no}</>} · reported {when(i.reported_at)} by {i.reported_by_name ?? 'unknown'} ({i.days_open} days)
                  {i.note && <div className="muted">{i.note}</div>}
                  {canResolve && (
                    <ActionForm action={resolveIssue} submit="Resolve" small inline>
                      <input type="hidden" name="id" value={i.id} />
                      <select name="resolution" defaultValue="repaired" aria-label="How it was resolved">
                        <option value="repaired">Repaired</option>
                        <option value="found">Found</option>
                        <option value="replaced">Replaced</option>
                        <option value="written_off">Written off (reduces owned)</option>
                      </select>
                    </ActionForm>
                  )}
                </div>
              ))}
              <h3>Report an issue</h3>
              <ActionForm action={reportIssue} submit="Report" clearOnSuccess>
                <input type="hidden" name="type_id" value={id} />
                <div className="row">
                  <div>
                    <label htmlFor="issue">What happened</label>
                    <select id="issue" name="issue" defaultValue="damaged">
                      <option value="damaged">Damaged</option>
                      <option value="missing">Missing</option>
                      <option value="in_repair">In repair</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="qty">How many</label>
                    <input id="qty" name="qty" inputMode="numeric" defaultValue="1" />
                  </div>
                  <div>
                    <label htmlFor="asset_no">Asset number (if it has one)</label>
                    <input id="asset_no" name="asset_no" />
                  </div>
                </div>
                <label htmlFor="note">Note</label>
                <input id="note" name="note" />
              </ActionForm>
              {past.length > 0 && (
                <>
                  <h3>Past issues</h3>
                  <ul className="muted">
                    {past.map((i) => (
                      <li key={i.id}>
                        {i.qty} × {ISSUE_LABEL[i.issue] ?? i.issue}{i.asset_no ? ` (asset ${i.asset_no})` : ''}, reported {when(i.reported_at)}, {i.resolution?.replace('_', ' ')}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}

          {isStock && (
            <section className="card">
              <h2 style={{ marginTop: 0 }}>Asset numbers</h2>
              {reg.asset_count_differs && (
                <p className="error">
                  {reg.assets_listed} asset numbers are listed but {reg.owned_qty} are owned. Check which is right.
                </p>
              )}
              {(assets ?? []).length === 0 ? (
                <p className="muted">No asset numbers. Bulk items are counted by quantity only.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Asset no.</th><th>Serial</th><th>Status</th><th></th></tr></thead>
                    <tbody>
                      {(assets ?? []).map((a) => (
                        <tr key={a.id}>
                          <td>{a.asset_no}</td>
                          <td className="muted">{a.serial_no ?? '-'}</td>
                          <td>{STATUS_LABEL[a.status] ?? a.status}</td>
                          <td>
                            {canAsset && (a.status === 'in_service' || a.status === 'retired') && (
                              <ActionForm action={setAssetStatus} submit={a.status === 'retired' ? 'Back in service' : 'Retire'} small secondary inline>
                                <input type="hidden" name="id" value={a.id} />
                                <input type="hidden" name="type_id" value={id} />
                                <input type="hidden" name="status" value={a.status === 'retired' ? 'in_service' : 'retired'} />
                              </ActionForm>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {canAsset && (
                <>
                  <h3>Add an asset number</h3>
                  <ActionForm action={addAsset} submit="Add asset" clearOnSuccess>
                    <input type="hidden" name="type_id" value={id} />
                    <div className="row">
                      <div>
                        <label htmlFor="asset_no_new">Asset number</label>
                        <input id="asset_no_new" name="asset_no" required />
                      </div>
                      <div>
                        <label htmlFor="serial_no">Serial number</label>
                        <input id="serial_no" name="serial_no" />
                      </div>
                    </div>
                  </ActionForm>
                </>
              )}
            </section>
          )}

          {isStock && (
            <section className="card">
              <h2 style={{ marginTop: 0 }}>Quantity owned</h2>
              {role === 'admin' || role === 'office_lead' || role === 'warehouse_lead' ? (
                <ActionForm action={adjustStock} submit="Update quantity" clearOnSuccess>
                  <input type="hidden" name="id" value={id} />
                  <div className="row">
                    <div>
                      <label htmlFor="delta">Change by (use - to remove)</label>
                      <input id="delta" name="delta" inputMode="numeric" placeholder="2 or -1" />
                    </div>
                    <div>
                      <label htmlFor="reason">Reason</label>
                      <select id="reason" name="reason" defaultValue="purchase">
                        <option value="purchase">Bought</option>
                        <option value="correction">Correction after a count</option>
                        <option value="disposal">Sold or disposed of</option>
                        <option value="write-off">Written off</option>
                      </select>
                    </div>
                  </div>
                  <label htmlFor="adj_note">Note {role === 'admin' ? '(optional)' : '(required)'}</label>
                  <input id="adj_note" name="note" />
                </ActionForm>
              ) : (
                <p className="muted">A lead or admin changes the quantity owned.</p>
              )}
              {(adjs ?? []).length > 0 && (
                <>
                  <h3>Recent changes</h3>
                  <ul className="muted">
                    {(adjs ?? []).map((a) => (
                      <li key={a.id}>
                        {when(a.at)}: {a.delta > 0 ? '+' : ''}{a.delta} ({a.reason}){a.note ? `, ${a.note}` : ''}{a.user_id ? ` · ${who.get(a.user_id) ?? ''}` : ''}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}

          {canEdit && (
            <section className="card">
              <h2 style={{ marginTop: 0 }}>Edit item</h2>
              <ActionForm action={updateItem} submit="Save changes">
                <input type="hidden" name="id" value={id} />
                <ItemFields v={full} categories={categories} editing />
              </ActionForm>
            </section>
          )}

          {role === 'admin' && (
            <section className="card">
              <h2 style={{ marginTop: 0 }}>{reg.archived_at ? 'Restore' : 'Archive'}</h2>
              <p className="muted">
                Nothing is ever deleted. Archiving hides the item from lists and new jobs and keeps its history.
              </p>
              <ActionForm action={setArchived} submit={reg.archived_at ? 'Restore this item' : 'Archive this item'} secondary>
                <input type="hidden" name="id" value={id} />
                <input type="hidden" name="archive" value={reg.archived_at ? 'no' : 'yes'} />
              </ActionForm>
            </section>
          )}
        </div>
      </div>
    </>
  )
}
