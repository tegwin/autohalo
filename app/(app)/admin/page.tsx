import { requirePlatformAdmin } from '@/lib/auth'
import { AdminOrgTable } from '@/components/admin-org-table'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

export interface AdminMember {
  userId: string
  email: string
  fullName: string | null
  role: string
  isPlatformAdmin: boolean
  signedUpAt: string | null
  lastSignInAt: string | null
}

export interface AdminOrgRow {
  id: string
  name: string
  slug: string
  unlimited: boolean
  trial_runs_remaining: number
  created_at: string
  members: AdminMember[]
  creditsAvailable: number
  runCount: number
}

/**
 * Platform admin console.
 *
 * Deliberately account-level only. It shows who has signed up, when they last
 * logged in, and their billing status — and lets an admin grant credits or
 * switch an org to free/unlimited. It intentionally exposes NONE of a tenant's
 * migrated data, run logs, failed-record details, or PSA API credentials:
 *  - connection secrets are never selected (and are encrypted regardless);
 *  - run counts are shown as bare numbers, not their contents;
 *  - there is no link into any other org's run, logs or records.
 */
export default async function AdminPage() {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const [{ data: orgs }, { data: memberships }, { data: entitlements }, { data: runs }, authList] =
    await Promise.all([
      supabase.from('orgs').select('*').order('created_at', { ascending: false }),
      supabase.from('memberships').select('org_id, role, profiles(id, email, full_name, is_platform_admin, created_at)'),
      supabase.from('entitlements').select('org_id, consumed_by_run_id'),
      // Only org_id — enough to count runs per org, nothing about their content.
      supabase.from('migration_runs').select('org_id'),
      // last_sign_in_at lives on the auth user, reachable only via service role.
      supabase.auth.admin.listUsers({ perPage: 1000 }),
    ])

  const lastSignInById = new Map<string, string | null>()
  for (const user of authList.data?.users ?? []) {
    lastSignInById.set(user.id, user.last_sign_in_at ?? null)
  }

  const membersByOrg = new Map<string, AdminMember[]>()
  for (const row of (memberships ?? []) as {
    org_id: string
    role: string
    profiles: {
      id: string
      email: string
      full_name: string | null
      is_platform_admin: boolean
      created_at: string
    } | null
  }[]) {
    if (!row.profiles) continue
    const list = membersByOrg.get(row.org_id) ?? []
    list.push({
      userId: row.profiles.id,
      email: row.profiles.email,
      fullName: row.profiles.full_name,
      role: row.role,
      isPlatformAdmin: row.profiles.is_platform_admin,
      signedUpAt: row.profiles.created_at,
      lastSignInAt: lastSignInById.get(row.profiles.id) ?? null,
    })
    membersByOrg.set(row.org_id, list)
  }

  const creditsByOrg = new Map<string, number>()
  for (const row of (entitlements ?? []) as { org_id: string; consumed_by_run_id: string | null }[]) {
    if (row.consumed_by_run_id) continue
    creditsByOrg.set(row.org_id, (creditsByOrg.get(row.org_id) ?? 0) + 1)
  }

  const runsByOrg = new Map<string, number>()
  for (const row of (runs ?? []) as { org_id: string }[]) {
    runsByOrg.set(row.org_id, (runsByOrg.get(row.org_id) ?? 0) + 1)
  }

  const orgRows: AdminOrgRow[] = ((orgs ?? []) as AdminOrgRow[]).map((org) => ({
    ...org,
    members: membersByOrg.get(org.id) ?? [],
    creditsAvailable: creditsByOrg.get(org.id) ?? 0,
    runCount: runsByOrg.get(org.id) ?? 0,
  }))

  const totalAccounts = orgRows.reduce((sum, org) => sum + org.members.length, 0)

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Accounts</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-600 dark:text-ink-400">
          Every account that has signed up, with its billing status. Grant migration credits or
          switch an organisation to free/unlimited from here. You can see who has an account and
          what they are billed — never their PSA credentials, their migrated data, or their run
          contents.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <Stat label="Accounts" value={totalAccounts} />
        <Stat label="Organisations" value={orgRows.length} />
        <Stat label="Unlimited orgs" value={orgRows.filter((o) => o.unlimited).length} />
      </div>

      <AdminOrgTable orgs={orgRows} />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card min-w-[8rem]">
      <p className="hint">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
    </div>
  )
}
