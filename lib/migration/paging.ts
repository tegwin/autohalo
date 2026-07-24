import type { AutotaskFilter } from '../connectors/autotask'
import type { TaskCursor } from '../types'
import type { MigrationContext } from './context'

const AUTOTASK_PAGE_SIZE = 250
const HALO_PAGE_SIZE = 100

/**
 * Keyset paging for Autotask: always "id > lastId", ordered by id.
 *
 * Page-number paging would be wrong here — a run spans hours, records are
 * created while it runs, and offsets shift underneath you. Keyset is stable,
 * exactly resumable after a function timeout, and lets us refetch the current
 * page deterministically when a slice parks mid-page.
 */
export async function autotaskPage<T extends { id: number }>(
  ctx: MigrationContext,
  entity: string,
  filter: AutotaskFilter[],
  cursor: TaskCursor,
  scopeKey?: string,
): Promise<{ items: T[]; cursor: TaskCursor; done: boolean }> {
  if (cursor.drained) return { items: [], cursor, done: true }

  const lastId = Number((cursor.extra?.lastId as number | undefined) ?? 0)
  const fullFilter: AutotaskFilter[] = [...filter, { op: 'gt', field: 'id', value: lastId }]

  // Explicit per-entity record selection: restrict to the chosen source ids.
  const picked = scopeKey ? ctx.selection.recordIds?.[scopeKey] : undefined
  if (picked?.length) {
    fullFilter.push({ op: 'in', field: 'id', value: picked.map(Number) })
  }

  const page = await ctx.autotask.queryPage<T>(entity, {
    MaxRecords: AUTOTASK_PAGE_SIZE,
    filter: fullFilter,
  })

  const items = [...page.items].sort((a, b) => a.id - b.id)
  const done = items.length < AUTOTASK_PAGE_SIZE
  const newLastId = items.length ? items[items.length - 1]!.id : lastId

  return {
    items,
    cursor: { ...cursor, extra: { ...cursor.extra, lastId: newLastId }, drained: done },
    done,
  }
}

/**
 * Halo pages by number. We pin the sort to id ascending so the sequence is
 * stable across slices; without that, resuming mid-run reshuffles the set.
 */
export async function haloPage<T>(
  ctx: MigrationContext,
  resource: string,
  params: Record<string, string | number | boolean | undefined>,
  cursor: TaskCursor,
): Promise<{ items: T[]; cursor: TaskCursor; done: boolean }> {
  if (cursor.drained) return { items: [], cursor, done: true }

  const pageNo = cursor.page ?? 1
  const page = await ctx.halo.getPage<T>(resource, {
    ...params,
    order: 'id',
    orderdesc: false,
    page_size: HALO_PAGE_SIZE,
    page_no: pageNo,
  })

  const done = page.items.length < HALO_PAGE_SIZE
  return {
    items: page.items,
    cursor: { ...cursor, page: pageNo + 1, drained: done },
    done,
  }
}

/**
 * Some entities have no top-level list endpoint and must be walked per parent
 * (Autotask ticket notes, Halo project tasks). This drives that: the cursor
 * holds the queue of parent ids plus how far into the current parent we are.
 */
export interface ParentWalkState {
  parentIds: string[]
  index: number
  childCursor: TaskCursor
}

export function readParentWalk(cursor: TaskCursor): ParentWalkState | null {
  const raw = cursor.extra?.walk as ParentWalkState | undefined
  return raw ?? null
}

export function writeParentWalk(cursor: TaskCursor, walk: ParentWalkState): TaskCursor {
  return { ...cursor, extra: { ...cursor.extra, walk } }
}

export const PAGE_SIZES = { autotask: AUTOTASK_PAGE_SIZE, halo: HALO_PAGE_SIZE }
