import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { canManage, getSessionContext } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { pingWorker } from '@/lib/worker-ping'

export const runtime = 'nodejs'

const actionSchema = z.object({ action: z.enum(['pause', 'resume', 'cancel', 'retry_failed']) })

/** Live status for the run dashboard: run, per-entity tasks, recent log tail. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getSessionContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const supabase = createAdminClient()

  const { data: run } = await supabase
    .from('migration_runs')
    .select('*')
    .eq('id', id)
    .eq('org_id', ctx.org.id)
    .maybeSingle()

  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [{ data: tasks }, { data: logs }, { count: failureCount }] = await Promise.all([
    supabase.from('run_tasks').select('*').eq('run_id', id).order('seq'),
    supabase.from('run_logs').select('*').eq('run_id', id).order('id', { ascending: false }).limit(100),
    supabase.from('run_failures').select('id', { count: 'exact', head: true }).eq('run_id', id),
  ])

  return NextResponse.json({
    run,
    tasks: tasks ?? [],
    logs: (logs ?? []).reverse(),
    failureCount: failureCount ?? 0,
  })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getSessionContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canManage(ctx)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const parsed = actionSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid action' }, { status: 400 })

  const supabase = createAdminClient()
  const { data: run } = await supabase
    .from('migration_runs')
    .select('id, status')
    .eq('id', id)
    .eq('org_id', ctx.org.id)
    .maybeSingle<{ id: string; status: string }>()

  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  switch (parsed.data.action) {
    case 'pause': {
      // The worker checks the status between records, so a pause takes effect
      // at the next record boundary rather than mid-write.
      await supabase.from('migration_runs').update({ status: 'paused' }).eq('id', id)
      break
    }
    case 'resume': {
      await supabase
        .from('migration_runs')
        .update({ status: 'queued', leased_until: null, lease_holder: null })
        .eq('id', id)
      void pingWorker()
      break
    }
    case 'cancel': {
      await supabase
        .from('migration_runs')
        .update({ status: 'cancelled', finished_at: new Date().toISOString(), leased_until: null })
        .eq('id', id)
      break
    }
    case 'retry_failed': {
      // Reset only the entities that failed. Everything already written is
      // protected by id_map, so a retry tops up rather than duplicating.
      await supabase
        .from('run_tasks')
        .update({ status: 'pending', attempts: 0, last_error: null, next_attempt_at: null, finished_at: null })
        .eq('run_id', id)
        .eq('status', 'failed')

      await supabase
        .from('migration_runs')
        .update({ status: 'queued', error: null, finished_at: null, leased_until: null })
        .eq('id', id)
      void pingWorker()
      break
    }
  }

  await supabase.from('run_logs').insert({
    run_id: id,
    org_id: ctx.org.id,
    level: 'info',
    message: `Run ${parsed.data.action.replace('_', ' ')} requested by ${ctx.profile.email}.`,
  })

  return NextResponse.json({ ok: true })
}
