import Link from 'next/link'
import Topbar from '@/components/topbar'
import ActionForm from '@/components/action-form'
import PhotoField from '@/components/photo-field'
import { requireSession } from '@/lib/session'
import { reportIssue, resolveIssue } from './actions'

type Issue = {
  id: string
  type_id: string
  type_name: string
  asset_no: string | null
  qty: number
  issue: string
  status: string
  resolution: string | null
  note: string | null
  photo_path: string | null
  job_ref: string | null
  reported_by_name: string | null
  reported_at: string
  resolved_at: string | null
  resolved_by_name: string | null
  days_open: number
}
const ISSUE_LABEL: Record<string, string> = { damaged: 'Damaged', missing: 'Missing', in_repair: 'In repair' }
const when = (s: string) => new Date(s).toLocaleDateString('en-GB', { timeZone: 'Europe/London' })

export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>
}) {
  const { profile, supabase } = await requireSession()
  const { show } = await searchParams
  const resolvedView = show === 'resolved'
  const canResolve = ['admin', 'office_lead', 'warehouse_lead'].includes(profile.role)

  const [{ data: issues }, { data: names }] = await Promise.all([
    supabase
      .from('issue_list')
      .select('*')
      .eq('status', resolvedView ? 'resolved' : 'open')
      .order(resolvedView ? 'resolved_at' : 'reported_at', { ascending: false })
      .limit(200)
      .returns<Issue[]>(),
    supabase.from('equipment_types').select('name').eq('kind', 'stock').eq('active', true).is('archived_at', null).order('name').limit(3000),
  ])

  const photoPaths = (issues ?? []).map((i) => i.photo_path).filter((p): p is string => !!p)
  const signed = photoPaths.length ? await supabase.storage.from('issue-photos').createSignedUrls(photoPaths, 3600) : null
  const photoUrl = new Map((signed?.data ?? []).filter((x) => x.signedUrl).map((x) => [x.path as string, x.signedUrl]))

  return (
    <>
      <Topbar name={profile.full_name} role={profile.role} />
      <div className="shell">
        <h1>Issues</h1>
        <p className="lead">
          <Link href="/">Home</Link> · <Link href="/equipment">Equipment register</Link> ·{' '}
          {resolvedView ? <Link href="/issues">Show open</Link> : <Link href="/issues?show=resolved">Show resolved</Link>}
        </p>

        {!resolvedView && (
          <section className="card" style={{ marginBottom: 20 }}>
            <h2 style={{ marginTop: 0 }}>Report an issue</h2>
            <ActionForm action={reportIssue} submit="Report" clearOnSuccess>
              <label htmlFor="item_name">Item</label>
              <input id="item_name" name="item_name" list="item-names" autoComplete="off" placeholder="Start typing the name" />
              <datalist id="item-names">
                {(names ?? []).map((n) => (
                  <option key={n.name} value={n.name} />
                ))}
              </datalist>
              <div className="row">
                <div>
                  <label htmlFor="issue">What happened</label>
                  <select id="issue" name="issue" defaultValue="damaged">
                    <option value="damaged">Damaged</option>
                    <option value="missing">Missing</option>
                    <option value="in_repair">In repair</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="qty">How many</label>
                  <input id="qty" name="qty" inputMode="numeric" defaultValue="1" />
                </div>
                <div>
                  <label htmlFor="asset_no">Asset number (if it has one)</label>
                  <input id="asset_no" name="asset_no" />
                </div>
              </div>
              <label htmlFor="note">Note</label>
              <input id="note" name="note" />
              <PhotoField />
            </ActionForm>
          </section>
        )}

        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th><th>Issue</th><th className="num">Qty</th><th>Reported</th><th>Note</th>
                <th>{resolvedView ? 'Resolved' : ''}</th>
              </tr>
            </thead>
            <tbody>
              {(issues ?? []).map((i) => (
                <tr key={i.id}>
                  <td>
                    <Link href={`/equipment/${i.type_id}`}>{i.type_name}</Link>
                    {i.asset_no && <span className="badge">{i.asset_no}</span>}
                  </td>
                  <td>{ISSUE_LABEL[i.issue] ?? i.issue}</td>
                  <td className="num">{i.qty}</td>
                  <td className="muted">{when(i.reported_at)} · {i.reported_by_name ?? 'unknown'}{!resolvedView && ` · ${i.days_open}d`}</td>
                  <td className="muted">
                    {i.note ?? ''}
                    {i.job_ref && <span className="badge">{i.job_ref}</span>}
                    {i.photo_path && photoUrl.get(i.photo_path) ? (
                      <>
                        {' '}
                        <a href={photoUrl.get(i.photo_path) ?? '#'} target="_blank" rel="noreferrer">Photo</a>
                      </>
                    ) : null}
                  </td>
                  <td>
                    {resolvedView ? (
                      <span className="muted">{i.resolution?.replace('_', ' ')} {i.resolved_at ? when(i.resolved_at) : ''}{i.resolved_by_name ? ` · ${i.resolved_by_name}` : ''}</span>
                    ) : canResolve ? (
                      <ActionForm action={resolveIssue} submit="Resolve" small inline>
                        <input type="hidden" name="id" value={i.id} />
                        <select name="resolution" defaultValue="repaired" aria-label="How it was resolved">
                          <option value="repaired">Repaired</option>
                          <option value="found">Found</option>
                          <option value="replaced">Replaced</option>
                          <option value="written_off">Written off</option>
                        </select>
                      </ActionForm>
                    ) : null}
                  </td>
                </tr>
              ))}
              {(issues ?? []).length === 0 && (
                <tr><td colSpan={6} className="muted">{resolvedView ? 'Nothing resolved yet.' : 'No open issues.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
