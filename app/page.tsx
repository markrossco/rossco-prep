import Link from 'next/link'
import { ChevronRight, Clock, PackageCheck, Truck, CalendarDays, Briefcase, Plus, ClipboardCheck, Camera, Package, AlertTriangle, CalendarRange } from 'lucide-react'
import Topbar from '@/components/topbar'
import { requireSession } from '@/lib/session'
import { isOffice } from '@/lib/roles'
import { fmtDate, statusLabel } from '@/lib/jobs'

type Row = {
  id: string
  ref: string
  name: string
  status: string
  out_date: string
  return_date: string
  client_name: string | null
  lines_total: number
  lines_prepped: number
  sub_hire_open: number
}

const COLS = 'id, ref, name, status, out_date, return_date, client_name, lines_total, lines_prepped, sub_hire_open'

const dayString = (offset: number) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
}

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000)

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

type Todo = { key: string; title: string; note: string; tone: 'red' | 'amber' | 'indigo'; href: string; icon: 'clock' | 'prep' | 'truck' }

export default async function Home() {
  const { profile, supabase } = await requireSession()
  const role = profile.role
  const today = dayString(0)

  const [{ data: upcoming }, { data: out }] = await Promise.all([
    supabase
      .from('job_list')
      .select(COLS)
      .is('archived_at', null)
      .in('status', ['provisional', 'confirmed', 'prepping', 'prepped'])
      .order('out_date')
      .order('ref')
      .limit(40)
      .returns<Row[]>(),
    supabase
      .from('job_list')
      .select(COLS)
      .is('archived_at', null)
      .eq('status', 'out')
      .order('return_date')
      .order('ref')
      .returns<Row[]>(),
  ])

  const jobs = upcoming ?? []
  const outNow = out ?? []

  const todos: Todo[] = []
  for (const j of outNow.filter((x) => x.return_date < today)) {
    const d = daysBetween(j.return_date, today)
    todos.push({ key: `late-${j.id}`, title: `${j.ref} ${j.name}`, note: `Back ${plural(d, 'day')} late`, tone: 'red', href: `/checkin/${j.id}`, icon: 'clock' })
  }
  for (const j of jobs.filter((x) => x.status !== 'provisional' && x.out_date <= today)) {
    const left = j.lines_total - j.lines_prepped
    const note = j.out_date < today ? `Should have gone out ${plural(daysBetween(j.out_date, today), 'day')} ago` : 'Goes out today'
    todos.push({ key: `prep-${j.id}`, title: `${j.ref} ${j.name}`, note: left > 0 ? `${note} · ${left} lines to prep` : note, tone: j.out_date < today ? 'red' : 'amber', href: `/prep/${j.id}`, icon: 'prep' })
  }
  for (const j of jobs.filter((x) => x.sub_hire_open > 0 && x.status !== 'provisional')) {
    todos.push({ key: `sub-${j.id}`, title: `${j.ref} ${j.name}`, note: `Sub-hire not arrived (${j.sub_hire_open} open)`, tone: 'indigo', href: `/receive`, icon: 'truck' })
  }

  const nextUp = jobs.find((j) => j.out_date >= today) ?? null
  const list = jobs.filter((j) => j.id !== nextUp?.id).slice(0, 4)

  const dot = (j: Row) => (j.status === 'provisional' ? 'grey' : j.sub_hire_open > 0 ? 'amber' : '')
  const icons = { clock: Clock, prep: PackageCheck, truck: Truck }
  const first = profile.full_name.split(' ')[0] || 'there'
  const hour = Number(new Date().toLocaleString('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/London' }))
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  const office = isOffice(role)

  return (
    <>
      <Topbar name={profile.full_name} role={role} />
      <div className="shell">
        <h1 className="hello">{greeting},<br />{first}</h1>

        <div className="stack">
          <section className="card" aria-label="Needs doing">
            <h3>Needs doing {todos.length > 0 && <span className="count">{todos.length}</span>}</h3>
            {todos.length === 0 ? (
              <p className="empty">Nothing waiting. All caught up.</p>
            ) : (
              <div className="todo-list">
                {todos.slice(0, 6).map((t) => {
                  const Icon = icons[t.icon]
                  return (
                    <Link key={t.key} href={t.href} className="todo">
                      <span className={`todo-icon ${t.tone}`}><Icon size={22} /></span>
                      <span className="todo-body">
                        <strong>{t.title}</strong>
                        <span className={t.tone}>{t.note}</span>
                      </span>
                      <ChevronRight className="chev" size={20} />
                    </Link>
                  )
                })}
              </div>
            )}
          </section>

          {nextUp && (
            <Link href={`/jobs/${nextUp.id}`} className="next-up">
              <span className="todo-icon"><CalendarDays size={26} /></span>
              <span className="todo-body">
                <span className="eyebrow">Next up · {fmtDate(nextUp.out_date)}</span>
                <strong>{nextUp.ref} {nextUp.name}</strong>
                <span className="sub">{nextUp.client_name ?? statusLabel(nextUp.status)}{nextUp.lines_total > 0 ? ` · ${nextUp.lines_prepped}/${nextUp.lines_total} prepped` : ''}</span>
              </span>
              <ChevronRight className="chev" size={22} />
            </Link>
          )}

          <section className="card" aria-label="Upcoming jobs">
            <h3>Upcoming jobs</h3>
            {list.length === 0 ? (
              <p className="empty">No other jobs coming up.</p>
            ) : (
              list.map((j) => (
                <Link key={j.id} href={`/jobs/${j.id}`} className="job-row">
                  <span className={`dot ${dot(j)}`} />
                  <span className="grow">
                    <strong>{j.client_name ?? j.name}</strong>
                    <span className="sub">{j.ref} · {j.name} · {statusLabel(j.status)}</span>
                  </span>
                  <span className="when">{fmtDate(j.out_date)}</span>
                </Link>
              ))
            )}
            <p style={{ margin: '12px 0 0' }}><Link href="/jobs">Show all jobs</Link></p>
          </section>

          <div className="actions">
            {office && <Link href="/jobs/new" className="action indigo"><Plus size={30} />New job</Link>}
            <Link href="/warehouse" className="action amber"><CalendarRange size={30} />Today</Link>
            <Link href="/checkin" className="action green"><ClipboardCheck size={30} />Check-in</Link>
            <Link href="/report" className="action rose"><Camera size={30} />Report damage</Link>
            <Link href="/equipment" className="action sky"><Package size={30} />Equipment</Link>
            <Link href="/issues" className="action rose"><AlertTriangle size={30} />Issues</Link>
            {!office && <Link href="/jobs" className="action indigo"><Briefcase size={30} />Jobs</Link>}
          </div>
        </div>
      </div>
    </>
  )
}
