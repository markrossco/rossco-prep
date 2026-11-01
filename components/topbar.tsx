'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Home, Briefcase, Package, AlertTriangle, ClipboardCheck, Truck, Camera, Layers, Shield, Activity, CalendarDays,
  type LucideIcon,
} from 'lucide-react'
import { signOut } from '@/app/actions'
import { roleLabel } from '@/lib/roles'

type Item = { label: string; href: string; icon: LucideIcon }

const HOME: Item = { label: 'Home', href: '/', icon: Home }
const JOBS: Item = { label: 'Jobs', href: '/jobs', icon: Briefcase }
const EQUIP: Item = { label: 'Equipment', href: '/equipment', icon: Package }
const ISSUES: Item = { label: 'Issues', href: '/issues', icon: AlertTriangle }
const TODAY: Item = { label: 'Today', href: '/warehouse', icon: CalendarDays }
const CHECKIN: Item = { label: 'Check-in', href: '/checkin', icon: ClipboardCheck }
const RECEIVE: Item = { label: 'Sub-hires', href: '/receive', icon: Truck }
const REPORT: Item = { label: 'Report', href: '/report', icon: Camera }
const KITS: Item = { label: 'Kits', href: '/kits', icon: Layers }
const ACTIVITY: Item = { label: 'My activity', href: '/activity', icon: Activity }
const ADMIN: Item = { label: 'Admin', href: '/admin', icon: Shield }

function menus(role: string): { side: Item[]; tabs: Item[] } {
  const office = role === 'admin' || role === 'office_lead' || role === 'office'
  const leads = role === 'admin' || role === 'office_lead'
  const side: Item[] = [HOME, TODAY, JOBS, EQUIP, ISSUES, CHECKIN, RECEIVE, REPORT, ACTIVITY]
  if (leads) side.splice(5, 0, KITS)
  if (role === 'admin') side.push(ADMIN)
  const tabs = office ? [HOME, JOBS, TODAY, EQUIP, ISSUES] : [HOME, TODAY, CHECKIN, REPORT, EQUIP]
  return { side, tabs }
}

export default function Topbar({ name, role }: { name: string; role: string }) {
  const path = usePathname() ?? '/'
  const { side, tabs } = menus(role)
  const active = (href: string) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`))

  return (
    <>
      <nav className="nav-side" aria-label="Main">
        <Link href="/" className="nav-brand">
          <span className="nav-logo">R</span>Rossco Prep
        </Link>
        <div className="nav-label">Work</div>
        {side.map((i) => (
          <Link key={i.href} href={i.href} className={`nav-link${active(i.href) ? ' active' : ''}`}>
            <i.icon size={20} />
            {i.label}
          </Link>
        ))}
        <div className="nav-user">
          <strong>{name}</strong>
          {roleLabel(role)}
          <div className="row-links">
            <Link href="/change-password">Password</Link>
            <form action={signOut}>
              <button type="submit" className="secondary small">Sign out</button>
            </form>
          </div>
        </div>
      </nav>

      <header className="topbar">
        <Link href="/" className="brand">
          <span className="nav-logo">R</span>Rossco Prep
        </Link>
        <div className="who">
          <Link href="/change-password">Password</Link>
          <form action={signOut}>
            <button type="submit" className="secondary small">Sign out</button>
          </form>
        </div>
      </header>

      <nav className="nav-tabs" aria-label="Main">
        {tabs.map((i) => (
          <Link key={i.href} href={i.href} className={`nav-tab${active(i.href) ? ' active' : ''}`}>
            <i.icon size={24} />
            {i.label}
          </Link>
        ))}
      </nav>
    </>
  )
}
