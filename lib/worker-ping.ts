import { serverEnv, siteUrl } from './env'

/**
 * Fire-and-forget nudge to the worker.
 *
 * Vercel Cron guarantees a tick every minute, which is the reliability floor.
 * This is purely about latency: a user who clicks "Start" should see progress
 * in seconds, not at the top of the next minute. Failure here is harmless — the
 * cron will pick the run up regardless — so it never surfaces as an error.
 */
export async function pingWorker(): Promise<void> {
  try {
    const env = serverEnv()
    await fetch(`${siteUrl()}/api/worker?budgetMs=240000`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
      cache: 'no-store',
      // Do not make the caller wait for a full slice to finish.
      signal: AbortSignal.timeout(1500),
    })
  } catch {
    // Intentionally silent — cron is the guarantee, this is the accelerator.
  }
}
