import { notFound } from 'next/navigation'
import { canManage, requireSession } from '@/lib/auth'
import { RunMonitor } from '@/components/run-monitor'
import { createAdminClient } from '@/lib/supabase/admin'
import type { MigrationRun, RunFailure } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await requireSession()
  const supabase = createAdminClient()

  const { data: run } = await supabase
    .from('migration_runs')
    .select('*')
    .eq('id', id)
    .eq('org_id', ctx.org.id)
    .maybeSingle<MigrationRun>()

  if (!run) notFound()

  const { data: failures } = await supabase
    .from('run_failures')
    .select('*')
    .eq('run_id', id)
    .order('created_at', { ascending: false })
    .limit(200)

  return (
    <RunMonitor
      runId={id}
      initialRun={run}
      failures={(failures ?? []) as RunFailure[]}
      canManage={canManage(ctx)}
    />
  )
}
