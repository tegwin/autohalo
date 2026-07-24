import { ApiError, request } from './http'
import type { AutotaskConfig, AutotaskSecrets } from '../types'

/**
 * Autotask REST API client.
 *
 * Reference points that shaped this:
 *  - Auth is three headers, not a bearer token: ApiIntegrationCode, UserName,
 *    Secret. There is no token to refresh.
 *  - A username is pinned to a zone. Hitting the wrong zone returns data-free
 *    errors, so we resolve zoneInformation once and cache it on the connection.
 *  - Queries are `GET {entity}/query?search=<json>` for small filters and
 *    `POST {entity}/query` for large ones. Paging is by nextPageUrl, which is
 *    the only reliable way to walk a large result set.
 *  - The API enforces an hourly request threshold per integration code. We
 *    read it so a migration can slow down rather than get cut off.
 */

export interface AutotaskFilter {
  op:
    | 'eq'
    | 'noteq'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'beginsWith'
    | 'endsWith'
    | 'contains'
    | 'exist'
    | 'notExist'
    | 'in'
    | 'notIn'
    | 'and'
    | 'or'
  field?: string
  value?: unknown
  udf?: boolean
  items?: AutotaskFilter[]
}

export interface AutotaskQuery {
  filter: AutotaskFilter[]
  MaxRecords?: number
  IncludeFields?: string[]
}

export interface AutotaskPage<T> {
  items: T[]
  pageDetails: {
    count: number
    requestCount: number
    prevPageUrl: string | null
    nextPageUrl: string | null
  }
}

export interface PicklistValue {
  value: string
  label: string
  isDefaultValue: boolean
  isActive: boolean
}

export interface FieldInfo {
  name: string
  dataType: string
  isRequired: boolean
  isPickList: boolean
  picklistValues?: PicklistValue[]
}

const ZONE_DISCOVERY_URL =
  'https://webservices.autotask.net/atservicesrest/v1.0/zoneInformation'

export class AutotaskClient {
  private baseUrl: string
  private picklistCache = new Map<string, FieldInfo[]>()

  constructor(
    config: AutotaskConfig,
    private secrets: AutotaskSecrets,
  ) {
    this.baseUrl = normaliseBase(config.zoneUrl || config.endpoint)
  }

  private get headers(): Record<string, string> {
    return {
      ApiIntegrationCode: this.secrets.integrationCode,
      UserName: this.secrets.username,
      Secret: this.secrets.secret,
    }
  }

  /**
   * Ask Autotask which zone this username lives in. Cheap, unauthenticated,
   * and saves every subsequent call from guessing at webservicesN.
   */
  static async discoverZone(username: string): Promise<string> {
    const res = await request<{ url: string; webUrl: string; ci: number }>(
      `${ZONE_DISCOVERY_URL}?user=${encodeURIComponent(username)}`,
      { retries: 2 },
    )
    return normaliseBase(res.url)
  }

  /** Verifies credentials with the cheapest authenticated call available. */
  async verify(): Promise<{ ok: true; threshold: ThresholdInfo } | { ok: false; error: string }> {
    try {
      const threshold = await this.threshold()
      return { ok: true, threshold }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401 || err.status === 403) {
          return { ok: false, error: 'Autotask rejected those credentials (401/403).' }
        }
        return { ok: false, error: `Autotask returned ${err.status}. ${err.body.slice(0, 200)}` }
      }
      return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' }
    }
  }

  async threshold(): Promise<ThresholdInfo> {
    const res = await request<{ externalRequestThreshold: number; requestThresholdTimeframe: number; currentTimeframeRequestCount: number }>(
      `${this.baseUrl}/ThresholdInformation`,
      { headers: this.headers, retries: 2 },
    )
    return {
      limit: res.externalRequestThreshold ?? 0,
      used: res.currentTimeframeRequestCount ?? 0,
      timeframeMinutes: res.requestThresholdTimeframe ?? 60,
    }
  }

  /**
   * One page of a query. Pass `nextUrl` from a previous page to continue;
   * Autotask's nextPageUrl already encodes the filter and position.
   */
  async queryPage<T>(
    entity: string,
    query: AutotaskQuery,
    nextUrl?: string | null,
  ): Promise<AutotaskPage<T>> {
    if (nextUrl) {
      return request<AutotaskPage<T>>(nextUrl, { headers: this.headers })
    }
    // POST avoids URL length limits when a filter carries many ids.
    return request<AutotaskPage<T>>(`${this.baseUrl}/${entity}/query`, {
      method: 'POST',
      headers: this.headers,
      body: query,
    })
  }

  /** Walks every page of a query. Only for small sets — the engine pages. */
  async queryAll<T>(entity: string, query: AutotaskQuery, cap = 5000): Promise<T[]> {
    const out: T[] = []
    let next: string | null | undefined
    do {
      const page: AutotaskPage<T> = await this.queryPage<T>(entity, query, next)
      out.push(...page.items)
      next = page.pageDetails?.nextPageUrl
    } while (next && out.length < cap)
    return out
  }

  async getById<T>(entity: string, id: string | number): Promise<T | null> {
    try {
      const res = await request<{ item: T }>(`${this.baseUrl}/${entity}/${id}`, {
        headers: this.headers,
      })
      return res.item ?? null
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null
      throw err
    }
  }

  /** Child collections, e.g. Companies/{id}/Contacts or Tickets/{id}/Notes. */
  async queryChild<T>(
    parentEntity: string,
    parentId: string | number,
    childEntity: string,
    query: AutotaskQuery,
    nextUrl?: string | null,
  ): Promise<AutotaskPage<T>> {
    if (nextUrl) return request<AutotaskPage<T>>(nextUrl, { headers: this.headers })
    return request<AutotaskPage<T>>(
      `${this.baseUrl}/${parentEntity}/${parentId}/${childEntity}/query`,
      { method: 'POST', headers: this.headers, body: query },
    )
  }

  async create(entity: string, payload: Record<string, unknown>): Promise<{ itemId: number }> {
    return request<{ itemId: number }>(`${this.baseUrl}/${entity}`, {
      method: 'POST',
      headers: this.headers,
      body: payload,
    })
  }

  async update(entity: string, payload: Record<string, unknown>): Promise<{ itemId: number }> {
    return request<{ itemId: number }>(`${this.baseUrl}/${entity}`, {
      method: 'PATCH',
      headers: this.headers,
      body: payload,
    })
  }

  /** Child creates use the parent-scoped URL, e.g. Companies/{id}/Contacts. */
  async createChild(
    parentEntity: string,
    parentId: string | number,
    childEntity: string,
    payload: Record<string, unknown>,
  ): Promise<{ itemId: number }> {
    return request<{ itemId: number }>(
      `${this.baseUrl}/${parentEntity}/${parentId}/${childEntity}`,
      { method: 'POST', headers: this.headers, body: payload },
    )
  }

  /**
   * Field metadata, including picklist values. We use it to translate picklist
   * ids into labels (and back) rather than hardcoding numeric ids that differ
   * between Autotask instances.
   */
  async fields(entity: string): Promise<FieldInfo[]> {
    const cached = this.picklistCache.get(entity)
    if (cached) return cached
    const res = await request<{ fields: FieldInfo[] }>(
      `${this.baseUrl}/${entity}/entityInformation/fields`,
      { headers: this.headers },
    )
    const fields = res.fields ?? []
    this.picklistCache.set(entity, fields)
    return fields
  }

  async picklist(entity: string, field: string): Promise<PicklistValue[]> {
    const fields = await this.fields(entity)
    const match = fields.find((f) => f.name.toLowerCase() === field.toLowerCase())
    return match?.picklistValues ?? []
  }

  /** Resolve a picklist id to its human label, for mapping into Halo. */
  async picklistLabel(entity: string, field: string, value: unknown): Promise<string | null> {
    if (value === null || value === undefined) return null
    const values = await this.picklist(entity, field)
    return values.find((v) => v.value === String(value))?.label ?? null
  }

  /** Resolve a label back to a picklist id, for writing into Autotask. */
  async picklistValue(entity: string, field: string, label: string | null): Promise<number | null> {
    if (!label) return null
    const values = await this.picklist(entity, field)
    const match =
      values.find((v) => v.label.toLowerCase() === label.toLowerCase() && v.isActive) ??
      values.find((v) => v.label.toLowerCase() === label.toLowerCase())
    return match ? Number(match.value) : null
  }

  /** User-defined fields, so custom data survives the trip. */
  async userDefinedFields(entity: string): Promise<{ name: string; label: string }[]> {
    try {
      const res = await request<{ fields: { name: string; label: string }[] }>(
        `${this.baseUrl}/${entity}/entityInformation/userDefinedFields`,
        { headers: this.headers },
      )
      return res.fields ?? []
    } catch {
      return []
    }
  }
}

export interface ThresholdInfo {
  limit: number
  used: number
  timeframeMinutes: number
}

function normaliseBase(url: string): string {
  let base = url.trim().replace(/\/+$/, '')
  // Zone discovery hands back https://webservicesN.autotask.net/ATServicesRest
  // whereas users typically paste the full .../v1.0 endpoint. Accept both.
  if (!/\/v1\.0$/i.test(base)) {
    base = `${base}/v1.0`
  }
  return base
}

export const EXISTS_ANY: AutotaskFilter[] = [{ op: 'exist', field: 'id' }]

/** Builds the standard "everything, optionally date-bounded" filter. */
export function baseFilter(opts: {
  since?: string
  until?: string
  dateField?: string
  companyIds?: string[]
  companyField?: string
}): AutotaskFilter[] {
  const filter: AutotaskFilter[] = [{ op: 'exist', field: 'id' }]
  const dateField = opts.dateField ?? 'createDate'
  if (opts.since) filter.push({ op: 'gte', field: dateField, value: new Date(opts.since).toISOString() })
  if (opts.until) filter.push({ op: 'lte', field: dateField, value: new Date(opts.until).toISOString() })
  if (opts.companyIds?.length) {
    filter.push({ op: 'in', field: opts.companyField ?? 'companyID', value: opts.companyIds })
  }
  return filter
}
