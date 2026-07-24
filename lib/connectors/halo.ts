import { ApiError, request } from './http'
import type { HaloConfig, HaloSecrets } from '../types'

/**
 * HaloPSA API client.
 *
 * Shape of the API that matters here:
 *  - OAuth2 client_credentials against {authUrl}/token, with `tenant` required
 *    on hosted multi-tenant instances. Tokens last ~1h; we cache per client id.
 *  - Collections are GET /{Resource}?pageinate=true&page_size=&page_no= and the
 *    array comes back under a resource-specific key ("clients", "tickets"…),
 *    with record_count alongside. getPage() normalises that.
 *  - Writes are POST with an ARRAY body even for a single record, and the
 *    response is the created object. Passing a bare object silently no-ops on
 *    several endpoints, which is a classic Halo integration trap.
 *  - Tickets are the universal container: projects, opportunities, changes and
 *    project tasks are all tickets distinguished by tickettype_id.
 */

interface CachedToken {
  token: string
  expiresAt: number
}

const tokenCache = new Map<string, CachedToken>()

export interface HaloPage<T> {
  items: T[]
  recordCount: number
  pageSize: number
  pageNo: number
}

export class HaloClient {
  private baseUrl: string
  private authUrl: string

  constructor(
    private config: HaloConfig,
    private secrets: HaloSecrets,
  ) {
    this.baseUrl = config.baseUrl.trim().replace(/\/+$/, '')
    this.authUrl = config.authUrl.trim().replace(/\/+$/, '')
  }

  private get cacheKey(): string {
    return `${this.authUrl}|${this.secrets.clientId}|${this.config.tenant ?? ''}`
  }

  async token(): Promise<string> {
    const cached = tokenCache.get(this.cacheKey)
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token

    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.secrets.clientId,
      client_secret: this.secrets.clientSecret,
      scope: 'all',
    })
    if (this.config.tenant) form.set('tenant', this.config.tenant)

    const url = this.authUrl.endsWith('/token') ? this.authUrl : `${this.authUrl}/token`

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      cache: 'no-store',
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new ApiError(
        `Halo token request failed with ${res.status}`,
        res.status,
        body.slice(0, 500),
        url,
      )
    }

    const data = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!data.access_token) {
      throw new ApiError('Halo token response contained no access_token', 200, '', url)
    }

    tokenCache.set(this.cacheKey, {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    })
    return data.access_token
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.token()}` }
  }

  async verify(): Promise<{ ok: true; agentCount: number } | { ok: false; error: string }> {
    try {
      await this.token()
      const page = await this.getPage<{ id: number }>('Agent', { page_size: 1, page_no: 1 })
      return { ok: true, agentCount: page.recordCount }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 400 || err.status === 401) {
          return {
            ok: false,
            error:
              'Halo rejected those credentials. Check the client id/secret, the tenant, and that the API application has the "all" scope.',
          }
        }
        return { ok: false, error: `Halo returned ${err.status}. ${err.body.slice(0, 200)}` }
      }
      return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' }
    }
  }

  /**
   * A page of a collection. Halo nests the array under a per-resource key that
   * does not always match the endpoint name, so we take the first array-valued
   * property rather than guessing.
   */
  async getPage<T>(
    resource: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<HaloPage<T>> {
    const search = new URLSearchParams()
    search.set('pageinate', 'true')
    search.set('page_size', String(params.page_size ?? 100))
    search.set('page_no', String(params.page_no ?? 1))
    for (const [key, value] of Object.entries(params)) {
      if (key === 'page_size' || key === 'page_no') continue
      if (value === undefined) continue
      search.set(key, String(value))
    }

    const res = await request<Record<string, unknown>>(
      `${this.baseUrl}/${resource}?${search.toString()}`,
      { headers: await this.authHeaders() },
    )

    const items = firstArray<T>(res, resource)
    return {
      items,
      recordCount: Number(res.record_count ?? items.length),
      pageSize: Number(res.page_size ?? params.page_size ?? 100),
      pageNo: Number(res.page_no ?? params.page_no ?? 1),
    }
  }

  async getOne<T>(resource: string, id: string | number, params: Record<string, string | number | boolean> = {}): Promise<T | null> {
    const search = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) search.set(k, String(v))
    const qs = search.toString()
    try {
      return await request<T>(
        `${this.baseUrl}/${resource}/${id}${qs ? `?${qs}` : ''}`,
        { headers: await this.authHeaders() },
      )
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null
      throw err
    }
  }

  /**
   * Create or update. Halo upserts on `id`: include one to update, omit it to
   * create. The array wrapper is mandatory.
   */
  async post<T>(resource: string, payload: Record<string, unknown>): Promise<T> {
    return request<T>(`${this.baseUrl}/${resource}`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: [payload],
    })
  }

  async postMany<T>(resource: string, payloads: Record<string, unknown>[]): Promise<T> {
    return request<T>(`${this.baseUrl}/${resource}`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: payloads,
    })
  }

  async delete(resource: string, id: string | number): Promise<void> {
    await request<void>(`${this.baseUrl}/${resource}/${id}`, {
      method: 'DELETE',
      headers: await this.authHeaders(),
    })
  }

  /** Walks a whole collection. For bounded lookup sets only. */
  async getAll<T>(
    resource: string,
    params: Record<string, string | number | boolean | undefined> = {},
    cap = 10_000,
  ): Promise<T[]> {
    const out: T[] = []
    let pageNo = 1
    const pageSize = Number(params.page_size ?? 100)
    for (;;) {
      const page = await this.getPage<T>(resource, { ...params, page_no: pageNo, page_size: pageSize })
      out.push(...page.items)
      if (page.items.length < pageSize || out.length >= cap) break
      if (page.recordCount && out.length >= page.recordCount) break
      pageNo++
    }
    return out
  }

  /**
   * Halo lookups (statuses, priorities, ticket types, categories). Cached per
   * client instance because a migration resolves them constantly.
   */
  private lookupCache = new Map<string, unknown[]>()

  async lookup<T>(resource: string, params: Record<string, string | number | boolean> = {}): Promise<T[]> {
    const key = `${resource}:${JSON.stringify(params)}`
    const cached = this.lookupCache.get(key)
    if (cached) return cached as T[]
    const values = await this.getAll<T>(resource, params, 2000)
    this.lookupCache.set(key, values)
    return values
  }
}

/**
 * Halo responses look like { clients: [...], record_count: n }. The key does
 * not reliably match the resource ("Client" -> "clients", "KBArticle" ->
 * "articles"), so prefer an exact-ish match then fall back to the first array.
 */
function firstArray<T>(res: Record<string, unknown>, resource: string): T[] {
  const guess = `${resource.toLowerCase()}s`
  if (Array.isArray(res[guess])) return res[guess] as T[]
  if (Array.isArray(res[resource.toLowerCase()])) return res[resource.toLowerCase()] as T[]
  for (const value of Object.values(res)) {
    if (Array.isArray(value)) return value as T[]
  }
  return []
}
