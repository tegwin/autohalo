'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import type { GridResult, GridRow } from '@/lib/source-browse'

/**
 * Grid picker for one entity, modelled on the PHP importer's table: a paged
 * grid of the source records with a filter box per column, a select-all
 * header checkbox, and row checkboxes. "All" is the default (select nothing =
 * migrate everything); "Choose specific" opens the grid. Selections are held
 * by id with a cached label so ticked rows survive filtering and paging.
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
  const [page, setPage] = useState(1)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [data, setData] = useState<GridResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(
    async (pageNo: number, activeFilters: Record<string, string>) => {
      if (!connectionId) return
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({ connectionId, page: String(pageNo) })
        const nonEmpty = Object.fromEntries(
          Object.entries(activeFilters).filter(([, v]) => v.trim()),
        )
        if (Object.keys(nonEmpty).length) params.set('filters', JSON.stringify(nonEmpty))
        const res = await fetch(`/api/source/${entity}?${params.toString()}`, { cache: 'no-store' })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? 'Could not load records')
        setData(json as GridResult)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load records')
        setData(null)
      } finally {
        setLoading(false)
      }
    },
    [connectionId, entity],
  )

  // Load when opened or when the page changes.
  useEffect(() => {
    if (mode !== 'specific') return
    void load(page, filters)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, page])

  // Debounce filter typing; a filter change resets to page 1.
  useEffect(() => {
    if (mode !== 'specific') return
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => {
      if (page !== 1) setPage(1)
      else void load(1, filters)
    }, 350)
    return () => {
      if (debounce.current) clearTimeout(debounce.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters])

  function toggleRow(row: GridRow) {
    const next = new Map(selected)
    if (next.has(row._id)) next.delete(row._id)
    else next.set(row._id, row._label)
    onChange(next)
  }

  function toggleAllOnPage(check: boolean) {
    const next = new Map(selected)
    for (const row of data?.rows ?? []) {
      if (check) next.set(row._id, row._label)
      else next.delete(row._id)
    }
    onChange(next)
  }

  function switchMode(next: 'all' | 'specific') {
    setMode(next)
    if (next === 'all') onChange(new Map())
  }

  const rows = data?.rows ?? []
  const columns = data?.columns ?? []
  const allOnPageChecked = rows.length > 0 && rows.every((r) => selected.has(r._id))

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ModeButton active={mode === 'all'} onClick={() => switchMode('all')}>
          {allLabel}
        </ModeButton>
        <ModeButton active={mode === 'specific'} onClick={() => switchMode('specific')}>
          {chooseLabel}
        </ModeButton>
        {mode === 'specific' && selected.size > 0 ? (
          <span className="ml-1 text-sm text-ink-600 dark:text-ink-300">
            {selected.size} selected
            <button onClick={() => onChange(new Map())} className="ml-2 text-xs text-ink-500 hover:underline">
              clear
            </button>
          </span>
        ) : null}
      </div>

      {mode === 'all' ? (
        scopeNote ? <p className="hint">{scopeNote}</p> : null
      ) : (
        <>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}

          <div className="overflow-x-auto rounded-lg border border-ink-200 dark:border-ink-700">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead>
                <tr className="border-b border-ink-200 dark:border-ink-700">
                  <th className="w-10 px-3 py-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={allOnPageChecked}
                      onChange={(e) => toggleAllOnPage(e.target.checked)}
                      aria-label="Select all on this page"
                    />
                  </th>
                  {columns.map((col) => (
                    <th key={col} className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-500 dark:text-ink-400">
                      {col}
                    </th>
                  ))}
                </tr>
                <tr className="border-b border-ink-200 dark:border-ink-700">
                  <th className="px-3 py-1.5" />
                  {columns.map((col) => (
                    <th key={col} className="px-2 py-1.5">
                      <input
                        className="input h-7 py-1 text-xs"
                        placeholder="filter…"
                        value={filters[col] ?? ''}
                        onChange={(e) => setFilters((prev) => ({ ...prev, [col]: e.target.value }))}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={columns.length + 1} className="px-3 py-6 text-center text-ink-500">
                      <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={columns.length + 1} className="px-3 py-6 text-center text-ink-500">
                      No matching records.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr
                      key={row._id}
                      className="cursor-pointer border-b border-ink-100 last:border-b-0 hover:bg-ink-50 dark:border-ink-800 dark:hover:bg-ink-800/50"
                      onClick={() => toggleRow(row)}
                    >
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={selected.has(row._id)}
                          onChange={() => toggleRow(row)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </td>
                      {columns.map((col) => (
                        <td key={col} className="px-3 py-2 text-ink-700 dark:text-ink-200">
                          {row[col]}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {data ? (
            <div className="flex items-center justify-between text-sm">
              <span className="hint">{data.total.toLocaleString('en-GB')} total</span>
              <div className="flex items-center gap-3">
                <button
                  className="btn-secondary px-2 py-1"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="h-4 w-4" /> Prev
                </button>
                <span>
                  Page {data.page} of {data.totalPages}
                </span>
                <button
                  className="btn-secondary px-2 py-1"
                  disabled={page >= data.totalPages || loading}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          ) : null}
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
