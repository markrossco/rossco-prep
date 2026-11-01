import Link from 'next/link'
import Topbar from '@/components/topbar'
import { requireAdmin } from '@/lib/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { ROLES } from '@/lib/roles'
import { setActive, setRole } from './actions'
import { NewUserForm, ResetPasswordButton } from './forms'

export default async function AdminPage() {
  const { profile, supabase } = await requireAdmin()

  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, full_name, role, active, must_change_password')
    .order('full_name')

  // Email addresses live in the sign-in system, readable only with the secret key
  const admin = createAdminClient()
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 })
  const email = new Map((list?.users ?? []).map((u) => [u.id, u.email ?? '']))

  return (
    <>
      <Topbar name={profile.full_name} role={profile.role} />
      <div className="shell">
        <h1>Admin</h1>
        <p className="lead">
          <Link href="/">Home</Link> · <Link href="/admin/audit">Audit log</Link>
        </p>

        <NewUserForm />

        <h2>Users</h2>
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {(profiles ?? []).map((p) => (
                <tr key={p.id}>
                  <td>{p.full_name || '(no name)'}{p.id === profile.id && <> <span className="badge">you</span></>}</td>
                  <td>{email.get(p.id)}</td>
                  <td>
                    <form action={setRole}>
                      <input type="hidden" name="id" value={p.id} />
                      <select name="role" defaultValue={p.role} disabled={p.id === profile.id}>
                        {ROLES.map((r) => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
                      {p.id !== profile.id && <button type="submit" className="secondary small">Save</button>}
                    </form>
                  </td>
                  <td>
                    {p.active ? 'Active' : <span className="badge">Switched off</span>}
                    {p.must_change_password && <> <span className="badge">temp password</span></>}
                  </td>
                  <td>
                    {p.id !== profile.id && (
                      <>
                        <form action={setActive}>
                          <input type="hidden" name="id" value={p.id} />
                          <input type="hidden" name="active" value={p.active ? 'false' : 'true'} />
                          <button type="submit" className={p.active ? 'secondary small' : 'small'}>
                            {p.active ? 'Switch off' : 'Switch on'}
                          </button>
                        </form>{' '}
                        <ResetPasswordButton id={p.id} />
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="lead" style={{ marginTop: 12 }}>
          Switching someone off keeps all their history. Users are never deleted.
        </p>
      </div>
    </>
  )
}
