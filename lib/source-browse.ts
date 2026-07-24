import { AutotaskClient, type AutotaskFilter } from './connectors/autotask'
import { HaloClient } from './connectors/halo'
import { clientFor } from './connectors/credentials'

/**
 * Live record browsing for the migration wizard's per-entity data grids.
 *
 * Returns a paged table — columns plus rows — so the wizard can render the same
 * grid-with-filters the PHP importer used: tick rows to migrate, filter each
 * column, page through the results. Read-only and paged so a tenant with tens
 * of thousands of records stays responsive.
 */

export interface GridRow {
  /** Source id, used for selection. */
  _id: string
  /** Human label for the selection chip (the primary column's value). */
  _label: string
  /** Column values, keyed by column name. */
  [column: string]: string
}

export interface GridResult {
  columns: string[]
  rows: GridRow[]
  page: number
  totalPages: number
  total: number
}

interface SideConfig {
  resource: string
  /** The column whose value labels a selected row. */
  label: string
  /** Columns shown in the grid, in order. */
  columns: string[]
  /** Columns that support server-side text filtering (Autotask `contains`). */
  filterable?: string[]
}

interface EntityConfig {
  autotask?: SideConfig
  halo?: SideConfig
}

const PAGE_SIZE = 50

/**
 * Per-entity grid config, keyed by migration handler key. Column names are the
 * raw API field names on each side. Entities not listed have no picker.
 */
export const BROWSE_CONFIG: Record<string, EntityConfig> = {
  companies: {
    autotask: {
      resource: 'Companies',
      label: 'companyName',
      columns: ['companyName', 'phone', 'address1', 'address2', 'city', 'state', 'postalCode'],
      filterable: ['companyName', 'city', 'state', 'postalCode'],
    },
    halo: { resource: 'Client', label: 'name', columns: ['name', 'accountsid'], filterable: ['name'] },
  },
  contacts: {
    autotask: {
      resource: 'Contacts',
      label: 'lastName',
      columns: ['firstName', 'lastName', 'emailAddress', 'phone', 'title'],
      filterable: ['firstName', 'lastName', 'emailAddress'],
    },
    halo: { resource: 'Users', label: 'name', columns: ['name', 'emailaddress'], filterable: ['name'] },
  },
  products: {
    autotask: {
      resource: 'Products',
      label: 'name',
      columns: ['name', 'sku', 'unitCost', 'unitPrice'],
      filterable: ['name', 'sku'],
    },
  },
  tickets: {
    autotask: {
      resource: 'Tickets',
      label: 'title',
      columns: ['ticketNumber', 'title', 'status'],
      filterable: ['title', 'ticketNumber'],
    },
  },
  projects: {
    autotask: {
      resource: 'Projects',
      label: 'projectName',
      columns: ['projectName', 'projectNumber', 'status'],
      filterable: ['projectName', 'projectNumber'],
    },
  },
  opportunities: {
    autotask: {
      resource: 'Opportunities',
      label: 'title',
      columns: ['title', 'amount', 'stage'],
      filterable: ['title'],
    },
  },
  contracts: {
    autotask: {
      resource: 'Contracts',
      label: 'contractName',
      columns: ['contractName', 'startDate', 'endDate'],
      filterable: ['contractName'],
    },
  },
  kb_articles: {
    autotask: {
      resource: 'KnowledgeBaseArticles',
      label: 'title',
      columns: ['title'],
      filterable: ['title'],
    },
  },
}

export function isBrowsable(entity: string): boolean {
  return entity in BROWSE_CONFIG
}

function str(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
}

export async function browseSource(
  orgId: string,
  connectionId: string,
  entity: string,
  filters: Record<string, string>,
  page: number,
): Promise<GridResult> {
  const config = BROWSE_CONFIG[entity]
  if (!config) throw new Error(`Entity "${entity}" cannot be browsed`)

  const { system, client } = await clientFor(orgId, connectionId)
  const pageNo = Math.max(1, page)

  if (system === 'autotask' && client instanceof AutotaskClient) {
    if (!config.autotask) throw new Error(`"${entity}" is not available from Autotask`)
    const side = config.autotask

    const filterClauses: AutotaskFilter[] = []
    for (const field of side.filterable ?? []) {
      const value = filters[field]?.trim()
      if (value) filterClauses.push({ op: 'contains', field, value })
    }
    if (!filterClauses.length) filterClauses.push({ op: 'exist', field: 'id' })

    const result = await client.queryByPage<Record<string, unknown> & { id: number }>(
      side.resource,
      { MaxRecords: PAGE_SIZE, IncludeFields: ['id', ...side.columns], filter: filterClauses },
      pageNo,
    )

    const total = result.pageDetails?.count ?? result.items.length
    return {
      columns: side.columns,
      rows: result.items.map((item) => toRow(item, side)),
      page: pageNo,
      totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      total,
    }
  }

  if (system === 'halo' && client instanceof HaloClient) {
    if (!config.halo) throw new Error(`"${entity}" is not available from Halo yet`)
    const side = config.halo
    const search = filters[side.label]?.trim()

    const result = await client.getPage<Record<string, unknown> & { id: number }>(side.resource, {
      search: search || undefined,
      page_size: PAGE_SIZE,
      page_no: pageNo,
      includeinactive: true,
    })

    return {
      columns: side.columns,
      rows: result.items.map((item) => toRow(item, side)),
      page: pageNo,
      totalPages: Math.max(1, Math.ceil((result.recordCount || result.items.length) / PAGE_SIZE)),
      total: result.recordCount || result.items.length,
    }
  }

  throw new Error('Unsupported connection type')
}

function toRow(item: Record<string, unknown> & { id: number }, side: SideConfig): GridRow {
  const row: GridRow = { _id: String(item.id), _label: str(item[side.label]) || `#${item.id}` }
  for (const col of side.columns) row[col] = str(item[col])
  return row
}
