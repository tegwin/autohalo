import { createClient } from '@supabase/supabase-js'
import type { Database } from '../database.types'
import { serverEnv } from '../env'

/**
 * Service-role client. Bypasses RLS entirely, so it must only ever be used
 * from server-only code paths (the worker, Stripe webhooks, the admin portal
 * after an explicit is_platform_admin check) and every query must filter by
 * org_id itself.
 */
let cached: ReturnType<typeof createClient<Database>> | null = null

export function createAdminClient() {
  if (cached) return cached
  const env = serverEnv()
  cached = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return cached
}
