import { AutotaskClient } from './connectors/autotask'
import { HaloClient } from './connectors/halo'
import { clientFor } from './connectors/credentials'

/**
 * Live record browsing for the migration wizard's per-entity pickers.
 *
 * One config table maps each handler entity key to how it is queried on each
 * side, so the wizard can offer "choose specific records" for any supported
 * entity from a single endpoint. Read-only, paged and search-filtered so even
 * a tenant with tens of thousands of tickets stays responsive.
 */

export interface SourceRecord {
  id: string
  label: string
  sub?: string
}

interface AutotaskEntityConfig {
  resource: string
  /** Fields joined to form the display label. */
  labelFields: string[]
  /** Field the search box filters on (contains). */
  searchField: string
  /** Optional secondary line (a reference number, email, city). */
  subField?: string
}

interface HaloEntityConfig {
  resource: string
  labelFields: string[]
  subField?: string
}

interface EntityConfig {
  autotask?: AutotaskEntityConfig
  halo?: HaloEntityConfig
}

/**
 * Which entities can be picked, and how to read them from each system. Keys
 * match the migration handler keys. Entities not listed here (agents, sites,
 * templates, documents, attachments) are derived or all-or-nothing and have no
 * record picker.
 */
export const BROWSE_CONFIG: Record<string, EntityConfig> = {
  companies: {
    autotask: { resource: 'Companies', labelFields: ['companyName'], searchField: 'companyName', subField: 'companyNumber' },
    halo: { resource: 'Client', labelFields: ['name'], subField: 'accountsid' },
  },
  contacts: {
    autotask: { resource: 'Contacts', labelFields: ['firstName', 'lastName'], searchField: 'lastName', subField: 'emailAddress' },
    halo: { resource: 'Users', labelFields: ['name'], subField: 'emailaddress' },
  },
  products: {
    autotask: { resource: 'Products', labelFields: ['name'], searchField: 'name', subField: 'sku' },
  },
  tickets: {
    autotask: { resource: 'Tickets', labelFields: ['title'], searchField: 'title', subField: 'ticketNumber' },
  },
  projects: {
    autotask: { resource: 'Projects', labelFields: ['projectName'], searchField: 'projectName', subField: 'projectNumber' },
  },
  opportunities: {
    autotask: { resource: 'Opportunities', labelFields: ['title'], searchField: 'title' },
  },
  contracts: {
    autotask: { resource: 'Contracts', labelFields: ['contractName'], searchField: 'contractName' },
  },
  kb_articles: {
    autotask: { resource: 'KnowledgeBaseArticles', labelFields: ['title'], searchField: 'title' },
  },
}

export function isBrowsable(entity: string): boolean {
  return entity in BROWSE_CONFIG
}

function joinLabel(item: Record<string, unknown>, fields: string[]): string {
  const value = fields
    .map((f) => item[f])
    .filter((v) => v !== null && v !== undefined && v !== '')
    .join(' ')
    .trim()
  return value || `#${item.id}`
}

export async function browseSource(
  orgId: string,
  connectionId: string,
  entity: string,
  search: string,
  page: number,
): Promise<{ items: SourceRecord[]; hasMore: boolean }> {
  const config = BROWSE_CONFIG[entity]
  if (!config) throw new Error(`Entity "${entity}" cannot be browsed`)

  const { system, client } = await clientFor(orgId, connectionId)
  const pageSize = 50

  if (system === 'autotask' && client instanceof AutotaskClient) {
    if (!config.autotask) throw new Error(`"${entity}" is not available from Autotask`)
    const { resource, labelFields, searchField, subField } = config.autotask
    const filter = search
      ? [{ op: 'contains' as const, field: searchField, value: search }]
      : [{ op: 'exist' as const, field: 'id' }]

    const result = await client.queryPage<Record<string, unknown> & { id: number }>(resource, {
      MaxRecords: pageSize,
      filter,
    })
    const items: SourceRecord[] = result.items.map((r) => ({
      id: String(r.id),
      label: joinLabel(r, labelFields),
      sub: subField ? (r[subField] ? String(r[subField]) : undefined) : undefined,
    }))
    return { items, hasMore: Boolean(result.pageDetails?.nextPageUrl) }
  }

  if (system === 'halo' && client instanceof HaloClient) {
    if (!config.halo) throw new Error(`"${entity}" is not available from Halo yet`)
    const { resource, labelFields, subField } = config.halo
    const result = await client.getPage<Record<string, unknown> & { id: number }>(resource, {
      search: search || undefined,
      page_size: pageSize,
      page_no: page,
      includeinactive: true,
    })
    const items: SourceRecord[] = result.items.map((r) => ({
      id: String(r.id),
      label: joinLabel(r, labelFields),
      sub: subField ? (r[subField] ? String(r[subField]) : undefined) : undefined,
    }))
    return { items, hasMore: items.length === pageSize }
  }

  throw new Error('Unsupported connection type')
}
