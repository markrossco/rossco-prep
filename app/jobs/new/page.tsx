import Link from 'next/link'
import { redirect } from 'next/navigation'
import Topbar from '@/components/topbar'
import ActionForm from '@/components/action-form'
import { requireSession } from '@/lib/session'
import { isOffice } from '@/lib/roles'
import { createJob } from '../actions'
import JobFields from '../job-fields'

export default async function NewJobPage() {
  const { profile, supabase } = await requireSession()
  if (!isOffice(profile.role)) redirect('/jobs')

  const [{ data: clients }, { data: venues }] = await Promise.all([
    supabase.from('organisations').select('name').is('archived_at', null).eq('active', true).order('name').limit(3000),
    supabase.from('venues').select('name').is('archived_at', null).eq('active', true).order('name').limit(3000),
  ])

  return (
    <>
      <Topbar name={profile.full_name} role={profile.role} />
      <div className="shell">
        <h1>New job</h1>
        <p className="lead">
          <Link href="/">Home</Link> · <Link href="/jobs">Jobs</Link>
        </p>
        <section className="card" style={{ maxWidth: 760 }}>
          <ActionForm action={createJob} submit="Create the job">
            <JobFields
              idPrefix="new"
              withStatus
              clients={(clients ?? []).map((c) => c.name)}
              venues={(venues ?? []).map((v) => v.name)}
            />
          </ActionForm>
        </section>
        <p className="muted" style={{ marginTop: 12 }}>You add the equipment on the next screen.</p>
      </div>
    </>
  )
}
