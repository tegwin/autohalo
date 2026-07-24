import { NextResponse, type NextRequest } from 'next/server'
import { safeEqual } from '@/lib/crypto'
import { serverEnv } from '@/lib/env'
import { processNextRun } from '@/lib/migration/engine'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Vercel Pro allows up to 300s; on Hobby this is clamped to 60s automatically.
export const maxDuration = 300

/**
 * The migration worker.
 *
 * Driven by Vercel Cron (see vercel.json) and, for responsiveness, pinged
 * directly when a run is queued. Each call processes one slice of one run and
 * returns; the run's own state in Postgres is the only thing that persists.
 *
 * Authenticated by a shared secret so the endpoint cannot be used by anyone
 * else to burn a customer's PSA API quota. Vercel Cron sends its own bearer
 * token; both are accepted.
 */
async function handle(request: NextRequest) {
  const env = serverEnv()
  const auth = request.headers.get('authorization') ?? ''
  const presented = auth.startsWith('Bearer ') ? auth.slice(7) : ''

  if (!presented || !safeEqual(presented, env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Leave a margin under maxDuration so the slice finishes on our terms.
  const budgetMs = Number(request.nextUrl.searchParams.get('budgetMs') ?? 240_000)
  const holder = `${process.env.VERCEL_DEPLOYMENT_ID ?? 'local'}:${crypto.randomUUID().slice(0, 8)}`

  try {
    const result = await processNextRun(Math.min(budgetMs, 280_000), holder)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Worker error'
    console.error('[worker]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export const GET = handle
export const POST = handle
