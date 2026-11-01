import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Runs before every page. Keeps the sign-in fresh and enforces, in order:
//   signed in -> account active -> password changed -> admin two-factor -> admin-only pages.
// Pages and server actions check again; this is the first gate, not the only one.

const PUBLIC_PATHS = ['/login']

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(list) {
          list.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
        },
      },
    },
  )

  const go = (path: string) => {
    const redirect = NextResponse.redirect(new URL(path, request.url))
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c))
    return redirect
  }

  const path = request.nextUrl.pathname
  const { data } = await supabase.auth.getClaims()
  const claims = data?.claims as { sub?: string; aal?: string } | undefined

  if (!claims?.sub) {
    return PUBLIC_PATHS.includes(path) ? response : go('/login')
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, active, must_change_password')
    .eq('id', claims.sub)
    .single()

  if (!profile || !profile.active) {
    await supabase.auth.signOut()
    return PUBLIC_PATHS.includes(path) ? response : go('/login?error=inactive')
  }

  if (path === '/login') return go('/')

  if (profile.must_change_password && path !== '/change-password') return go('/change-password')

  const isAdmin = profile.role === 'admin'
  const aal2 = claims.aal === 'aal2'
  if (!profile.must_change_password && isAdmin && !aal2 && path !== '/mfa' && path !== '/change-password') {
    return go('/mfa')
  }
  if (path === '/mfa' && (!isAdmin || aal2)) return go('/')
  if (path.startsWith('/admin') && !(isAdmin && aal2)) return go('/')

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icon.*|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
}
