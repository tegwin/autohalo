/**
 * Shared HTTP plumbing for both PSA connectors.
 *
 * Both Autotask and Halo will rate-limit or transiently fail under the load a
 * bulk migration puts on them, so every call goes through one place that knows
 * how to back off, respect Retry-After, and give up cleanly.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  /** 4xx other than 429 means the request itself is wrong — do not retry. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500 || this.status === 0
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  body?: unknown
  /** Total attempts including the first. */
  retries?: number
  timeoutMs?: number
  signal?: AbortSignal
}

const DEFAULT_RETRIES = 4
const DEFAULT_TIMEOUT_MS = 45_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 30_000)
  }
  // 500ms, 1s, 2s, 4s… with jitter to avoid synchronised retries.
  const base = Math.min(500 * 2 ** attempt, 8_000)
  return base + Math.floor(Math.random() * 250)
}

export async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const {
    method = 'GET',
    headers = {},
    body,
    retries = DEFAULT_RETRIES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
  } = options

  let lastError: ApiError | null = null

  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const abortHandler = () => controller.abort()
    signal?.addEventListener('abort', abortHandler)

    try {
      const response = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store',
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const error = new ApiError(
          `${method} ${redact(url)} failed with ${response.status}`,
          response.status,
          text.slice(0, 2000),
          redact(url),
        )
        if (error.retryable && attempt < retries - 1) {
          lastError = error
          await sleep(backoffMs(attempt, response.headers.get('retry-after')))
          continue
        }
        throw error
      }

      if (response.status === 204) return undefined as T
      const text = await response.text()
      if (!text) return undefined as T
      try {
        return JSON.parse(text) as T
      } catch {
        throw new ApiError('Response was not valid JSON', response.status, text.slice(0, 500), redact(url))
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (!err.retryable || attempt === retries - 1) throw err
        lastError = err
      } else {
        // Network failure or timeout.
        const wrapped = new ApiError(
          err instanceof Error ? err.message : 'Network error',
          0,
          '',
          redact(url),
        )
        if (attempt === retries - 1) throw wrapped
        lastError = wrapped
      }
      await sleep(backoffMs(attempt, null))
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abortHandler)
    }
  }

  throw lastError ?? new ApiError('Request failed', 0, '', redact(url))
}

/** Strip query strings from URLs before they reach logs — filters can contain
 *  customer names, and tokens have been known to appear in query params. */
export function redact(url: string): string {
  const index = url.indexOf('?')
  return index === -1 ? url : `${url.slice(0, index)}?…`
}
