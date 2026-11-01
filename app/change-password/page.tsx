import { requireSession } from '@/lib/session'
import ChangePasswordForm from './form'

export default async function ChangePasswordPage() {
  const { profile } = await requireSession()
  return (
    <main className="narrow">
      <ChangePasswordForm forced={profile.must_change_password} />
    </main>
  )
}
