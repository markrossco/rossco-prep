import Link from 'next/link'
import { ChevronLeft, ChevronRight, ArrowLeftRight } from 'lucide-react'
import Topbar from '@/components/topbar'
import { requireSession } from '@/lib/session'
import { fmtDate, statusLabel } from '@/lib/jobs'

type Cell = {
  type_id: string
  day: string
  owned: number
  in_issue: number
  allocated: number
  free: number
  turnaround: boolean
}
type TypeRow = { id: string; name: string; category_id: string | null }
type Cat = { id: string; name: string }
type Line = {
  qty_required: number
  job: { id: string; ref: string; name: string; status: string; out_date: string; return_date: string; archived_at: string | null } | null
}

const DAY = 86400000
const t = (d: string) => Date.parse(`${d}T00:00:00Z`)
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(t(s))
const isUuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s)
const londonToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
const ROW_LIMIT = 250

const dayHead = (d: string) =>
  new Date(t(d)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' })

export default async function ClashPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { profile, supabase } = await requireSession()
  const sp = await searchParams
  const today = londonToday()
  const from = isDay(sp.from ?? '') ? (sp.from as string) : today
  const span = [7, 14, 28].includes(Number(sp.days)) ? Number(sp.days) : 14
  const to = iso(t(from) + (span - 1) * DAY)
  const withProv = sp.prov !== '0'
  const show = sp.show === 'all' ? 'all' : 'clashes'
  const cat = isUuid(sp.cat ?? '') ? (sp.cat as string) : ''
  const sel = isUuid(sp.type ?? '') ? (sp.type as string) : ''

  const keep = (over: Record<string, string>) => {
    const p = new URLSearchParams({ from, days: String(span), prov: withProv ? '1' : '0', show, ...(cat ? { cat } : {}), ...over })
    return `/clash?${p.toString()}`
  }

  const [gridRes, typesRes, catsRes] = await Promise.all([
    supabase.rpc('availability_grid', { p_from: from, p_to: to, p_include_provisional: withProv, p_category: cat || null }),
    supabase.from('equipment_types').select('id, name, category_id').eq('kind', 'stock').is('archived_at', null).returns<TypeRow[]>(),
    supabase.from('categories').select('id, name').is('archived_at', null).order('sort').returns<Cat[]>(),
  ])

  const gridError = gridRes.error?.message
  const cells = (gridRes.data ?? []) as Cell[]
  const names = new Map((typesRes.data ?? []).map((x) => [x.id, x.name]))
  const days = Array.from({ length: span }, (_, i) => iso(t(from) + i * DAY))

  const byType = new Map<string, Map<string, Cell>>()
  for (const c of cells) {
    const day = String(c.day).slice(0, 10)
    if (!byType.has(c.type_id)) byType.set(c.type_id, new Map())
    byType.get(c.type_id)!.set(day, c)
  }

  const rows = [...byType.entries()]
    .map(([id, m]) => {
      const list = [...m.values()]
      return {
        id,
        name: names.get(id) ?? 'Unknown item',
        worst: Math.min(...list.map((c) => c.free)),
        booked: Math.max(...list.map((c) => c.allocated)),
        cells: m,
      }
    })
    .filter((r) => (show === 'all' ? r.booked > 0 || r.worst < 0 : r.worst < 0))
    .sort((a, b) => a.worst - b.worst || a.name.localeCompare(b.name))

  const clashCount = [...byType.values()].filter((m) => [...m.values()].some((c) => c.free < 0)).length
  const shown = rows.slice(0, ROW_LIMIT)

  let lines: Line[] = []
  if (sel) {
    const { data } = await supabase
      .from('job_lines')
      .select('qty_required, job:jobs(id, ref, name, status, out_date, return_date, archived_at)')
      .eq('type_id', sel)
      .eq('source', 'own')
      .is('archived_at', null)
      .returns<Line[]>()
    lines = (data ?? [])
      .filter(
        (l) =>
          l.job &&
          !l.job.archived_at &&
          !['cancelled', 'returned', 'closed'].includes(l.job.status) &&
          (withProv || l.job.status !== 'provisional') &&
          l.job.out_date <= to &&
          l.job.return_date >= from,
      )
      .sort((a, b) => a.job!.out_date.localeCompare(b.job!.out_date))
  }
  const selName = sel ? names.get(sel) ?? 'Item' : ''
  const selCells = sel ? byType.get(sel) : undefined

  const step = span
  const prevFrom = iso(t(from) - step * DAY)
  const nextFrom = iso(t(from) + step * DAY)

  return (
    <>
      <Topbar name={profile.full_name} role={profile.role} />
      <div className="shell">
        <h1>Clash view</h1>
        <p className="lead">
          Free kit per day. Red means more is booked than we own. <Link href="/calendar">Calendar</Link>
        </p>

        <form method="get" className="card filters">
          <div>
            <label htmlFor="from">From</label>
            <input id="from" type="date" name="from" defaultValue={from} />
          </div>
          <div>
            <label htmlFor="days">Days</label>
            <select id="days" name="days" defaultValue={String(span)}>
              <option value="7">7</option>
              <option value="14">14</option>
              <option value="28">28</option>
            </select>
          </div>
          <div>
            <label htmlFor="cat">Category</label>
            <select id="cat" name="cat" defaultValue={cat}>
              <option value="">All</option>
              {(catsRes.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="show">Show</label>
            <select id="show" name="show" defaultValue={show}>
              <option value="clashes">Clashes only</option>
              <option value="all">Everything booked</option>
            </select>
          </div>
          <div>
            <label className="check" htmlFor="prov">
              <input id="prov" type="checkbox" name="prov" value="1" defaultChecked={withProv} />
              Count provisional jobs
            </label>
          </div>
          <div>
            <button type="submit">Update</button>
          </div>
        </form>

        <div className="cal-head" style={{ marginTop: 16 }}>
          <Link href={keep({ from: prevFrom })} className="btn secondary small" aria-label="Earlier"><ChevronLeft size={18} /></Link>
          <strong className="cal-title">{fmtDate(from)} to {fmtDate(to)}</strong>
          <Link href={keep({ from: nextFrom })} className="btn secondary small" aria-label="Later"><ChevronRight size={18} /></Link>
          <Link href={keep({ from: today })} className="btn secondary small">Today</Link>
        </div>

        {gridError && <p className="error">Could not load availability: {gridError}</p>}

        <div className="stats">
          <div className="stat"><strong className={clashCount > 0 ? 'neg' : ''}>{clashCount}</strong><span>{clashCount === 1 ? 'item clashes' : 'items clash'} in this range</span></div>
          <div className="stat"><strong>{byType.size}</strong><span>items checked</span></div>
        </div>

        <div className="card table-wrap clash">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                {days.map((d) => (
                  <th key={d} className={`num${d === today ? ' clash-today' : ''}`}>{dayHead(d)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className={r.id === sel ? 'clash-sel' : ''}>
                  <td className="clash-name">
                    <Link href={keep({ type: r.id })}>{r.name}</Link>
                  </td>
                  {days.map((d) => {
                    const c = r.cells.get(d)
                    if (!c) return <td key={d} className="num muted">-</td>
                    const cls = c.free < 0 ? 'cl-neg' : c.free === 0 ? 'cl-zero' : 'cl-ok'
                    return (
                      <td key={d} className={`num ${cls}`} title={`Owned ${c.owned}, in issue ${c.in_issue}, booked ${c.allocated}`}>
                        {c.free}
                        {c.turnaround && <ArrowLeftRight size={11} className="cl-turn" aria-label="Turnaround day" />}
                      </td>
                    )
                  })}
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={days.length + 1} className="muted">
                    {show === 'clashes' ? 'No clashes in this range.' : 'Nothing is booked in this range.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {rows.length > ROW_LIMIT && <p className="lead" style={{ marginTop: 12 }}>Showing the worst {ROW_LIMIT} of {rows.length}. Narrow by category to see the rest.</p>}

        <div className="cal-legend">
          <span><i className="cal-key" style={{ background: 'var(--danger)' }} />Short</span>
          <span><i className="cal-key" style={{ background: 'var(--warn)' }} />None spare</span>
          <span><i className="cal-key" style={{ background: 'var(--ok)' }} />Free</span>
          <span><ArrowLeftRight size={13} />One job returns and another goes out</span>
        </div>

        {sel && (
          <>
            <h2>{selName}: jobs in this range</h2>
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr><th>Job</th><th>Status</th><th>Out</th><th>Back</th><th className="num">Qty</th></tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={`${l.job!.id}-${i}`}>
                      <td><Link href={`/jobs/${l.job!.id}`}>{l.job!.ref}</Link> {l.job!.name}</td>
                      <td><span className="badge">{statusLabel(l.job!.status)}</span></td>
                      <td>{fmtDate(l.job!.out_date)}</td>
                      <td>{fmtDate(l.job!.return_date)}</td>
                      <td className="num">{l.qty_required}</td>
                    </tr>
                  ))}
                  {lines.length === 0 && <tr><td colSpan={5} className="muted">No own-stock lines in this range.</td></tr>}
                </tbody>
              </table>
            </div>
            {selCells && (
              <p className="lead" style={{ marginTop: 12 }}>
                We own {[...selCells.values()][0]?.owned ?? 0}
                {([...selCells.values()][0]?.in_issue ?? 0) > 0 ? `, ${[...selCells.values()][0].in_issue} in issue` : ''}. Shortages are covered by a sub-hire on the job.
              </p>
            )}
          </>
        )}
      </div>
    </>
  )
}
