'use client'

import { useCallback, useEffect, useState } from 'react'
import { Ban, Pause, Play, RefreshCw } from 'lucide-react'
import { RunStatusBadge, TaskStatusBadge } from '@/components/status-badge'
import type { MigrationRun, RunFailure, RunLog, RunTask } from '@/lib/types'

const ACTIVE_STATES = new Set(['queued', 'running'])

/**
 * Live run view.
 *
 * Polls rather than subscribing: a migration emits far more state changes than
 * a person can read, and a 2s poll of one summary endpoint is both cheaper and
 * steadier than a realtime firehose. Polling stops once the run is terminal.
 */
export function RunMonitor({
  runId,
  initialRun,
  failures,
  canManage,
}: {
  runId: string
  initialRun: MigrationRun
  failures: RunFailure[]
  canManage: boolean
}) {
  const [run, setRun] = useState(initialRun)
  const [tasks, setTasks] = useState<RunTask[]>([])
  const [logs, setLogs] = useState<RunLog[]>([])
  const [failureCount, setFailureCount] = useState(failures.length)
  const [tab, setTab] = useState<'progress' | 'log' | 'failures'>('progress')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/runs/${runId}`, { cache: 'no-store' })
    if (!res.ok) return
    const json = await res.json()
    setRun(json.run)
    setTasks(json.tasks)
    setLogs(json.logs)
    setFailureCount(json.failureCount)
  }, [runId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!ACTIVE_STATES.has(run.status)) return
    const timer = setInterval(() => void refresh(), 2500)
    return () => clearInterval(timer)
  }, [run.status, refresh])

  async function act(action: 'pause' | 'resume' | 'cancel' | 'retry_failed') {
    if (action === 'cancel' && !confirm('Cancel this run? Records already written are kept.')) return
    setBusy(true)
    await fetch(`/api/runs/${runId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    await refresh()
    setBusy(false)
  }

  const totals = run.stats ?? {}

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">
              {run.direction === 'autotask_to_halo' ? 'Autotask → HaloPSA' : 'HaloPSA → Autotask'}
            </h1>
            <RunStatusBadge status={run.status} />
            {run.mode === 'dry_run' ? (
              <span className="badge bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-300">
                dry run
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-ink-600 dark:text-ink-400">
            Started {new Date(run.created_at).toLocaleString('en-GB')}
            {run.finished_at ? ` · finished ${new Date(run.finished_at).toLocaleString('en-GB')}` : ''}
          </p>
        </div>

        {canManage ? (
          <div className="flex flex-wrap gap-2">
            {ACTIVE_STATES.has(run.status) ? (
              <button className="btn-secondary" onClick={() => act('pause')} disabled={busy}>
                <Pause className="h-4 w-4" /> Pause
              </button>
            ) : null}
            {run.status === 'paused' ? (
              <button className="btn-primary" onClick={() => act('resume')} disabled={busy}>
                <Play className="h-4 w-4" /> Resume
              </button>
            ) : null}
            {run.status === 'failed' ? (
              <button className="btn-primary" onClick={() => act('retry_failed')} disabled={busy}>
                <RefreshCw className="h-4 w-4" /> Retry failed entities
              </button>
            ) : null}
            {ACTIVE_STATES.has(run.status) || run.status === 'paused' ? (
              <button className="btn-danger" onClick={() => act('cancel')} disabled={busy}>
                <Ban className="h-4 w-4" /> Cancel
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {run.error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          {run.error}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Created" value={totals.created ?? 0} tone="emerald" />
        <Stat label="Updated" value={totals.updated ?? 0} tone="brand" />
        <Stat label="Skipped" value={totals.skipped ?? 0} tone="ink" />
        <Stat label="Failed" value={totals.failed ?? 0} tone={totals.failed ? 'red' : 'ink'} />
      </div>

      <div className="flex gap-1 border-b border-ink-200 text-sm dark:border-ink-800">
        <Tab active={tab === 'progress'} onClick={() => setTab('progress')}>
          Progress
        </Tab>
        <Tab active={tab === 'log'} onClick={() => setTab('log')}>
          Log
        </Tab>
        <Tab active={tab === 'failures'} onClick={() => setTab('failures')}>
          Failed records {failureCount ? `(${failureCount})` : ''}
        </Tab>
      </div>

      {tab === 'progress' ? <ProgressTable tasks={tasks} /> : null}
      {tab === 'log' ? <LogView logs={logs} /> : null}
      {tab === 'failures' ? <FailureTable failures={failures} /> : null}
    </div>
  )
}

function ProgressTable({ tasks }: { tasks: RunTask[] }) {
  if (!tasks.length) return <p className="hint">Queueing…</p>

  return (
    <div className="table-shell">
      <table>
        <thead>
          <tr>
            <th>Entity</th>
            <th>Status</th>
            <th>Progress</th>
            <th>Created</th>
            <th>Updated</th>
            <th>Skipped</th>
            <th>Failed</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => {
            const pct =
              task.total_estimate && task.total_estimate > 0
                ? Math.min(100, Math.round((task.processed / task.total_estimate) * 100))
                : null
            return (
              <tr key={task.id}>
                <td className="font-medium">{task.entity.replace(/_/g, ' ')}</td>
                <td>
                  <TaskStatusBadge status={task.status} />
                  {task.last_error ? (
                    <p className="mt-1 max-w-md text-xs text-red-600">{task.last_error}</p>
                  ) : null}
                </td>
                <td className="min-w-[9rem]">
                  {pct !== null ? (
                    <>
                      <div className="h-1.5 w-full rounded-full bg-ink-100 dark:bg-ink-800">
                        <div
                          className="h-1.5 rounded-full bg-brand-500 transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="hint mt-1 block">
                        {task.processed} of ~{task.total_estimate}
                      </span>
                    </>
                  ) : (
                    <span className="hint">{task.processed} processed</span>
                  )}
                </td>
                <td>{task.created_count}</td>
                <td>{task.updated_count}</td>
                <td>{task.skipped_count}</td>
                <td className={task.failed_count ? 'font-medium text-red-600' : ''}>
                  {task.failed_count}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function LogView({ logs }: { logs: RunLog[] }) {
  if (!logs.length) return <p className="hint">Nothing logged yet.</p>

  return (
    <div className="max-h-[32rem] overflow-y-auto rounded-xl border border-ink-200 bg-ink-950 p-4 font-mono text-xs text-ink-200 dark:border-ink-800">
      {logs.map((log) => (
        <p key={log.id} className="whitespace-pre-wrap py-0.5">
          <span className="text-ink-500">
            {new Date(log.created_at).toLocaleTimeString('en-GB')}{' '}
          </span>
          <span
            className={
              log.level === 'error'
                ? 'text-red-400'
                : log.level === 'warn'
                  ? 'text-amber-400'
                  : 'text-brand-400'
            }
          >
            [{log.entity ?? 'run'}]
          </span>{' '}
          {log.message}
        </p>
      ))}
    </div>
  )
}

function FailureTable({ failures }: { failures: RunFailure[] }) {
  if (!failures.length) {
    return <p className="hint">No failed records. </p>
  }

  return (
    <div className="table-shell">
      <table>
        <thead>
          <tr>
            <th>Entity</th>
            <th>Source record</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {failures.map((failure) => (
            <tr key={failure.id}>
              <td className="whitespace-nowrap">{failure.entity.replace(/_/g, ' ')}</td>
              <td>
                <span className="font-medium">{failure.source_name ?? '—'}</span>
                <span className="hint block">#{failure.source_id}</span>
              </td>
              <td className="text-red-600">{failure.error}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'emerald' | 'brand' | 'red' | 'ink'
}) {
  const colours = {
    emerald: 'text-emerald-600',
    brand: 'text-brand-600',
    red: 'text-red-600',
    ink: 'text-ink-700 dark:text-ink-300',
  }
  return (
    <div className="card">
      <p className="hint">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${colours[tone]}`}>
        {value.toLocaleString('en-GB')}
      </p>
    </div>
  )
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px border-b-2 px-4 py-2 font-medium transition ${
        active
          ? 'border-brand-500 text-brand-600'
          : 'border-transparent text-ink-500 hover:text-ink-800 dark:hover:text-ink-200'
      }`}
    >
      {children}
    </button>
  )
}
