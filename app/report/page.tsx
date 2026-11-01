import Link from 'next/link'
import Topbar from '@/components/topbar'
import ActionForm from '@/components/action-form'
import PhotoField from '@/components/photo-field'
import { requireSession } from '@/lib/session'
import { reportIssue } from '../issues/actions'

export default async function ReportPage() {
  const { profile, supabase } = await requireSession()
  const [{ data: names }, { data: jobs }] = await Promise.all([
    supabase.from('equipment_types').select('name').eq('kind', 'stock').eq('active', true).is('archived_at', null).order('name').limit(3000),
    supabase
      .from('jobs')
      .select('id, ref, name')
      .is('archived_at', null)
      .in('status', ['confirmed', 'prepping', 'prepped', 'out', 'returned'])
      .order('out_date', { ascending: false })
      .limit(60),
  ])

  return (
    <>
      <Topbar name={profile.full_name} role={profile.role} />
      <div className="shell">
        <h1>Report lost or damaged kit</h1>
        <p className="lead"><Link href="/">Home</Link> · <Link href="/issues">All issues</Link></p>
        <section className="card" style={{ maxWidth: 640 }}>
          <ActionForm action={reportIssue} submit="Send the report" clearOnSuccess>
            <label htmlFor="item_name">Item</label>
            <input id="item_name" name="item_name" list="report-items" autoComplete="off" placeholder="Start typing the name" />
            <datalist id="report-items">
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
            </div>
            <label htmlFor="asset_no">Asset number (only if it has one)</label>
            <input id="asset_no" name="asset_no" autoComplete="off" />
            <label htmlFor="job_id">Which job (optional)</label>
            <select id="job_id" name="job_id" defaultValue="">
              <option value="">Not from a job</option>
              {(jobs ?? []).map((j) => (
                <option key={j.id} value={j.id}>{j.ref} · {j.name}</option>
              ))}
            </select>
            <label htmlFor="note">What is wrong</label>
            <input id="note" name="note" autoComplete="off" />
            <PhotoField />
          </ActionForm>
        </section>
      </div>
    </>
  )
}
