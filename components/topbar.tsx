import Link from 'next/link'
import { signOut } from '@/app/actions'
import { roleLabel } from '@/lib/roles'

export default function Topbar({ name, role }: { name: string; role: string }) {
  return (
    <header className="topbar">
      <Link href="/" className="brand">Rossco Prep</Link>
      <div className="who">
        <span>{name} · {roleLabel(role)}</span>
        <Link href="/change-password">Password</Link>
        <form action={signOut}>
          <button type="submit" className="secondary small">Sign out</button>
        </form>
      </div>
    </header>
  )
}
