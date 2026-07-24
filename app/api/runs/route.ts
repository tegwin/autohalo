import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { canManage, getSessionContext } from '@/lib/auth'
import { consumeEntitlement, consumeTrialRun } from '@/lib/entitlements'
import { seedRunTasks } from '@/lib/migration/engine'
import { withDependencies } from '@/lib/migration/handlers'
import { createAdminClient } from '@/lib/supabase/admin'
import type { MigrationRun } from '@/lib/types'
import { pingWorker } from '@/lib/worker-ping'

export const runtime = 'nodejs'

const createSchema = z.object({
  sourceConnection: z.string().uuid(),
  targetConnection: z.string().uuid(),
  direction: z.enum(['autotask_to_halo', 'halo_to_autotask']),
  mode: z.enum(['dry_run', 'live']),
  entities: z.array(z.string()).min(1),
  since: z.string().optional(),
  until: z.string().optional(),
  companyIds: z.array(z.string()).optional(),
  recordIds: z.record(z.string(), z.array(z.string())).optional(),
  options: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
})

export async function POST(request: NextRequest) {
  const ctx = await getSessionContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canManage(ctx)) {
    return NextResponse.json({ error: 'You need admin rights to start a migration' }, { status: 403 })
  }

  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 400 })
  }
  const body = parsed.data

  if (body.sourceConnection === body.targetConnection) {
    return NextResponse.json(
      { error: 'Source and target must be different connections' },
      { status: 400 },
    )
  }

  const supabase = createAdminClient()

  // Both connections must belong to this org. The service-role client would
  // happily read another tenant's rows, so this check is the boundary.
  const { data: connections } = await supabase
    .from('connections')
    .select('id, system')
    .eq('org_id', ctx.org.id)
    .in('id', [body.sourceConnection, body.targetConnection])

  if (!connections || connections.length !== 2) {
    return NextResponse.json({ error: 'Unknown connection' }, { status: 400 })
  }

  const expectedSource = body.direction === 'autotask_to_halo' ? 'autotask' : 'halo'
  const source = connections.find((c) => (c as { id: string }).id === body.sourceConnection) as
    | { id: string; system: string }
    | undefined
  if (source?.system !== expectedSource) {
    return NextResponse.json(
      { error: `The source connection must be a ${expectedSource} connection for this direction` },
      { status: 400 },
    )
  }

  const { entities, added } = withDependencies(body.direction, body.entities)

  // A trial samples 5 records of each type. It honours the company selection
  // (so you can preview a specific customer) but not date ranges, which do not
  // apply to a fixed-size sample. A live run honours everything.
  const isDryRun = body.mode === 'dry_run'
  const selection = isDryRun
    ? { entities, companyIds: body.companyIds, recordIds: body.recordIds, options: body.options }
    : {
        entities,
        since: body.since,
        until: body.until,
        companyIds: body.companyIds,
        recordIds: body.recordIds,
        options: body.options,
      }

  const { data: run, error } = await supabase
    .from('migration_runs')
    .insert({
      org_id: ctx.org.id,
      created_by: ctx.userId,
      source_connection: body.sourceConnection,
      target_connection: body.targetConnection,
      direction: body.direction,
      mode: body.mode,
      status: 'draft',
      selection,
    })
    .select('*')
    .single<MigrationRun>()

  if (error || !run) {
    return NextResponse.json({ error: error?.message ?? 'Could not create the run' }, { status: 400 })
  }

  // Seed the work first: if queueing fails we reject before spending anything,
  // so neither a trial allowance nor a paid credit can leak on error.
  try {
    await seedRunTasks(run)
  } catch (err) {
    await supabase.from('migration_runs').delete().eq('id', run.id)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Could not queue the run' },
      { status: 400 },
    )
  }

  // Then charge, per mode. A trial spends one trial allowance; a live run
  // spends one purchased/granted credit. Platform admins spend neither.
  if (isDryRun) {
    const allowed = await consumeTrialRun(ctx.org.id, { isPlatformAdmin: ctx.isPlatformAdmin })
    if (!allowed) {
      await supabase.from('migration_runs').delete().eq('id', run.id)
      return NextResponse.json(
        {
          error:
            'You have used your free trial run. Purchase a live migration to move everything, or ask an administrator to unlock another trial.',
          code: 'trial_exhausted',
        },
        { status: 402 },
      )
    }
  } else {
    const allowed = await consumeEntitlement(ctx.org.id, run.id, {
      isPlatformAdmin: ctx.isPlatformAdmin,
    })
    if (!allowed) {
      await supabase.from('migration_runs').delete().eq('id', run.id)
      return NextResponse.json(
        {
          error: 'No migration credit available. Purchase one to run a live migration.',
          code: 'payment_required',
        },
        { status: 402 },
      )
    }
  }

  await supabase.from('migration_runs').update({ status: 'queued' }).eq('id', run.id)
  await supabase.from('run_logs').insert({
    run_id: run.id,
    org_id: ctx.org.id,
    level: 'info',
    message: `Run queued (${isDryRun ? 'trial — 5 random of each' : 'live'}) covering: ${entities.join(', ')}.`,
  })

  // Cron ticks once a minute; nudging the worker makes the UI feel immediate.
  void pingWorker()

  return NextResponse.json({ runId: run.id, entities, addedDependencies: added })
}
