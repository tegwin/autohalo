import Link from 'next/link'
import { requirePlatformAdmin } from '@/lib/auth'
import { AdminOrgTable } from '@/components/admin-org-table'
import { createAdminClient } from '@/lib/supabase/admin'
import { RunStatusBadge } from '@/components/status-badge'
import type { MigrationRun } from '@/lib/types'

export const dynamic = 'force-dynamic'

export interface AdminOrgRow {
  id: string
  name: string
  slug: string
  unlimited: boolean
  created_at: string
  members: { email: string; role: string; is_platform_admin: boolean }[]
  creditsAvailable: number
  runCount: number
}

export default async function AdminPage() {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const [{ data: orgs }, { data: memberships }, { data: entitlements }, { data: runs }] =
    await Promise.all([
      supabase.from('orgs').select('*').order('created_at', { ascending: false }),
      supabase.from('memberships').select('org_id, role, profiles(email, is_platform_admin)'),
      supabase.from('entitlements').select('org_id, consumed_by_run_id'),
      supabase
        .from('migration_runs')
        .select('id, org_id, direction, mode, status, created_at, stats')
        .order('created_at', { ascending: false })
        .limit(25),
    ])

  const membersByOrg = new Map<string, AdminOrgRow['members']>()
  for (const row of (memberships ?? []) as {
    org_id: string
    role: string
    profiles: { email: string; is_platform_admin: boolean } | null
  }[]) {
    if (!row.profiles) continue
    const list = membersByOrg.get(row.org_id) ?? []
    list.push({
      email: row.profiles.email,
      role: row.role,
      is_platform_admin: row.profiles.is_platform_admin,
    })
    membersByOrg.set(row.org_id, list)
  }

  const creditsByOrg = new Map<string, number>()
  for (const row of (entitlements ?? []) as { org_id: string; consumed_by_run_id: string | null }[]) {
    if (row.consumed_by_run_id) continue
    creditsByOrg.set(row.org_id, (creditsByOrg.get(row.org_id) ?? 0) + 1)
  }

  const runsByOrg = new Map<string, number>()
  const recentRuns = (runs ?? []) as (MigrationRun & { org_id: string })[]
  for (const run of recentRuns) {
    runsByOrg.set(run.org_id, (runsByOrg.get(run.org_id) ?? 0) + 1)
  }

  const orgRows: AdminOrgRow[] = ((orgs ?? []) as AdminOrgRow[]).map((org) => ({
    ...org,
    members: membersByOrg.get(org.id) ?? [],
    creditsAvailable: creditsByOrg.get(org.id) ?? 0,
    runCount: runsByOrg.get(org.id) ?? 0,
  }))

  const orgNames = new Map(orgRows.map((o) => [o.id, o.name]))

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Admin</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-600 dark:text-ink-400">
          Grant credits, switch an organisation to unlimited, and watch every run on the platform.
          Your own account bypasses billing entirely.
        </p>
      </div>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Organisations</h2>
        <AdminOrgTable orgs={orgRows} />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Recent runs across all organisations</h2>
        {recentRuns.length === 0 ? (
          <div className="card text-sm text-ink-600 dark:text-ink-400">No runs yet.</div>
        ) : (
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Organisation</th>
                  <th>Direction</th>
                  <th>Mode</th>
                  <th>Status</th>
                  <th>Result</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {recentRuns.map((run) => (
                  <tr key={run.id}>
                    <td className="whitespace-nowrap">
                      {new Date(run.created_at).toLocaleString('en-GB')}
                    </td>
                    <td>{orgNames.get(run.org_id) ?? run.org_id}</td>
                    <td className="whitespace-nowrap">
                      {run.direction === 'autotask_to_halo' ? 'AT → Halo' : 'Halo → AT'}
                    </td>
                    <td>{run.mode === 'dry_run' ? 'Dry' : 'Live'}</td>
                    <td>
                      <RunStatusBadge status={run.status} />
                    </td>
                    <td className="whitespace-nowrap text-ink-600 dark:text-ink-400">
                      {run.stats?.created ?? 0}c / {run.stats?.failed ?? 0}f
                    </td>
                    <td>
                      <Link href={`/migrations/${run.id}`} className="font-medium text-brand-600 hover:underline">
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
