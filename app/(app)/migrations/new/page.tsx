import Link from 'next/link'
import { canManage, requireSession } from '@/lib/auth'
import { entitlementStatus } from '@/lib/entitlements'
import { availableEntities } from '@/lib/migration/handlers'
import { MigrationWizard } from '@/components/migration-wizard'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Connection } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function NewMigrationPage() {
  const ctx = await requireSession()
  const supabase = createAdminClient()

  const [{ data: connections }, credits] = await Promise.all([
    supabase
      .from('connections')
      .select('id, org_id, system, label, config, last_verified_at, last_verify_error, created_at, updated_at')
      .eq('org_id', ctx.org.id)
      .order('created_at'),
    entitlementStatus(ctx.org.id, ctx.isPlatformAdmin),
  ])

  const list = (connections ?? []) as Connection[]

  if (list.filter((c) => c.system === 'autotask').length === 0 || list.filter((c) => c.system === 'halo').length === 0) {
    return (
      <div className="card">
        <h1 className="text-lg font-semibold">Connect both systems first</h1>
        <p className="mt-1 text-sm text-ink-600 dark:text-ink-400">
          A migration needs one Autotask connection and one HaloPSA connection.
        </p>
        <Link href="/connections" className="btn-primary mt-4">
          Go to connections
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">New migration</h1>
        <p className="mt-1 text-sm text-ink-600 dark:text-ink-400">
          Dry runs are free and unlimited — they read everything and prove the mapping without
          writing a single record.
        </p>
      </div>

      <MigrationWizard
        connections={list}
        entitiesByDirection={{
          autotask_to_halo: availableEntities('autotask_to_halo'),
          halo_to_autotask: availableEntities('halo_to_autotask'),
        }}
        credits={{
          available: Number.isFinite(credits.available) ? credits.available : -1,
          reason: credits.reason,
          trialsRemaining: Number.isFinite(credits.trialsRemaining) ? credits.trialsRemaining : -1,
        }}
        canManage={canManage(ctx)}
      />
    </div>
  )
}
