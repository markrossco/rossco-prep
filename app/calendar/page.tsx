import Link from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'
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
  sub_hire_open: number
}

const DAY = 86400000
const t = (d: string) => Date.parse(`${d}T00:00:00Z`)
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const diff = (a: string, b: string) => Math.round((t(b) - t(a)) / DAY)
const londonToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })

const HEAD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

type Seg = { job: Row; start: number; end: number; lane: number; fromLeft: boolean; toRight: boolean }

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { profile, supabase } = await requireSession()
  const sp = await searchParams
  const today = londonToday()
  const m = /^\d{4}-\d{2}$/.test(sp.m ?? '') ? (sp.m as string) : today.slice(0, 7)
  const first = `${m}-01`
  const firstMs = t(first)
  const firstDow = (new Date(firstMs).getUTCDay() + 6) % 7
  const nextMonthMs = Date.UTC(new Date(firstMs).getUTCFullYear(), new Date(firstMs).getUTCMonth() + 1, 1)
  const lastMs = nextMonthMs - DAY
  const lastDow = (new Date(lastMs).getUTCDay() + 6) % 7
  const gridStart = iso(firstMs - firstDow * DAY)
  const gridEnd = iso(lastMs + (6 - lastDow) * DAY)
  const monthLabel = new Date(firstMs).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const prev = iso(Date.UTC(new Date(firstMs).getUTCFullYear(), new Date(firstMs).getUTCMonth() - 1, 1)).slice(0, 7)
  const next = iso(nextMonthMs).slice(0, 7)

  const { data } = await supabase
    .from('job_list')
    .select('id, ref, name, status, out_date, return_date, client_name, sub_hire_open')
    .is('archived_at', null)
    .neq('status', 'cancelled')
    .lte('out_date', gridEnd)
    .gte('return_date', gridStart)
    .order('out_date')
    .order('ref')
    .limit(400)
    .returns<Row[]>()
  const jobs = data ?? []

  const weeks: { days: string[]; segs: Seg[]; lanes: number }[] = []
  const weekCount = (diff(gridStart, gridEnd) + 1) / 7
  for (let w = 0; w < weekCount; w++) {
    const ws = iso(t(gridStart) + w * 7 * DAY)
    const we = iso(t(ws) + 6 * DAY)
    const days = Array.from({ length: 7 }, (_, i) => iso(t(ws) + i * DAY))
    const inWeek = jobs.filter((j) => j.out_date <= we && j.return_date >= ws)
    const laneEnds: number[] = []
    const segs: Seg[] = inWeek.map((job) => {
      const start = Math.max(0, diff(ws, job.out_date))
      const end = Math.min(6, diff(ws, job.return_date))
      let lane = laneEnds.findIndex((e) => e < start)
      if (lane === -1) lane = laneEnds.length
      laneEnds[lane] = end
      return { job, start, end, lane, fromLeft: job.out_date < ws, toRight: job.return_date > we }
    })
    weeks.push({ days, segs, lanes: Math.max(1, laneEnds.length) })
  }

  const inMonth = jobs
    .filter((j) => (j.out_date >= first && j.out_date <= iso(lastMs)) || (j.return_date >= first && j.return_date <= iso(lastMs)))
    .sort((a, b) => a.out_date.localeCompare(b.out_date) || a.ref.localeCompare(b.ref))

  return (
    <>
      <Topbar name={profile.full_name} role={profile.role} />
      <div className="shell">
        <h1>Calendar</h1>
        <p className="lead">
          <Link href="/jobs">List view</Link> · Calendar view
        </p>

        <div className="cal-head">
          <Link href={`/calendar?m=${prev}`} className="btn secondary small" aria-label="Previous month"><ChevronLeft size={18} /></Link>
          <strong className="cal-title">{monthLabel}</strong>
          <Link href={`/calendar?m=${next}`} className="btn secondary small" aria-label="Next month"><ChevronRight size={18} /></Link>
          <Link href="/calendar" className="btn secondary small">Today</Link>
        </div>

        <div className="cal card">
          <div className="cal-dow">
            {HEAD.map((d) => <span key={d}>{d}</span>)}
          </div>
          {weeks.map((w, wi) => (
            <div key={wi} className="cal-week">
              <div className="cal-bg">
                {w.days.map((d) => (
                  <div key={d} className={`cal-cell${d.slice(0, 7) !== m ? ' off' : ''}${d === today ? ' today' : ''}`}>
                    <span className="cal-num">{Number(d.slice(8))}</span>
                  </div>
                ))}
              </div>
              <div className="cal-fg" style={{ gridTemplateRows: `30px repeat(${w.lanes}, 26px)` }}>
                {w.segs.map((s) => (
                  <Link
                    key={`${s.job.id}-${wi}`}
                    href={`/jobs/${s.job.id}`}
                    className={`cal-bar st-${s.job.status}${s.fromLeft ? ' from-left' : ''}${s.toRight ? ' to-right' : ''}`}
                    style={{ gridColumn: `${s.start + 1} / ${s.end + 2}`, gridRow: s.lane + 2 }}
                    title={`${s.job.ref} ${s.job.name} · ${statusLabel(s.job.status)} · ${fmtDate(s.job.out_date)} to ${fmtDate(s.job.return_date)}`}
                  >
                    <span>{s.job.ref} {s.job.client_name ?? s.job.name}</span>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="cal-legend">
          {(['provisional', 'confirmed', 'prepping', 'prepped', 'out', 'returned'] as const).map((s) => (
            <span key={s}><i className={`cal-key st-${s}`} />{statusLabel(s)}</span>
          ))}
        </div>

        <h2>Jobs this month</h2>
        <section className="card" aria-label="Jobs this month">
          {inMonth.length === 0 ? (
            <p className="empty">No jobs this month.</p>
          ) : (
            inMonth.map((j) => (
              <Link key={j.id} href={`/jobs/${j.id}`} className="job-row">
                <i className={`cal-key st-${j.status}`} />
                <span className="grow">
                  <strong>{j.client_name ?? j.name}</strong>
                  <span className="sub">{j.ref} · {j.name} · {statusLabel(j.status)}{j.sub_hire_open > 0 ? ' · sub-hire due' : ''}</span>
                </span>
                <span className="when">{fmtDate(j.out_date)} to {fmtDate(j.return_date)}</span>
              </Link>
            ))
          )}
        </section>
      </div>
    </>
  )
}
