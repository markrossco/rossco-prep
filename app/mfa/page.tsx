import { requireSession } from '@/lib/session'
import MfaForm from './mfa-form'

export default async function MfaPage() {
  await requireSession()
  return (
    <main className="narrow">
      <MfaForm />
    </main>
  )
}
