import { createAdminClient } from './supabase/admin'

/**
 * Billing gate.
 *
 * One purchase buys one migration run. The entitlement is consumed when a run
 * leaves draft, not when it completes — otherwise a customer could start
 * unlimited runs and only ever "pay" for the one that finishes.
 *
 * Three ways past the till, all deliberate:
 *   - orgs.unlimited, set by a platform admin for an org
 *   - an admin_grant entitlement, for one-off comps and re-runs after a failure
 *   - profiles.is_platform_admin, which bypasses the check entirely
 */

export interface EntitlementStatus {
  available: number
  unlimited: boolean
  reason: 'unlimited' | 'admin' | 'purchased' | 'none'
}

export async function entitlementStatus(
  orgId: string,
  isPlatformAdmin: boolean,
): Promise<EntitlementStatus> {
  const supabase = createAdminClient()

  const { data: org } = await supabase
    .from('orgs')
    .select('unlimited')
    .eq('id', orgId)
    .single<{ unlimited: boolean }>()

  if (isPlatformAdmin) return { available: Infinity, unlimited: true, reason: 'admin' }
  if (org?.unlimited) return { available: Infinity, unlimited: true, reason: 'unlimited' }

  const { count } = await supabase
    .from('entitlements')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .is('consumed_by_run_id', null)

  const available = count ?? 0
  return { available, unlimited: false, reason: available > 0 ? 'purchased' : 'none' }
}

/**
 * Atomically claims an entitlement for a run. Returns false when the org has
 * nothing to spend, in which case the caller must not start the run.
 *
 * Dry runs never consume: a customer should be able to prove the mapping works
 * before paying, and charging for a rehearsal would push people to skip it.
 */
export async function consumeEntitlement(
  orgId: string,
  runId: string,
  opts: { isPlatformAdmin: boolean; dryRun: boolean },
): Promise<boolean> {
  if (opts.isPlatformAdmin || opts.dryRun) return true

  const supabase = createAdminClient()
  const { data, error } = await supabase.rpc('consume_entitlement', {
    p_org_id: orgId,
    p_run_id: runId,
  })

  if (error) throw new Error(`Could not check your licence: ${error.message}`)
  return data === true
}

/** Admin-issued credit. Recorded with who granted it and why. */
export async function grantEntitlement(
  orgId: string,
  grantedBy: string,
  note: string,
  quantity = 1,
): Promise<void> {
  const supabase = createAdminClient()
  const rows = Array.from({ length: Math.max(1, Math.min(quantity, 100)) }, () => ({
    org_id: orgId,
    kind: 'admin_grant' as const,
    granted_by: grantedBy,
    note,
  }))
  const { error } = await supabase.from('entitlements').insert(rows)
  if (error) throw new Error(`Could not grant entitlement: ${error.message}`)
}
