import Link from 'next/link'
import Topbar from '@/components/topbar'
import { requireAdmin } from '@/lib/session'

type Row = {
  id: number
  table_name: string
  row_id: string | null
  action: string
  user_id: string | null
  at: string
  new_data: Record<string, unknown> | null
  old_data: Record<string, unknown> | null
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ table?: string }>
}) {
  const { profile, supabase } = await requireAdmin()
  const { table } = await searchParams

  let q = supabase
    .from('audit_log')
    .select('id, table_name, row_id, action, user_id, at, new_data, old_data')
    .order('at', { ascending: false })
    .order('id', { ascending: false })
    .limit(200)
  if (table) q = q.eq('table_name', table)
  const { data: rows } = await q.returns<Row[]>()

  const { data: people } = await supabase.from('profiles').select('id, full_name')
  const name = new Map((people ?? []).map((p) => [p.id, p.full_name]))

  const label = (r: Row) => {
    const d = (r.new_data ?? r.old_data ?? {}) as Record<string, unknown>
    return String(d.name ?? d.ref ?? d.asset_no ?? d.full_name ?? d.description ?? d.action ?? r.row_id ?? '')
  }

  return (
    <>
      <Topbar name={profile.full_name} role={profile.role} />
      <div className="shell">
        <h1>Audit log</h1>
        <p className="lead">
          <Link href="/admin">Admin</Link> · Latest 200 changes{table ? ` to ${table}` : ''}.{' '}
          {table && <Link href="/admin/audit">Show all</Link>} Entries can never be edited or removed.
        </p>
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>When</th><th>Who</th><th>Action</th><th>Table</th><th>Record</th></tr>
            </thead>
            <tbody>
              {(rows ?? []).map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.at).toLocaleString('en-GB', { timeZone: 'Europe/London' })}</td>
                  <td>{r.user_id ? name.get(r.user_id) ?? 'unknown' : 'system'}</td>
                  <td>{r.action}</td>
                  <td><Link href={`/admin/audit?table=${r.table_name}`}>{r.table_name}</Link></td>
                  <td>{label(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
