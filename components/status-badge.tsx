import type { RunStatus, TaskStatus } from '@/lib/types'

const RUN_STYLES: Record<RunStatus, string> = {
  draft: 'bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-300',
  queued: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  running: 'bg-brand-100 text-brand-700 dark:bg-brand-700/20 dark:text-brand-300',
  paused: 'bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-300',
  completed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  cancelled: 'bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-400',
}

const TASK_STYLES: Record<TaskStatus, string> = {
  pending: 'bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-400',
  running: 'bg-brand-100 text-brand-700 dark:bg-brand-700/20 dark:text-brand-300',
  succeeded: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  skipped: 'bg-ink-100 text-ink-500 dark:bg-ink-800 dark:text-ink-400',
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <span className={`badge ${RUN_STYLES[status]}`}>{status.replace('_', ' ')}</span>
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`badge ${TASK_STYLES[status]}`}>{status}</span>
}
