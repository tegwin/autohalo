import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * Email confirmation and magic-link landing point. Exchanges the one-time code
 * for a session cookie, then sends the user into the app.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  const next = request.nextUrl.searchParams.get('next') ?? '/dashboard'

  if (!code) {
    return NextResponse.redirect(new URL('/login?error=Missing+confirmation+code', request.url))
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(error.message)}`, request.url),
    )
  }

  // Only ever redirect within this app.
  const target = next.startsWith('/') ? next : '/dashboard'
  return NextResponse.redirect(new URL(target, request.url))
}
