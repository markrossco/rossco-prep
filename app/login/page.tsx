import LoginForm from './login-form'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  const notice = error === 'inactive' ? 'This account is switched off. Ask an admin.' : undefined
  return (
    <main className="narrow">
      <LoginForm notice={notice} />
    </main>
  )
}
