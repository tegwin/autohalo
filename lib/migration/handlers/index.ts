import type { Direction } from '../../types'
import type { EntityHandler } from '../handler'
import { attachmentsHandler } from './attachments'
import { companiesHandler } from './companies'
import { contractsHandler, opportunitiesHandler, productsHandler } from './commercial'
import { documentsHandler, kbArticlesHandler } from './knowledge'
import { agentsHandler, contactsHandler, sitesHandler } from './people'
import { projectTemplatesHandler, projectsHandler } from './projects'
import { ticketsHandler } from './tickets'

/**
 * The full entity registry, in dependency order.
 *
 * `seq` is the contract: a handler may assume every entity with a lower seq has
 * already run, which is what lets foreign keys resolve through id_map. Adding a
 * new entity means slotting it into this ordering, nothing else.
 */
export const HANDLERS: EntityHandler[] = [
  agentsHandler, // 10  — technicians first; tickets reference them
  companiesHandler, // 20
  sitesHandler, // 25
  contactsHandler, // 30
  productsHandler, // 40
  contractsHandler, // 50
  kbArticlesHandler, // 60
  documentsHandler, // 65
  projectTemplatesHandler, // 70
  projectsHandler, // 80  — brings phases and tasks with it
  opportunitiesHandler, // 90
  ticketsHandler, // 100 — brings notes and time entries with it
  attachmentsHandler, // 110 — walks everything already migrated
].sort((a, b) => a.seq - b.seq)

export const HANDLERS_BY_KEY = new Map(HANDLERS.map((h) => [h.key, h]))

export function handlersFor(direction: Direction, keys: string[]): EntityHandler[] {
  const wanted = new Set(keys)
  return HANDLERS.filter((h) => wanted.has(h.key) && h.directions.includes(direction))
}

export function availableEntities(direction: Direction): {
  key: string
  label: string
  description: string
  seq: number
  dependsOn: string[]
}[] {
  return HANDLERS.filter((h) => h.directions.includes(direction)).map((h) => ({
    key: h.key,
    label: h.label,
    description: h.description,
    seq: h.seq,
    dependsOn: h.dependsOn ?? [],
  }))
}

/**
 * Expands a user's selection to include the entities it depends on.
 *
 * Selecting "tickets" without "companies" would produce a run where every
 * ticket is skipped for want of a client, so we pull the prerequisites in and
 * report what was added rather than letting the run quietly do nothing.
 */
export function withDependencies(
  direction: Direction,
  keys: string[],
): { entities: string[]; added: string[] } {
  const selected = new Set(keys)
  const added: string[] = []
  let changed = true

  while (changed) {
    changed = false
    for (const key of [...selected]) {
      const handler = HANDLERS_BY_KEY.get(key)
      if (!handler) continue
      for (const dep of handler.dependsOn ?? []) {
        const depHandler = HANDLERS_BY_KEY.get(dep)
        if (!depHandler?.directions.includes(direction)) continue
        if (!selected.has(dep)) {
          selected.add(dep)
          added.push(dep)
          changed = true
        }
      }
    }
  }

  const ordered = HANDLERS.filter(
    (h) => selected.has(h.key) && h.directions.includes(direction),
  ).map((h) => h.key)

  return { entities: ordered, added }
}
