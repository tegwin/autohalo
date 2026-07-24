'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Loader2, Search, X } from 'lucide-react'
import type { SourceCompany } from '@/app/api/source/companies/route'

/**
 * Searchable, multi-select company picker backed by the live source system.
 *
 * Selecting companies scopes a live run to them (and everything that belongs to
 * them). "All companies" is the default and sends no ids, so the common case
 * needs no interaction. Selections are held by id and carry a cached label so
 * chosen companies stay readable even after the search box is cleared.
 */
export function CompanyPicker({
  connectionId,
  selected,
  onChange,
}: {
  connectionId: string
  selected: Map<string, string>
  onChange: (next: Map<string, string>) => void
}) {
  const [mode, setMode] = useState<'all' | 'specific'>(selected.size ? 'specific' : 'all')
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<SourceCompany[]>([])
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
        const res = await fetch(`/api/source/companies?${params.toString()}`, { cache: 'no-store' })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? 'Could not load companies')
        setResults(json.items as SourceCompany[])
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load companies')
        setResults([])
      } finally {
        setLoading(false)
      }
    },
    [connectionId],
  )

  // Load the first page when the picker opens, and debounce subsequent typing.
  useEffect(() => {
    if (mode !== 'specific') return
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => void load(search), 300)
    return () => {
      if (debounce.current) clearTimeout(debounce.current)
    }
  }, [search, mode, load])

  function toggle(company: SourceCompany) {
    const next = new Map(selected)
    if (next.has(company.id)) next.delete(company.id)
    else next.set(company.id, company.label)
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
          All companies
        </ModeButton>
        <ModeButton active={mode === 'specific'} onClick={() => switchMode('specific')}>
          Choose specific companies
        </ModeButton>
      </div>

      {mode === 'all' ? (
        <p className="hint">
          Every company and everything belonging to it (contacts, sites, tickets, projects,
          opportunities and contracts) will be migrated.
        </p>
      ) : (
        <>
          <p className="hint">
            Scopes the run to the selected companies and their related records. Products and KB
            articles are not company-specific and always come across in full.
          </p>

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
            <p className="hint">No companies selected yet — a live run needs at least one.</p>
          )}

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
            <input
              className="input pl-9"
              placeholder="Search companies…"
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
                {results.map((company) => {
                  const isSelected = selected.has(company.id)
                  return (
                    <li key={company.id}>
                      <button
                        onClick={() => toggle(company)}
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
                          <span className="block truncate font-medium">{company.label}</span>
                          {company.sub ? <span className="hint block truncate">{company.sub}</span> : null}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
          <p className="hint">
            Showing up to 50 matches — refine the search to find more. Selecting a company keeps it
            chosen even as you search again.
          </p>
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
