'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { ArrowRight, Loader2, ShieldAlert } from 'lucide-react'
import { CompanyPicker } from '@/components/company-picker'
import type { Connection, Direction } from '@/lib/types'

interface EntityOption {
  key: string
  label: string
  description: string
  seq: number
  dependsOn: string[]
}

export function MigrationWizard({
  connections,
  entitiesByDirection,
  credits,
  canManage,
}: {
  connections: Connection[]
  entitiesByDirection: Record<Direction, EntityOption[]>
  credits: { available: number; reason: string; trialsRemaining: number }
  canManage: boolean
}) {
  const router = useRouter()
  const [direction, setDirection] = useState<Direction>('autotask_to_halo')
  const [mode, setMode] = useState<'dry_run' | 'live'>('dry_run')
  const [selected, setSelected] = useState<Set<string>>(new Set(['companies', 'contacts', 'tickets']))
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  // Chosen companies to scope a live run to, id -> display label. Empty = all.
  const [companyScope, setCompanyScope] = useState<Map<string, string>>(new Map())
  const [createAgents, setCreateAgents] = useState(false)
  const [includeTime, setIncludeTime] = useState(true)
  const [includeNotes, setIncludeNotes] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sourceSystem = direction === 'autotask_to_halo' ? 'autotask' : 'halo'
  const targetSystem = direction === 'autotask_to_halo' ? 'halo' : 'autotask'

  const sources = connections.filter((c) => c.system === sourceSystem)
  const targets = connections.filter((c) => c.system === targetSystem)

  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '')
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '')

  const entities = entitiesByDirection[direction]

  // Show the user which prerequisites their choice will pull in, before they
  // commit — a run that quietly adds five entities is a nasty surprise on a
  // paid, one-shot migration.
  const implied = useMemo(() => {
    const set = new Set(selected)
    let changed = true
    while (changed) {
      changed = false
      for (const key of [...set]) {
        const entity = entities.find((e) => e.key === key)
        for (const dep of entity?.dependsOn ?? []) {
          if (entities.some((e) => e.key === dep) && !set.has(dep)) {
            set.add(dep)
            changed = true
          }
        }
      }
    }
    return [...set].filter((key) => !selected.has(key))
  }, [selected, entities])

  const unlimited = credits.available < 0
  const canRunLive = unlimited || credits.available > 0
  // trialsRemaining is -1 for admin/unlimited (effectively unlimited trials).
  const unlimitedTrials = credits.trialsRemaining < 0
  const canRunTrial = unlimitedTrials || credits.trialsRemaining > 0

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function switchDirection(next: Direction) {
    setDirection(next)
    const nextSources = connections.filter(
      (c) => c.system === (next === 'autotask_to_halo' ? 'autotask' : 'halo'),
    )
    const nextTargets = connections.filter(
      (c) => c.system === (next === 'autotask_to_halo' ? 'halo' : 'autotask'),
    )
    setSourceId(nextSources[0]?.id ?? '')
    setTargetId(nextTargets[0]?.id ?? '')
    // Company ids are source-specific; clear them when the source changes.
    setCompanyScope(new Map())
    // Drop selections the new direction cannot service.
    const allowed = new Set(entitiesByDirection[next].map((e) => e.key))
    setSelected((prev) => new Set([...prev].filter((key) => allowed.has(key))))
  }

  async function start() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceConnection: sourceId,
          targetConnection: targetId,
          direction,
          mode,
          entities: [...selected],
          since: since || undefined,
          until: until || undefined,
          companyIds: companyScope.size ? [...companyScope.keys()] : undefined,
          options: {
            agents: { createAgents },
            tickets: { includeTimeEntries: includeTime, includeNotes },
          },
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Could not start the migration')
      router.push(`/migrations/${json.runId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the migration')
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="card space-y-4">
        <h2 className="font-semibold">1. Direction</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Choice
            active={direction === 'autotask_to_halo'}
            onClick={() => switchDirection('autotask_to_halo')}
            title="Autotask → HaloPSA"
            body="The usual direction. Full entity coverage."
          />
          <Choice
            active={direction === 'halo_to_autotask'}
            onClick={() => switchDirection('halo_to_autotask')}
            title="HaloPSA → Autotask"
            body="Reverse or roll back. Core entities only."
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="source">
              Source ({sourceSystem})
            </label>
            <select
              id="source"
              className="input"
              value={sourceId}
              onChange={(e) => {
                setSourceId(e.target.value)
                setCompanyScope(new Map())
              }}
            >
              {sources.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="target">
              Target ({targetSystem})
            </label>
            <select
              id="target"
              className="input"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
            >
              {targets.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="card space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">2. What to copy</h2>
          <div className="flex gap-2 text-sm">
            <button className="text-brand-600 hover:underline" onClick={() => setSelected(new Set(entities.map((e) => e.key)))}>
              Select all
            </button>
            <span className="text-ink-300">·</span>
            <button className="text-brand-600 hover:underline" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {entities.map((entity) => {
            const isImplied = implied.includes(entity.key)
            return (
              <label
                key={entity.key}
                className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition ${
                  selected.has(entity.key)
                    ? 'border-brand-500 bg-brand-50 dark:bg-brand-700/10'
                    : isImplied
                      ? 'border-amber-300 bg-amber-50 dark:border-amber-700/50 dark:bg-amber-900/10'
                      : 'border-ink-200 hover:border-ink-300 dark:border-ink-700'
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4"
                  checked={selected.has(entity.key) || isImplied}
                  disabled={isImplied}
                  onChange={() => toggle(entity.key)}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    {entity.label}
                    {isImplied ? (
                      <span className="ml-2 text-xs font-normal text-amber-700 dark:text-amber-400">
                        added automatically
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-600 dark:text-ink-400">
                    {entity.description}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
      </div>

      <div className="card space-y-4">
        <h2 className="font-semibold">3. Which companies</h2>

        {sourceId ? (
          <CompanyPicker connectionId={sourceId} selected={companyScope} onChange={setCompanyScope} />
        ) : (
          <p className="hint">Choose a source connection first.</p>
        )}

        {mode === 'dry_run' ? (
          <p className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-700 dark:border-brand-700/50 dark:bg-brand-700/10 dark:text-brand-200">
            This is a <strong>trial</strong>: it copies up to <strong>5 records of each selected
            type</strong> into Halo so you can confirm it works — drawn from the companies you pick
            above (or at random if you pick none). Those records are remembered, so your later live
            migration skips them rather than duplicating.
          </p>
        ) : null}
      </div>

      {mode === 'live' ? (
        <div className="card space-y-4">
          <h2 className="font-semibold">4. Options</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="since">
                Only records created on or after
              </label>
              <input id="since" type="date" className="input" value={since} onChange={(e) => setSince(e.target.value)} />
              <p className="hint mt-1">Leave blank for everything.</p>
            </div>
            <div>
              <label className="label" htmlFor="until">
                …and before
              </label>
              <input id="until" type="date" className="input" value={until} onChange={(e) => setUntil(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2 text-sm">
            <Toggle checked={includeTime} onChange={setIncludeTime} label="Include time entries on tickets and tasks" />
            <Toggle checked={includeNotes} onChange={setIncludeNotes} label="Include ticket and task notes" />
            <Toggle
              checked={createAgents}
              onChange={setCreateAgents}
              label="Create Halo agents for Autotask resources that do not already exist"
              hint="Each new Halo agent consumes a licence seat. Off by default; existing agents are matched by email either way."
            />
          </div>
        </div>
      ) : null}

      <div className="card space-y-4">
        <h2 className="font-semibold">Start the run</h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <Choice
            active={mode === 'dry_run'}
            onClick={() => setMode('dry_run')}
            title="Free trial run"
            body={
              unlimitedTrials
                ? 'Copies 5 random records of each selected type into the target so you can see it working. Unlimited on this account.'
                : canRunTrial
                  ? 'Copies 5 random records of each selected type into the target so you can see them in Halo. One free trial per account.'
                  : 'Your free trial has been used. Purchase a live migration, or ask an administrator to unlock another trial.'
            }
            disabled={!canRunTrial}
          />
          <Choice
            active={mode === 'live'}
            onClick={() => setMode('live')}
            title="Live migration"
            body={
              unlimited
                ? 'Migrates everything you select. No credit needed on this account.'
                : `Migrates everything you select. Uses 1 of your ${credits.available} credit${credits.available === 1 ? '' : 's'}. The 5 trial records are skipped, not duplicated.`
            }
            disabled={!canRunLive}
          />
        </div>

        {mode === 'live' && !canRunLive ? (
          <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700/50 dark:bg-amber-900/20 dark:text-amber-300">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            You have no migration credits. Buy one on the billing page, or ask an administrator to
            grant one.
          </p>
        ) : null}

        {mode === 'dry_run' && !canRunTrial ? (
          <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700/50 dark:bg-amber-900/20 dark:text-amber-300">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            You have used your free trial run. Buy a live migration to move everything, or ask an
            administrator to unlock another trial.
          </p>
        ) : null}

        {error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        ) : null}

        <button
          className="btn-primary"
          onClick={start}
          disabled={
            busy ||
            !canManage ||
            selected.size === 0 ||
            !sourceId ||
            !targetId ||
            (mode === 'live' && !canRunLive) ||
            (mode === 'dry_run' && !canRunTrial)
          }
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {mode === 'dry_run' ? 'Start free trial (5 of each)' : 'Start live migration'}
          <ArrowRight className="h-4 w-4" />
        </button>

        {!canManage ? (
          <p className="hint">You need admin rights on this organisation to start a migration.</p>
        ) : null}
      </div>
    </div>
  )
}

function Choice({
  active,
  onClick,
  title,
  body,
  disabled,
}: {
  active: boolean
  onClick: () => void
  title: string
  body: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? 'border-brand-500 bg-brand-50 dark:bg-brand-700/10'
          : 'border-ink-200 hover:border-ink-300 dark:border-ink-700'
      }`}
    >
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-xs text-ink-600 dark:text-ink-400">{body}</p>
    </button>
  )
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="block">{label}</span>
        {hint ? <span className="hint block">{hint}</span> : null}
      </span>
    </label>
  )
}
