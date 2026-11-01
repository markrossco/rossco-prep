import Link from 'next/link'
import Topbar from '@/components/topbar'
import { requireSession } from '@/lib/session'
import { isOffice, isWarehouse } from '@/lib/roles'

type Tile = { title: string; note: string; href?: string; phase?: number }

const OFFICE: Tile[] = [
  { title: 'Jobs', note: 'Every job by out date, with its equipment list', href: '/jobs' },
  { title: 'New job', note: 'ROS number, dates, client and venue', href: '/jobs/new' },
  { title: 'Equipment register', note: 'Every item, owned, free and issues', href: '/equipment' },
  { title: 'Clash view', note: 'Free kit per day, drag between jobs', href: '/clash' },
  { title: 'Issues', note: 'Damaged, missing and in repair', href: '/issues' },
]
const LEADS: Tile[] = [{ title: 'Kits and packages', note: 'Edit what each kit contains', href: '/kits' }]
const WAREHOUSE_LOOKUP: Tile[] = [
  { title: 'Jobs', note: 'See what is going out and what is on each list', href: '/jobs' },
  { title: 'Equipment register', note: 'Every item, owned, free and issues', href: '/equipment' },
  { title: 'Issues', note: 'Report and track damaged or missing kit', href: '/issues' },
]
const WAREHOUSE: Tile[] = [
  { title: 'Today and this week', note: 'Jobs to prep and jobs coming back', href: '/warehouse' },
  { title: 'Return check-in', note: 'Book equipment back in', href: '/checkin' },
  { title: 'Sub-hire receipt', note: 'Receive and return sub-hires', href: '/receive' },
  { title: 'Quick report', note: 'Report lost or damaged kit, with a photo', href: '/report' },
  { title: 'My activity', note: 'What you prepped and checked in', href: '/activity' },
]

export default async function Home() {
  const { profile } = await requireSession()
  const role = profile.role

  const tiles: Tile[] = []
  if (isOffice(role)) tiles.push(...OFFICE)
  if (role === 'admin' || role === 'office_lead') tiles.push(...LEADS)
  if (isWarehouse(role)) tiles.push(...WAREHOUSE_LOOKUP)
  if (isWarehouse(role) || isOffice(role)) tiles.push(...WAREHOUSE)
  if (role === 'admin') tiles.unshift({ title: 'Admin', note: 'Users, roles and the audit log', href: '/admin' })

  return (
    <>
      <Topbar name={profile.full_name} role={role} />
      <div className="shell">
        <h1>Hello, {profile.full_name.split(' ')[0] || 'there'}</h1>
        <p className="lead">The rest of the system arrives phase by phase. Only the greyed items are still to come.</p>
        <div className="grid">
          {tiles.map((t) =>
            t.href ? (
              <Link key={t.title} href={t.href} className="tile">
                <strong>{t.title}</strong>
                <span>{t.note}</span>
              </Link>
            ) : (
              <div key={t.title} className="tile soon" aria-disabled="true">
                <strong>{t.title}</strong>
                <span>{t.note} · phase {t.phase}</span>
              </div>
            ),
          )}
        </div>
      </div>
    </>
  )
}
