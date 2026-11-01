import Link from 'next/link'
import Topbar from '@/components/topbar'
import { requireSession } from '@/lib/session'
import { isOffice } from '@/lib/roles'
import { isUuid } from '@/lib/db'
import { FINISHED, fmtDate, isDay, statusLabel } from '@/lib/jobs'
import MoveBoard, { type Card, type Target } from './move-board'

type GridRow = {
  type_id: string
  name: string
  category_name: string | null
  department_name: string | null
  owned: number
  in_issue: number
  alloc: number[]
  min_free: number
  total_count: number
}

type LineRow = {
  id: string
  qty_required: number
  mandatory: boolean
  parent_line_id: string | null
  job: { id: string; ref: string; name: string; status: string; out_date: string; return_date: string }
}

const PAGE = 50
const DAY_CHOICES = [7, 14, 21, 28]
const MODES = [
  { value: 'booked', label: 'Items that are booked' },
  { value: 'short', label: 'Items that go short' },
  { value: 'all', label: 'Every item' },
]

const todayLondon = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })

function addDays(d: string, n: number) {
  const t = new Date(`${d}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() + n)
  return t.toISOString().slice(0, 10)
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export default async function ClashPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { profile, supabase } = await requireSession()
  const sp = await searchParams
  const canEdit = isOffice(profile.role)

  const from = sp.from && isDay(sp.from) ? sp.from : todayLondon()
  const daysN = DAY_CHOICES.includes(Number(sp.days)) ? Number(sp.days) : 14
  const to = addDays(from, daysN - 1)
  const mode = MODES.some((m) => m.value === sp.mode) ? (sp.mode as string) : 'booked'
  const prov = sp.prov !== '0'
  const dept = sp.dept && isUuid(sp.dept) ? sp.dept : ''
  const cat = sp.cat && isUuid(sp.cat) ? sp.cat : ''
  const q = (sp.q ?? '').trim()
  const page = Math.max(1, Math.trunc(Number(sp.page)) || 1)
  const item = sp.item && isUuid(sp.item) ? sp.item : ''
  const pickedDay = sp.day && isDay(sp.day) ? sp.day : ''

  const days = Array.from({ length: daysN }, (_, i) => addDays(from, i))

  /** Links keep every filter and change only what is named. */
  function href(over: Record<string, string | null>, hash = '') {
    const p = new URLSearchParams()
    const base: Record<string, string> = {
      from: sp.from && isDay(sp.from) ? sp.from : '',
      days: String(daysN),
      mode,
      prov: prov ? '1' : '0',
      dept,
      cat,
      q,
      page: String(page),
      item,
      day: pickedDay,
    }
    for (const [k, v] of Object.entries({ ...base, ...over })) if (v) p.set(k, v)
    return `/clash?${p.toString()}${hash}`
  }

  const [{ data: depts }, { data: cats }, grid] = await Promise.all([
    supabase.from('departments').select('id, name').is('archived_at', null).order('sort').order('name'),
    supabase.from('categories').select('id, name, department_id').is('archived_at', null).order('sort').order('name'),
    supabase
      .rpc('clash_grid', {
        p_from: from,
        p_to: to,
        p_include_provisional: prov,
        p_category: cat || null,
        p_department: dept || null,
        p_search: q || null,
        p_mode: mode,
        p_limit: PAGE,
        p_offset: (page - 1) * PAGE,
      }),
  ])
  const rows = (grid.data ?? []) as unknown as GridRow[]
  const total = rows.length ? Number(rows[0].total_count) : 0
  const pages = Math.max(1, Math.ceil(total / PAGE))

  // ----- the panel for the clicked cell -----
  let panel: React.ReactNode = null
  if (item && pickedDay) {
    const [{ data: type }, { data: issues }, { data: lines }] = await Promise.all([
      supabase.from('equipment_types').select('id, name, owned_qty').eq('id', item).maybeSingle(),
      supabase.from('stock_issues').select('qty').eq('type_id', item).eq('status', 'open'),
      supabase
        .from('job_lines')
        .select('id, qty_required, mandatory, parent_line_id, job:jobs!inner(id, ref, name, status, out_date, return_date)')
        .eq('type_id', item)
        .eq('source', 'own')
        .is('archived_at', null)
        .is('job.archived_at', null)
        .not('job.status', 'in', `(${FINISHED.join(',')})`)
        .lte('job.out_date', pickedDay)
        .gte('job.return_date', pickedDay)
        .returns<LineRow[]>(),
    ])
    const used = (lines ?? []).filter((l) => prov || l.job.status !== 'provisional')
    const ids = used.map((l) => l.id)
    const { data: prog } = ids.length
      ? await supabase.from('line_progress').select('line_id, prepped_qty').in('line_id', ids)
      : { data: [] as { line_id: string; prepped_qty: number }[] }
    const prepped = new Map((prog ?? []).map((p) => [p.line_id, p.prepped_qty]))

    const cards: Card[] = used
      .map((l) => ({
        lineId: l.id,
        jobId: l.job.id,
        ref: l.job.ref,
        name: l.job.name,
        status: statusLabel(l.job.status),
        outDate: l.job.out_date,
        returnDate: l.job.return_date,
        qty: l.qty_required,
        prepped: prepped.get(l.id) ?? 0,
        mandatory: l.mandatory,
        inKit: l.parent_line_id !== null,
      }))
      .filter((c) => c.qty > 0)
      .sort((a, b) => a.outDate.localeCompare(b.outDate) || a.ref.localeCompare(b.ref))

    const booked = cards.reduce((s, c) => s + c.qty, 0)
    const owned = type?.owned_qty ?? 0
    const inIssue = (issues ?? []).reduce((s, i) => s + i.qty, 0)
    const free = owned - inIssue - booked

    let targets: Target[] = []
    if (canEdit) {
      const { data: live } = await supabase
        .from('jobs')
        .select('id, ref, name, status, out_date, return_date')
        .is('archived_at', null)
        .not('status', 'in', `(${FINISHED.join(',')})`)
        .order('out_date')
        .order('ref')
        .limit(300)
      targets = (live ?? [])
        .map((j) => ({
          id: j.id,
          ref: j.ref,
          name: j.name,
          status: statusLabel(j.status),
          outDate: j.out_date,
          returnDate: j.return_date,
        }))
    }

    panel = (
      <div className="card" id="detail">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>
            {type?.name ?? 'Item'} on {fmtDate(pickedDay)}
          </h2>
          <Link href={href({ item: null, day: null })}>Close</Link>
        </div>
        <p className="lead" style={{ marginTop: 6 }}>
          Owned {owned}
          {inIssue > 0 ? `, ${inIssue} damaged, missing or in repair` : ''}, booked {booked}.{' '}
          {free < 0 ? <span className="neg">Short by {-free}.</span> : <span>{free} free.</span>}
        </p>
        <MoveBoard typeId={item} cards={cards} targets={targets} winFrom={from} winTo={to} canEdit={canEdit} />
        {!canEdit && <p className="muted">Only the office can move kit between jobs.</p>}
      </div>
    )
  }

  // ----- the grid -----
  let lastDept: string | null | undefined
  let lastCat: string | null | undefined
  const body: React.ReactNode[] = []
  for (const r of rows) {
    if (r.department_name !== lastDept || r.category_name !== lastCat) {
      lastDept = r.department_name
      lastCat = r.category_name
      body.push(
        <tr key={`band-${r.type_id}`} className="band">
          <td colSpan={daysN + 2}>
            {[r.department_name, r.category_name].filter(Boolean).join(' / ') || 'No category'}
          </td>
        </tr>,
      )
    }
    body.push(
      <tr key={r.type_id}>
        <th scope="row" className="item" title={r.name}>
          {r.name}
        </th>
        <td className="owned" title={r.in_issue ? `${r.in_issue} damaged, missing or in repair` : undefined}>
          {r.owned - r.in_issue}
          {r.in_issue ? '*' : ''}
        </td>
        {days.map((d, i) => {
          const booked = r.alloc[i] ?? 0
          const free = r.owned - r.in_issue - booked
          const cls = free < 0 ? 'short' : booked > 0 && free === 0 ? 'tight' : booked === 0 ? 'free' : ''
          const dow = new Date(`${d}T00:00:00Z`).getUTCDay()
          const picked = item === r.type_id && pickedDay === d
          return (
            <td
              key={d}
              className={['cell', cls, dow === 0 || dow === 6 ? 'we' : '', picked ? 'picked' : ''].filter(Boolean).join(' ')}
            >
              <Link
                href={href({ item: r.type_id, day: d }, '#detail')}
                scroll
                title={`${r.name}, ${fmtDate(d)}: ${free} free, ${booked} booked`}
              >
                {free}
              </Link>
            </td>
          )
        })}
      </tr>,
    )
  }

  return (
    <>
      <Topbar name={profile.full_name} role={profile.role} />
      <div className="shell">
        <h1>Clash view</h1>
        <p className="lead">
          <Link href="/">Home</Link> · Free kit per day. Click a number to see which jobs use the item that day
          {canEdit ? ' and move kit between jobs.' : '.'}
        </p>

        <form method="get" className="card filters">
          <div>
            <label htmlFor="from">From</label>
            <input id="from" name="from" type="date" defaultValue={from} />
          </div>
          <div>
            <label htmlFor="days">Days</label>
            <select id="days" name="days" defaultValue={String(daysN)}>
              {DAY_CHOICES.map((n) => (
                <option key={n} value={n}>{n} days</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="dept">Department</label>
            <select id="dept" name="dept" defaultValue={dept}>
              <option value="">All</option>
              {(depts ?? []).map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="cat">Category</label>
            <select id="cat" name="cat" defaultValue={cat}>
              <option value="">All</option>
              {(depts ?? []).map((d) => (
                <optgroup key={d.id} label={d.name}>
                  {(cats ?? [])
                    .filter((c) => c.department_id === d.id)
                    .map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="mode">Show</label>
            <select id="mode" name="mode" defaultValue={mode}>
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="prov">Provisional jobs</label>
            <select id="prov" name="prov" defaultValue={prov ? '1' : '0'}>
              <option value="1">Count them</option>
              <option value="0">Leave them out</option>
            </select>
          </div>
          <div>
            <label htmlFor="q">Search</label>
            <input id="q" name="q" defaultValue={q} placeholder="Item name" />
          </div>
          <div>
            <button type="submit">Update</button>
          </div>
        </form>

        {panel}

        <div className="stack" style={{ marginTop: 16 }}>
          <div className="legend">
            <span><i className="l-short" /> Short (more booked than we have)</span>
            <span><i className="l-tight" /> None left</span>
            <span>Numbers are free kit. Owned column shows what is usable; * means some is damaged, missing or in repair.</span>
          </div>

          {grid.error ? (
            <p className="error" role="alert">{grid.error.message}</p>
          ) : (
            <>
              <p className="lead" style={{ margin: 0 }}>
                {total} {total === 1 ? 'item' : 'items'}, {fmtDate(from)} to {fmtDate(to)}
                {pages > 1 ? `. Page ${page} of ${pages}.` : '.'}
              </p>
              <div className="card clash-wrap">
                <table className="clash">
                  <thead>
                    <tr>
                      <th className="item" scope="col">Item</th>
                      <th scope="col" className="owned">Usable</th>
                      {days.map((d, i) => {
                        const dt = new Date(`${d}T00:00:00Z`)
                        const dow = dt.getUTCDay()
                        const dom = dt.getUTCDate()
                        return (
                          <th key={d} scope="col" className={dow === 0 || dow === 6 ? 'we' : undefined}>
                            <small>{WEEKDAYS[dow]}</small>
                            {dom}
                            <small>{i === 0 || dom === 1 ? MONTHS[dt.getUTCMonth()] : ' '}</small>
                          </th>
                        )
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {body}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={daysN + 2} className="muted" style={{ padding: 16, textAlign: 'left' }}>
                          {mode === 'short'
                            ? 'Nothing goes short in these dates.'
                            : mode === 'booked'
                              ? 'No kit is booked in these dates, or nothing matches the filters.'
                              : 'Nothing matches the filters.'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {pages > 1 && (
                <div className="pager">
                  {page > 1 && <Link href={href({ page: String(page - 1), item: null, day: null })}>Previous</Link>}
                  <span className="muted">Page {page} of {pages}</span>
                  {page < pages && <Link href={href({ page: String(page + 1), item: null, day: null })}>Next</Link>}
                </div>
              )}
              <div className="pager" style={{ marginTop: 0 }}>
                <Link href={href({ from: addDays(from, -daysN), page: '1', item: null, day: null })}>Earlier</Link>
                <Link href={href({ from: addDays(from, daysN), page: '1', item: null, day: null })}>Later</Link>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}
