import { canManage, requireSession } from '@/lib/auth'
import { ConnectionManager } from '@/components/connection-manager'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Connection } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function ConnectionsPage() {
  const ctx = await requireSession()
  const supabase = createAdminClient()

  // Secrets are deliberately not selected — nothing here needs them, and the
  // browser must never receive them.
  const { data } = await supabase
    .from('connections')
    .select('id, org_id, system, label, config, last_verified_at, last_verify_error, created_at, updated_at')
    .eq('org_id', ctx.org.id)
    .order('created_at')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Connections</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-600 dark:text-ink-400">
          Credentials are encrypted with AES-256-GCM before they are stored and are only ever
          decrypted on the server while a migration is running. They are never sent back to the
          browser, not even to you.
        </p>
      </div>

      <ConnectionManager
        initial={(data ?? []) as Connection[]}
        canManage={canManage(ctx)}
      />
    </div>
  )
}
