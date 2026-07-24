import Link from 'next/link'
import { ArrowRight, Cable, Play } from 'lucide-react'
import { requireSession } from '@/lib/auth'
import { RunStatusBadge } from '@/components/status-badge'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Connection, MigrationRun } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const ctx = await requireSession()
  const supabase = createAdminClient()

  const [{ data: runs }, { data: connections }] = await Promise.all([
    supabase
      .from('migration_runs')
      .select('*')
      .eq('org_id', ctx.org.id)
      .order('created_at', { ascending: false })
      .limit(15),
    supabase.from('connections').select('id, system, label, last_verified_at').eq('org_id', ctx.org.id),
  ])

  const runList = (runs ?? []) as MigrationRun[]
  const connectionList = (connections ?? []) as Pick<Connection, 'id' | 'system' | 'label' | 'last_verified_at'>[]
  const hasAutotask = connectionList.some((c) => c.system === 'autotask')
  const hasHalo = connectionList.some((c) => c.system === 'halo')
  const ready = hasAutotask && hasHalo

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="mt-1 text-sm text-ink-600 dark:text-ink-400">
          {ready
            ? 'Both systems are connected. Start with a dry run to see exactly what would move.'
            : 'Connect Autotask and HaloPSA to get started.'}
        </p>
      </div>

      {!ready ? (
        <div className="card border-brand-200 bg-brand-50 dark:border-brand-700/40 dark:bg-brand-700/10">
          <h2 className="font-semibold">Set up your connections</h2>
          <ul className="mt-3 space-y-2 text-sm">
            <SetupStep done={hasAutotask} label="Autotask API user (username, secret, integration code)" />
            <SetupStep done={hasHalo} label="HaloPSA API application (client id and secret, scope: all)" />
          </ul>
          <Link href="/connections" className="btn-primary mt-4">
            <Cable className="h-4 w-4" /> Add a connection
          </Link>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          <Link href="/migrations/new" className="btn-primary">
            <Play className="h-4 w-4" /> Start a migration
          </Link>
          <Link href="/connections" className="btn-secondary">
            Manage connections
          </Link>
        </div>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold">Recent runs</h2>
        {runList.length === 0 ? (
          <div className="card text-sm text-ink-600 dark:text-ink-400">
            No migrations yet. A dry run costs nothing and validates the whole mapping.
          </div>
        ) : (
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Direction</th>
                  <th>Mode</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runList.map((run) => (
                  <tr key={run.id}>
                    <td className="whitespace-nowrap">
                      {new Date(run.created_at).toLocaleString('en-GB')}
                    </td>
                    <td className="whitespace-nowrap">
                      {run.direction === 'autotask_to_halo' ? 'Autotask → Halo' : 'Halo → Autotask'}
                    </td>
                    <td>{run.mode === 'dry_run' ? 'Dry run' : 'Live'}</td>
                    <td>
                      <RunStatusBadge status={run.status} />
                    </td>
                    <td className="whitespace-nowrap text-ink-600 dark:text-ink-400">
                      {run.stats?.created ?? 0} created · {run.stats?.updated ?? 0} updated ·{' '}
                      {run.stats?.failed ?? 0} failed
                    </td>
                    <td>
                      <Link
                        href={`/migrations/${run.id}`}
                        className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline"
                      >
                        Open <ArrowRight className="h-3.5 w-3.5" />
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

function SetupStep({ done, label }: { done: boolean; label: string }) {
  return (
    <li className="flex items-start gap-2">
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
          done ? 'bg-emerald-500 text-white' : 'border border-ink-300 text-ink-400 dark:border-ink-600'
        }`}
      >
        {done ? '✓' : ''}
      </span>
      <span className={done ? 'text-ink-500 line-through dark:text-ink-400' : ''}>{label}</span>
    </li>
  )
}
