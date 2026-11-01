import Link from 'next/link'
import Topbar from '@/components/topbar'
import { requireSession } from '@/lib/session'
import { isOffice } from '@/lib/roles'

type Row = {
  id: string
  name: string
  kind: string
  active: boolean
  archived_at: string | null
  category_name: string | null
  department_name: string | null
  owned_qty: number
  open_issue_qty: number
  booked_today: number | null
  free_today: number | null
  assets_listed: number
  asset_count_differs: boolean
}
type Cat = { id: string; name: string; department_id: string }

const LIMIT = 500

export default async function EquipmentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { profile, supabase } = await requireSession()
  const sp = await searchParams
  const q = (sp.q ?? '').trim()
  const dept = sp.dept ?? ''
  const cat = sp.cat ?? ''
  const kind = sp.kind ?? ''
  const show = sp.show ?? 'active'
  const issuesOnly = sp.issues === '1'

  const [{ data: departments }, { data: categories }] = await Promise.all([
    supabase.from('departments').select('id, name').is('archived_at', null).order('sort'),
    supabase.from('categories').select('id, name, department_id').is('archived_at', null).order('sort'),
  ])

  let query = supabase.from('equipment_register').select('*', { count: 'exact' })
  for (const word of q.split(/\s+/).filter(Boolean)) {
    query = query.ilike('name', `%${word.replace(/[%_\\]/g, (m) => `\\${m}`)}%`)
  }
  if (/^[0-9a-f-]{36}$/i.test(cat)) query = query.eq('category_id', cat)
  else if (/^[0-9a-f-]{36}$/i.test(dept)) query = query.eq('department_id', dept)
  if (['stock', 'consumable', 'kit'].includes(kind)) query = query.eq('kind', kind)
  if (show === 'active') query = query.is('archived_at', null).eq('active', true)
  else if (show === 'inactive') query = query.is('archived_at', null).eq('active', false)
  else if (show === 'archived') query = query.not('archived_at', 'is', null)
  if (issuesOnly) query = query.gt('open_issue_qty', 0)
  const { data, count } = await query
    .order('department_sort', { ascending: true, nullsFirst: false })
    .order('category_sort', { ascending: true, nullsFirst: false })
    .order('name')
    .limit(LIMIT)
    .returns<Row[]>()
  const rows = data ?? []

  const catsShown = (categories as Cat[] | null)?.filter((c) => !dept || c.department_id === dept) ?? []

  return (
    <>
      <Topbar name={profile.full_name} role={profile.role} />
      <div className="shell">
        <h1>Equipment register</h1>
        <p className="lead">
          <Link href="/">Home</Link> · <Link href="/issues">Issues</Link>
          {isOffice(profile.role) && (
            <>
              {' '}· <Link href="/equipment/new">Add an item</Link>
            </>
          )}
        </p>

        <form method="get" className="card filters">
          <div>
            <label htmlFor="q">Search</label>
            <input id="q" name="q" defaultValue={q} placeholder="Part of a name" />
          </div>
          <div>
            <label htmlFor="dept">Department</label>
            <select id="dept" name="dept" defaultValue={dept}>
              <option value="">All</option>
              {(departments ?? []).map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="cat">Category</label>
            <select id="cat" name="cat" defaultValue={cat}>
              <option value="">All</option>
              {catsShown.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="kind">Kind</label>
            <select id="kind" name="kind" defaultValue={kind}>
              <option value="">All</option>
              <option value="stock">Stock</option>
              <option value="kit">Kits and packages</option>
              <option value="consumable">Consumables</option>
            </select>
          </div>
          <div>
            <label htmlFor="show">Show</label>
            <select id="show" name="show" defaultValue={show}>
              <option value="active">Active</option>
              <option value="inactive">Switched off</option>
              <option value="archived">Archived</option>
              <option value="all">Everything</option>
            </select>
          </div>
          <div>
            <label className="check" htmlFor="issues">
              <input id="issues" type="checkbox" name="issues" value="1" defaultChecked={issuesOnly} />
              With open issues
            </label>
          </div>
          <div>
            <button type="submit">Search</button>
          </div>
        </form>

        <p className="lead" style={{ marginTop: 16 }}>
          {count ?? rows.length} {count === 1 ? 'item' : 'items'}
          {rows.length < (count ?? 0) ? `, showing the first ${LIMIT}. Narrow the search to see the rest.` : ''}
        </p>

        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Category</th>
                <th className="num">Owned</th>
                <th className="num">In issue</th>
                <th className="num">Booked today</th>
                <th className="num">Free today</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/equipment/${r.id}`}>{r.name}</Link>{' '}
                    {r.kind === 'kit' && <span className="badge">kit</span>}
                    {r.kind === 'consumable' && <span className="badge">consumable</span>}
                    {!r.active && <span className="badge">off</span>}
                    {r.archived_at && <span className="badge">archived</span>}
                    {r.asset_count_differs && <span className="badge warn" title="Asset numbers listed do not match the owned quantity">check assets</span>}
                  </td>
                  <td className="muted">{[r.department_name, r.category_name].filter(Boolean).join(' / ') || '-'}</td>
                  <td className="num">{r.kind === 'stock' ? r.owned_qty : '-'}</td>
                  <td className="num">{r.open_issue_qty > 0 ? <span className="neg">{r.open_issue_qty}</span> : r.kind === 'stock' ? 0 : '-'}</td>
                  <td className="num">{r.booked_today ?? '-'}</td>
                  <td className="num">
                    {r.free_today === null ? '-' : r.free_today < 0 ? <span className="neg">{r.free_today}</span> : r.free_today}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={6} className="muted">Nothing matches. The register may not be loaded yet, or the search is too narrow.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
