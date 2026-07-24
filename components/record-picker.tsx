'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Loader2, Search, X } from 'lucide-react'
import type { SourceRecord } from '@/lib/source-browse'

/**
 * Searchable, multi-select picker for one entity, backed by the live source
 * system. "All" is the default and selects nothing (meaning: migrate them
 * all); "Choose specific" opens a searchable, paged list. Selections are held
 * by id with a cached label so chosen rows stay readable after the search box
 * is cleared or narrowed.
 */
export function RecordPicker({
  connectionId,
  entity,
  selected,
  onChange,
  allLabel,
  chooseLabel,
  scopeNote,
}: {
  connectionId: string
  entity: string
  selected: Map<string, string>
  onChange: (next: Map<string, string>) => void
  allLabel: string
  chooseLabel: string
  scopeNote?: string
}) {
  const [mode, setMode] = useState<'all' | 'specific'>(selected.size ? 'specific' : 'all')
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<SourceRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(
    async (term: string) => {
      if (!connectionId) return
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({ connectionId })
        if (term) params.set('search', term)
        const res = await fetch(`/api/source/${entity}?${params.toString()}`, { cache: 'no-store' })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? 'Could not load records')
        setResults(json.items as SourceRecord[])
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load records')
        setResults([])
      } finally {
        setLoading(false)
      }
    },
    [connectionId, entity],
  )

  useEffect(() => {
    if (mode !== 'specific') return
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => void load(search), 300)
    return () => {
      if (debounce.current) clearTimeout(debounce.current)
    }
  }, [search, mode, load])

  function toggle(record: SourceRecord) {
    const next = new Map(selected)
    if (next.has(record.id)) next.delete(record.id)
    else next.set(record.id, record.label)
    onChange(next)
  }

  function switchMode(next: 'all' | 'specific') {
    setMode(next)
    if (next === 'all') onChange(new Map())
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <ModeButton active={mode === 'all'} onClick={() => switchMode('all')}>
          {allLabel}
        </ModeButton>
        <ModeButton active={mode === 'specific'} onClick={() => switchMode('specific')}>
          {chooseLabel}
        </ModeButton>
      </div>

      {mode === 'all' ? (
        scopeNote ? <p className="hint">{scopeNote}</p> : null
      ) : (
        <>
          {selected.size > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {[...selected.entries()].map(([id, label]) => (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 rounded-full bg-brand-100 px-2.5 py-1 text-xs font-medium text-brand-700 dark:bg-brand-700/20 dark:text-brand-200"
                >
                  {label}
                  <button
                    onClick={() => {
                      const next = new Map(selected)
                      next.delete(id)
                      onChange(next)
                    }}
                    className="hover:text-brand-900 dark:hover:text-white"
                    aria-label={`Remove ${label}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <button
                onClick={() => onChange(new Map())}
                className="text-xs text-ink-500 hover:underline dark:text-ink-400"
              >
                Clear all
              </button>
            </div>
          ) : (
            <p className="hint">Nothing selected yet — search and tick the records to migrate.</p>
          )}

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
            <input
              className="input pl-9"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {error ? <p className="text-sm text-red-600">{error}</p> : null}

          <div className="max-h-72 overflow-y-auto rounded-lg border border-ink-200 dark:border-ink-700">
            {loading ? (
              <p className="flex items-center gap-2 p-3 text-sm text-ink-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </p>
            ) : results.length === 0 ? (
              <p className="p-3 text-sm text-ink-500">No matches.</p>
            ) : (
              <ul>
                {results.map((record) => {
                  const isSelected = selected.has(record.id)
                  return (
                    <li key={record.id}>
                      <button
                        onClick={() => toggle(record)}
                        className="flex w-full items-center gap-3 border-b border-ink-100 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-ink-50 dark:border-ink-800 dark:hover:bg-ink-800/60"
                      >
                        <span
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                            isSelected
                              ? 'border-brand-600 bg-brand-600 text-white'
                              : 'border-ink-300 dark:border-ink-600'
                          }`}
                        >
                          {isSelected ? <Check className="h-3 w-3" /> : null}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{record.label}</span>
                          {record.sub ? <span className="hint block truncate">{record.sub}</span> : null}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
          <p className="hint">Showing up to 50 matches — refine the search to find more.</p>
        </>
      )}
    </div>
  )
}

function ModeButton({
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
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
        active
          ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-700/10 dark:text-brand-200'
          : 'border-ink-200 text-ink-600 hover:border-ink-300 dark:border-ink-700 dark:text-ink-300'
      }`}
    >
      {children}
    </button>
  )
}
