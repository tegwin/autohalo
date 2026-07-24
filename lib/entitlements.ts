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
  /** Trial (sample) runs still available. Infinity for admin/unlimited. */
  trialsRemaining: number
}

export async function entitlementStatus(
  orgId: string,
  isPlatformAdmin: boolean,
): Promise<EntitlementStatus> {
  const supabase = createAdminClient()

  const { data: org } = await supabase
    .from('orgs')
    .select('unlimited, trial_runs_remaining')
    .eq('id', orgId)
    .single<{ unlimited: boolean; trial_runs_remaining: number }>()

  if (isPlatformAdmin) {
    return { available: Infinity, unlimited: true, reason: 'admin', trialsRemaining: Infinity }
  }
  if (org?.unlimited) {
    return { available: Infinity, unlimited: true, reason: 'unlimited', trialsRemaining: Infinity }
  }

  const { count } = await supabase
    .from('entitlements')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .is('consumed_by_run_id', null)

  const available = count ?? 0
  return {
    available,
    unlimited: false,
    reason: available > 0 ? 'purchased' : 'none',
    trialsRemaining: org?.trial_runs_remaining ?? 0,
  }
}

/**
 * Spend one trial run. Trials copy a small real sample so the customer can see
 * the result before paying; each org gets one by default. Returns false when
 * none remain, so a customer cannot loop trials to migrate everything for free.
 */
export async function consumeTrialRun(
  orgId: string,
  opts: { isPlatformAdmin: boolean },
): Promise<boolean> {
  if (opts.isPlatformAdmin) return true
  const supabase = createAdminClient()
  const { data, error } = await supabase.rpc('consume_trial_run', { p_org_id: orgId })
  if (error) throw new Error(`Could not check your trial allowance: ${error.message}`)
  return data === true
}

/** Admin: give an org more trial runs (the "unlock one more" action). */
export async function grantTrialRuns(orgId: string, count = 1): Promise<void> {
  const supabase = createAdminClient()
  const { error } = await supabase.rpc('grant_trial_runs', {
    p_org_id: orgId,
    p_count: Math.max(1, Math.min(count, 100)),
  })
  if (error) throw new Error(`Could not grant trial runs: ${error.message}`)
}

/**
 * Atomically claims an entitlement for a run. Returns false when the org has
 * nothing to spend, in which case the caller must not start the run.
 *
 * Live runs only — trials spend a separate allowance (see consumeTrialRun).
 */
export async function consumeEntitlement(
  orgId: string,
  runId: string,
  opts: { isPlatformAdmin: boolean },
): Promise<boolean> {
  if (opts.isPlatformAdmin) return true

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
