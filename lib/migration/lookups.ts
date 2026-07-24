import type { MigrationContext } from './context'

/**
 * Reference-data translation.
 *
 * Autotask stores statuses/priorities/types as numeric picklist ids that are
 * instance-specific; Halo does the same with its own ids. Nothing about "5"
 * carries across. The only stable bridge is the human label, so both sides are
 * resolved to labels and matched by name, with a configured fallback when no
 * match exists. This is where a migration most often needs tuning per customer,
 * so the matching is deliberately simple and visible rather than clever.
 */

interface HaloLookupItem {
  id: number
  name?: string
  status?: string
  priority?: string
  use?: string
}

const memo = new Map<string, Map<string, number>>()

function memoKey(ctx: MigrationContext, resource: string): string {
  return `${ctx.orgId}:${resource}`
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Builds (and caches) a label -> id index for a Halo lookup resource. */
async function haloIndex(
  ctx: MigrationContext,
  resource: string,
  params: Record<string, string | number | boolean> = {},
): Promise<Map<string, number>> {
  const key = memoKey(ctx, `${resource}${JSON.stringify(params)}`)
  const cached = memo.get(key)
  if (cached) return cached

  const items = await ctx.halo.lookup<HaloLookupItem>(resource, params)
  const index = new Map<string, number>()
  for (const item of items) {
    const label = item.name ?? item.status ?? item.priority ?? item.use
    if (label) index.set(normalise(label), item.id)
  }
  memo.set(key, index)
  return index
}

export async function haloIdForLabel(
  ctx: MigrationContext,
  resource: string,
  label: string | null | undefined,
  fallback: number | null = null,
  params: Record<string, string | number | boolean> = {},
): Promise<number | null> {
  if (!label) return fallback
  const index = await haloIndex(ctx, resource, params)
  const exact = index.get(normalise(label))
  if (exact !== undefined) return exact

  // Loose match: Autotask "In Progress" vs Halo "In-Progress".
  const loose = normalise(label).replace(/[^a-z0-9]/g, '')
  for (const [candidate, id] of index) {
    if (candidate.replace(/[^a-z0-9]/g, '') === loose) return id
  }
  return fallback
}

/** Autotask picklist id -> label, so the value can be matched in Halo. */
export async function autotaskLabel(
  ctx: MigrationContext,
  entity: string,
  field: string,
  value: unknown,
): Promise<string | null> {
  try {
    return await ctx.autotask.picklistLabel(entity, field, value)
  } catch {
    return null
  }
}

/** The reverse: a Halo label back onto an Autotask picklist id. */
export async function autotaskPicklistId(
  ctx: MigrationContext,
  entity: string,
  field: string,
  label: string | null,
  fallback: number | null = null,
): Promise<number | null> {
  try {
    const id = await ctx.autotask.picklistValue(entity, field, label)
    return id ?? fallback
  } catch {
    return fallback
  }
}

/**
 * Halo needs a ticket type id on every ticket-shaped record. Projects,
 * opportunities and project tasks are all tickets underneath, so we resolve
 * the right type once per run and reuse it.
 */
export interface HaloTicketTypes {
  incident: number | null
  project: number | null
  projectTask: number | null
  opportunity: number | null
  change: number | null
}

const ticketTypeCache = new Map<string, HaloTicketTypes>()

export async function haloTicketTypes(ctx: MigrationContext): Promise<HaloTicketTypes> {
  const key = ctx.orgId
  const cached = ticketTypeCache.get(key)
  if (cached) return cached

  const types = await ctx.halo.lookup<{ id: number; name: string; use?: string }>('TicketType')
  const find = (...needles: string[]): number | null => {
    for (const needle of needles) {
      const hit = types.find((t) => normalise(t.name ?? '').includes(needle))
      if (hit) return hit.id
    }
    return null
  }

  const resolved: HaloTicketTypes = {
    incident: find('incident', 'ticket', 'request') ?? types[0]?.id ?? null,
    project: find('project'),
    projectTask: find('task', 'project task'),
    opportunity: find('opportunity', 'sales'),
    change: find('change'),
  }
  ticketTypeCache.set(key, resolved)
  return resolved
}

/** Clears memoised lookups. Called when a run finishes so a later run in the
 *  same warm lambda re-reads reference data the customer may have changed. */
export function clearLookupCaches(): void {
  memo.clear()
  ticketTypeCache.clear()
}
