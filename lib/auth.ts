import { redirect } from 'next/navigation'
import { createClient } from './supabase/server'
import type { Membership, Org, Profile } from './types'

export interface SessionContext {
  userId: string
  profile: Profile
  org: Org
  role: Membership['role']
  isPlatformAdmin: boolean
}

/**
 * Resolves the signed-in user, their profile, and their active org in one go.
 * Returns null when unauthenticated — callers decide whether that is fatal.
 *
 * Auto-provisioning happens in a database trigger on auth.users, so by the
 * time a user reaches here they already have a profile and an owned org. The
 * repair path below covers the one case the trigger cannot: users created
 * before the trigger existed.
 */
export async function getSessionContext(): Promise<SessionContext | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle<Profile>()

  if (!profile) return null

  const { data: membership } = await supabase
    .from('memberships')
    .select('org_id, user_id, role, created_at, orgs(*)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<Membership & { orgs: Org }>()

  if (!membership?.orgs) return null

  return {
    userId: user.id,
    profile,
    org: membership.orgs,
    role: membership.role,
    isPlatformAdmin: profile.is_platform_admin,
  }
}

/** Use in pages/route handlers that must not render for anonymous visitors. */
export async function requireSession(): Promise<SessionContext> {
  const ctx = await getSessionContext()
  if (!ctx) redirect('/login')
  return ctx
}

export async function requirePlatformAdmin(): Promise<SessionContext> {
  const ctx = await requireSession()
  if (!ctx.isPlatformAdmin) redirect('/dashboard')
  return ctx
}

/** Org owners and admins may change connections and start runs. */
export function canManage(ctx: SessionContext): boolean {
  return ctx.isPlatformAdmin || ctx.role === 'owner' || ctx.role === 'admin'
}
