import Link from 'next/link'
import Topbar from '@/components/topbar'
import { requireSession } from '@/lib/session'

type Parent = { id: string; name: string; kind: string; active: boolean; archived_at: string | null }

export default async function KitsPage() {
  const { profile, supabase } = await requireSession()
  const canEdit = profile.role === 'admin' || profile.role === 'office_lead'

  const [{ data: kits }, { data: links }] = await Promise.all([
    supabase.from('equipment_types').select('id, name, kind, active, archived_at').eq('kind', 'kit').is('archived_at', null).order('name').limit(1000).returns<Parent[]>(),
    supabase.from('type_accessories').select('parent_type_id').is('archived_at', null).limit(5000),
  ])
  const count = new Map<string, number>()
  for (const l of links ?? []) count.set(l.parent_type_id, (count.get(l.parent_type_id) ?? 0) + 1)

  const kitIds = new Set((kits ?? []).map((k) => k.id))
  const otherIds = [...count.keys()].filter((id) => !kitIds.has(id))
  const { data: others } = otherIds.length
    ? await supabase.from('equipment_types').select('id, name, kind, active, archived_at').in('id', otherIds).order('name').returns<Parent[]>()
    : { data: [] as Parent[] }

  const row = (p: Parent) => (
    <tr key={p.id}>
      <td><Link href={`/kits/${p.id}`}>{p.name}</Link>{!p.active && <span className="badge">off</span>}</td>
      <td className="num">{count.get(p.id) ?? 0}</td>
    </tr>
  )

  return (
    <>
      <Topbar name={profile.full_name} role={profile.role} />
      <div className="shell">
        <h1>Kits and packages</h1>
        <p className="lead">
          <Link href="/">Home</Link> · <Link href="/equipment">Equipment register</Link>
          {canEdit && <> · <Link href="/equipment/new">Add a kit (choose kind: kit)</Link></>}
        </p>
        <h2>Kits and packages</h2>
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Kit</th><th className="num">Contents</th></tr></thead>
            <tbody>
              {(kits ?? []).map(row)}
              {(kits ?? []).length === 0 && <tr><td colSpan={2} className="muted">No kits yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <h2>Items with accessories</h2>
        <p className="lead">Normal stock items that bring other items with them, such as a speaker and its stand.</p>
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Item</th><th className="num">Contents</th></tr></thead>
            <tbody>
              {(others ?? []).map(row)}
              {(others ?? []).length === 0 && <tr><td colSpan={2} className="muted">None yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
