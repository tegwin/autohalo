import { createAdminClient } from '../supabase/admin'
import { clientFor } from '../connectors/credentials'
import type { MigrationRun, RunStats, RunTask, TaskCursor } from '../types'
import { MigrationContext } from './context'
import { HANDLERS_BY_KEY, handlersFor } from './handlers'
import { clearLookupCaches } from './lookups'

/**
 * The worker loop.
 *
 * A Vercel function cannot run for hours, so a migration is executed as a
 * sequence of time-boxed slices. Each invocation:
 *   1. claims a run under a lease so two workers never touch the same one,
 *   2. processes tasks in dependency order until its deadline approaches,
 *   3. persists cursors and counters,
 *   4. leaves the run queued for the next tick.
 *
 * Nothing is held in memory between invocations, which is what makes this
 * survive cold starts, deploys and timeouts alike.
 */

/** Leave headroom to flush state before the platform kills the function. */
const SAFETY_MARGIN_MS = 8_000
const MAX_ATTEMPTS = 5

export interface WorkerResult {
  runId: string | null
  status: string
  entitiesTouched: string[]
  processed: number
  message: string
}

export async function processNextRun(budgetMs: number, holder: string): Promise<WorkerResult> {
  const supabase = createAdminClient()
  const deadline = Date.now() + budgetMs - SAFETY_MARGIN_MS

  const { data: runId, error: claimError } = await supabase.rpc('claim_run', {
    p_holder: holder,
    p_lease_seconds: Math.ceil(budgetMs / 1000) + 30,
  })

  if (claimError) throw new Error(`Could not claim a run: ${claimError.message}`)
  if (!runId) {
    return { runId: null, status: 'idle', entitiesTouched: [], processed: 0, message: 'No runs waiting' }
  }

  const { data: run } = await supabase
    .from('migration_runs')
    .select('*')
    .eq('id', runId)
    .single<MigrationRun>()

  if (!run) {
    return { runId: null, status: 'idle', entitiesTouched: [], processed: 0, message: 'Run vanished' }
  }

  try {
    return await executeRun(run, deadline, holder)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await supabase
      .from('migration_runs')
      .update({
        status: 'failed',
        error: message.slice(0, 4000),
        finished_at: new Date().toISOString(),
        leased_until: null,
      })
      .eq('id', run.id)

    await supabase.from('run_logs').insert({
      run_id: run.id,
      org_id: run.org_id,
      level: 'error',
      message: `Run failed: ${message}`,
    })

    return {
      runId: run.id,
      status: 'failed',
      entitiesTouched: [],
      processed: 0,
      message,
    }
  } finally {
    clearLookupCaches()
  }
}

async function executeRun(run: MigrationRun, deadline: number, holder: string): Promise<WorkerResult> {
  const supabase = createAdminClient()

  // Cancellation is cooperative: the UI flips the status and the worker
  // notices here rather than mid-write, so nothing is left half-applied.
  if (run.status === 'cancelled' || run.status === 'paused') {
    await supabase.from('migration_runs').update({ leased_until: null }).eq('id', run.id)
    return { runId: run.id, status: run.status, entitiesTouched: [], processed: 0, message: 'Run is not active' }
  }

  const [{ client: source }, { client: target }] = await Promise.all([
    clientFor(run.org_id, run.source_connection),
    clientFor(run.org_id, run.target_connection),
  ])

  const touched: string[] = []
  let processedTotal = 0

  for (;;) {
    if (Date.now() >= deadline) break

    const task = await nextTask(run.id)
    if (!task) {
      // No task is runnable *right now*, which is not the same as no work
      // left: a task waiting out its retry backoff is still outstanding.
      // Finishing here would report a half-done migration as complete.
      if (await hasOutstandingWork(run.id)) break

      await finishRun(run.id, run.org_id)
      return {
        runId: run.id,
        status: 'completed',
        entitiesTouched: touched,
        processed: processedTotal,
        message: 'Run complete',
      }
    }

    // Respect a pause or cancel issued while the previous task was running.
    const { data: fresh } = await supabase
      .from('migration_runs')
      .select('status')
      .eq('id', run.id)
      .single<{ status: string }>()

    if (fresh && fresh.status !== 'running' && fresh.status !== 'queued') {
      await supabase.from('migration_runs').update({ leased_until: null }).eq('id', run.id)
      return {
        runId: run.id,
        status: fresh.status,
        entitiesTouched: touched,
        processed: processedTotal,
        message: `Run ${fresh.status}`,
      }
    }

    const handler = HANDLERS_BY_KEY.get(task.entity)
    if (!handler || !handler.directions.includes(run.direction)) {
      await supabase
        .from('run_tasks')
        .update({ status: 'skipped', finished_at: new Date().toISOString() })
        .eq('id', task.id)
      continue
    }

    touched.push(task.entity)

    await supabase
      .from('run_tasks')
      .update({
        status: 'running',
        started_at: task.started_at ?? new Date().toISOString(),
        attempts: task.attempts + 1,
      })
      .eq('id', task.id)

    const ctx = new MigrationContext(run, source, target, deadline, task.entity)

    try {
      if (task.total_estimate === null && handler.estimate) {
        const estimate = await handler.estimate(ctx).catch(() => null)
        if (estimate !== null) {
          await supabase.from('run_tasks').update({ total_estimate: estimate }).eq('id', task.id)
        }
      }

      const slice = await handler.run(ctx, task.cursor ?? {})
      await ctx.flushLogs()

      processedTotal += slice.processed

      await supabase
        .from('run_tasks')
        .update({
          cursor: slice.cursor as unknown as Record<string, unknown>,
          processed: task.processed + slice.processed,
          created_count: task.created_count + slice.created,
          updated_count: task.updated_count + slice.updated,
          skipped_count: task.skipped_count + slice.skipped,
          failed_count: task.failed_count + slice.failed,
          status: slice.done ? 'succeeded' : 'pending',
          last_error: null,
          finished_at: slice.done ? new Date().toISOString() : null,
        })
        .eq('id', task.id)

      await bumpRunStats(run.id, slice)

      if (slice.done) {
        await supabase.from('run_logs').insert({
          run_id: run.id,
          org_id: run.org_id,
          level: 'info',
          entity: task.entity,
          message: `${handler.label} finished: ${task.created_count + slice.created} created, ${
            task.updated_count + slice.updated
          } updated, ${task.skipped_count + slice.skipped} skipped, ${
            task.failed_count + slice.failed
          } failed.`,
        })
      }
    } catch (err) {
      await ctx.flushLogs()
      const message = err instanceof Error ? err.message : String(err)
      const attempts = task.attempts + 1
      const giveUp = attempts >= MAX_ATTEMPTS

      await supabase
        .from('run_tasks')
        .update({
          status: giveUp ? 'failed' : 'pending',
          last_error: message.slice(0, 4000),
          // Exponential backoff so a rate-limited PSA is not hammered.
          next_attempt_at: giveUp
            ? null
            : new Date(Date.now() + Math.min(2 ** attempts * 15_000, 10 * 60_000)).toISOString(),
          finished_at: giveUp ? new Date().toISOString() : null,
        })
        .eq('id', task.id)

      await supabase.from('run_logs').insert({
        run_id: run.id,
        org_id: run.org_id,
        level: giveUp ? 'error' : 'warn',
        entity: task.entity,
        message: giveUp
          ? `${handler.label} failed after ${attempts} attempts: ${message}`
          : `${handler.label} hit an error (attempt ${attempts}), will retry: ${message}`,
      })

      if (!giveUp) break // Let the backoff elapse before trying again.
    }
  }

  // Out of time, not out of work. Release the lease and let the next tick
  // pick this run up exactly where it stopped.
  await supabase
    .from('migration_runs')
    .update({ status: 'queued', leased_until: null, lease_holder: null })
    .eq('id', run.id)
    .eq('lease_holder', holder)

  return {
    runId: run.id,
    status: 'queued',
    entitiesTouched: touched,
    processed: processedTotal,
    message: 'Slice complete, more work remaining',
  }
}

/** Next runnable task in dependency order, honouring retry backoff. */
async function nextTask(runId: string): Promise<RunTask | null> {
  const supabase = createAdminClient()
  const { data } = await supabase
    .from('run_tasks')
    .select('*')
    .eq('run_id', runId)
    .in('status', ['pending', 'running'])
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${new Date().toISOString()}`)
    .order('seq', { ascending: true })
    .limit(1)
    .maybeSingle<RunTask>()
  return data ?? null
}

/** Any task still pending or running, including those in retry backoff. */
async function hasOutstandingWork(runId: string): Promise<boolean> {
  const supabase = createAdminClient()
  const { count } = await supabase
    .from('run_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', runId)
    .in('status', ['pending', 'running'])
  return (count ?? 0) > 0
}

async function bumpRunStats(
  runId: string,
  slice: { processed: number; created: number; updated: number; skipped: number; failed: number },
): Promise<void> {
  const supabase = createAdminClient()
  const { data } = await supabase
    .from('migration_runs')
    .select('stats')
    .eq('id', runId)
    .single<{ stats: RunStats }>()

  const stats = data?.stats ?? {}
  await supabase
    .from('migration_runs')
    .update({
      stats: {
        processed: (stats.processed ?? 0) + slice.processed,
        created: (stats.created ?? 0) + slice.created,
        updated: (stats.updated ?? 0) + slice.updated,
        skipped: (stats.skipped ?? 0) + slice.skipped,
        failed: (stats.failed ?? 0) + slice.failed,
      },
    })
    .eq('id', runId)
}

async function finishRun(runId: string, orgId: string): Promise<void> {
  const supabase = createAdminClient()

  const { data: tasks } = await supabase
    .from('run_tasks')
    .select('status, failed_count')
    .eq('run_id', runId)

  const anyFailed = (tasks ?? []).some(
    (t) => (t as { status: string; failed_count: number }).status === 'failed',
  )

  await supabase
    .from('migration_runs')
    .update({
      status: anyFailed ? 'failed' : 'completed',
      finished_at: new Date().toISOString(),
      leased_until: null,
      lease_holder: null,
      error: anyFailed ? 'One or more entities failed. See the failures tab.' : null,
    })
    .eq('id', runId)

  await supabase.from('run_logs').insert({
    run_id: runId,
    org_id: orgId,
    level: anyFailed ? 'warn' : 'info',
    message: anyFailed
      ? 'Run finished with failures. Review the failed records and re-run to retry them.'
      : 'Run finished successfully.',
  })
}

/** Creates the task rows for a run, in dependency order. */
export async function seedRunTasks(run: MigrationRun): Promise<void> {
  const supabase = createAdminClient()
  const handlers = handlersFor(run.direction, run.selection.entities ?? [])

  if (!handlers.length) {
    throw new Error('No migratable entities were selected for this direction.')
  }

  const rows = handlers.map((handler) => ({
    run_id: run.id,
    org_id: run.org_id,
    entity: handler.key,
    phase: 'copy',
    seq: handler.seq,
    status: 'pending' as const,
  }))

  const { error } = await supabase.from('run_tasks').upsert(rows, { onConflict: 'run_id,entity,phase' })
  if (error) throw new Error(`Could not queue entities: ${error.message}`)
}

export function cursorIsEmpty(cursor: TaskCursor | null): boolean {
  return !cursor || Object.keys(cursor).length === 0
}
