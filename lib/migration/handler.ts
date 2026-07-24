import { contentHash } from '../crypto'
import type { Direction, TaskCursor } from '../types'
import type { MigrationContext } from './context'

export interface SliceResult {
  cursor: TaskCursor
  /** True when this entity has nothing left to process. */
  done: boolean
  processed: number
  created: number
  updated: number
  skipped: number
  failed: number
}

export function emptySlice(cursor: TaskCursor, done = false): SliceResult {
  return { cursor, done, processed: 0, created: 0, updated: 0, skipped: 0, failed: 0 }
}

export interface EntityHandler {
  key: string
  label: string
  description: string
  /** Dependency order. Lower runs first, so parents exist before children. */
  seq: number
  directions: Direction[]
  /** Entity keys that must complete first for foreign keys to resolve. */
  dependsOn?: string[]
  estimate?(ctx: MigrationContext): Promise<number | null>
  run(ctx: MigrationContext, cursor: TaskCursor): Promise<SliceResult>
}

/**
 * The shape almost every handler reduces to. Fetch a page from the source,
 * transform each record, write it to the target, remember the mapping, then
 * optionally walk children (time entries, notes, tasks).
 */
export interface CopySpec<S> {
  /** id_map entity key. Usually the same as the handler key. */
  entity: string
  fetchPage(ctx: MigrationContext, cursor: TaskCursor): Promise<{ items: S[]; cursor: TaskCursor; done: boolean }>
  sourceId(item: S): string
  sourceName(item: S): string
  /** Return null to skip this record (with a reason logged by the caller). */
  transform(ctx: MigrationContext, item: S): Promise<Record<string, unknown> | null>
  /** Create or update in the target; returns the target id. */
  write(
    ctx: MigrationContext,
    payload: Record<string, unknown>,
    existingTargetId: string | null,
    item: S,
  ): Promise<string>
  /** Children to copy once the parent exists. Runs on create and on update. */
  after?(ctx: MigrationContext, item: S, targetId: string): Promise<void>
  /** Skip unchanged records by comparing a hash of the payload. */
  skipUnchanged?: boolean
}

/**
 * Runs one slice of a copy. Stops on the deadline and hands back a cursor that
 * resumes mid-page, so no record is fetched twice and none is lost.
 */
/** How many records of each entity a dry run samples. */
export const DRY_RUN_SAMPLE = 5

/** Up to `n` items chosen at random (Fisher–Yates on a shallow copy). */
function pickRandom<T>(items: T[], n: number): T[] {
  if (items.length <= n) return [...items]
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
  }
  return copy.slice(0, n)
}

export async function runCopySlice<S>(
  ctx: MigrationContext,
  cursor: TaskCursor,
  spec: CopySpec<S>,
): Promise<SliceResult> {
  const result: SliceResult = {
    cursor: { ...cursor },
    done: false,
    processed: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  }

  while (!ctx.expired()) {
    const page = await spec.fetchPage(ctx, result.cursor)

    if (!page.items.length) {
      result.cursor = { ...page.cursor, offset: 0 }
      result.done = page.done
      if (page.done) break
      continue
    }

    // A trial run is a bounded, REAL copy: DRY_RUN_SAMPLE records of this
    // entity, chosen at random, written to the target so the customer can see
    // them land in Halo/Autotask. Each is recorded in id_map exactly like a
    // live write, so the later paid run recognises them and does not duplicate
    // them. It is capped to one page and stops immediately after.
    if (ctx.isTrial) {
      const sample = pickRandom(page.items, DRY_RUN_SAMPLE)
      const mappings = await ctx.prefetchMappings(spec.entity, sample.map((i) => spec.sourceId(i)))
      for (const item of sample) {
        if (ctx.expired()) break
        const sourceId = spec.sourceId(item)
        const sourceName = spec.sourceName(item)
        const existing = mappings.get(sourceId) ?? null
        try {
          const payload = await spec.transform(ctx, item)
          if (!payload) {
            result.skipped++
            continue
          }
          const targetId = await spec.write(ctx, payload, existing?.targetId ?? null, item)
          await ctx.recordMapping(spec.entity, sourceId, targetId, payload)
          if (spec.after) await spec.after(ctx, item, targetId)
          result[existing ? 'updated' : 'created']++
          result.processed++
        } catch (err) {
          result.failed++
          ctx.error(`${spec.entity} "${sourceName}" failed`, {
            sourceId,
            error: err instanceof Error ? err.message : String(err),
          })
          await ctx.recordFailure(spec.entity, sourceId, sourceName, err)
        }
      }
      ctx.info(`Trial run copied ${result.created + result.updated} of ${page.items.length}+ available ${spec.entity} record(s).`)
      result.done = true
      result.cursor = { ...result.cursor, drained: true }
      break
    }

    const startOffset = result.cursor.offset ?? 0
    const slice = page.items.slice(startOffset)
    const mappings = await ctx.prefetchMappings(
      spec.entity,
      slice.map((item) => spec.sourceId(item)),
    )

    let index = startOffset
    for (const item of slice) {
      if (ctx.expired()) {
        // Park mid-page. The same page is refetched next slice and we resume
        // from this offset, which is why fetchPage must be deterministic.
        result.cursor = { ...result.cursor, offset: index }
        return result
      }

      const sourceId = spec.sourceId(item)
      const sourceName = spec.sourceName(item)
      const existing = mappings.get(sourceId) ?? null

      try {
        const payload = await spec.transform(ctx, item)
        if (!payload) {
          result.skipped++
          index++
          continue
        }

        if (spec.skipUnchanged !== false && existing?.hash && contentHash(payload) === existing.hash) {
          result.skipped++
          index++
          continue
        }

        // Trials are handled by the sampling branch above; this loop is the
        // full live pass and always writes.
        const targetId = await spec.write(ctx, payload, existing?.targetId ?? null, item)
        await ctx.recordMapping(spec.entity, sourceId, targetId, payload)

        if (spec.after) await spec.after(ctx, item, targetId)

        result[existing ? 'updated' : 'created']++
        result.processed++
      } catch (err) {
        result.failed++
        ctx.error(`${spec.entity} "${sourceName}" failed`, {
          sourceId,
          error: err instanceof Error ? err.message : String(err),
        })
        await ctx.recordFailure(spec.entity, sourceId, sourceName, err)
      }
      index++
    }

    // Whole page consumed — advance and clear the intra-page offset.
    result.cursor = { ...page.cursor, offset: 0 }
    if (page.done) {
      result.done = true
      break
    }
  }

  return result
}
