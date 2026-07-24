// Shared domain types. Kept hand-written rather than generated so the schema
// and the code review as one artefact.

export type SystemKind = 'autotask' | 'halo'
export type OrgRole = 'owner' | 'admin' | 'member'
export type RunStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
export type TaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
export type RunMode = 'dry_run' | 'live'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type Direction = 'autotask_to_halo' | 'halo_to_autotask'

export interface Org {
  id: string
  name: string
  slug: string
  created_at: string
  unlimited: boolean
}

export interface Profile {
  id: string
  email: string
  full_name: string | null
  is_platform_admin: boolean
  created_at: string
}

export interface Membership {
  org_id: string
  user_id: string
  role: OrgRole
  created_at: string
}

/** Non-secret connection settings. Safe to render in the browser. */
export interface AutotaskConfig {
  endpoint: string
  /** Cached from the zoneInformation lookup so we do not repeat it each run. */
  zoneUrl?: string
  username?: string
}

export interface HaloConfig {
  authUrl: string
  baseUrl: string
  tenant?: string
  clientId?: string
}

/** The decrypted secret envelope. Only ever materialised server-side. */
export interface AutotaskSecrets {
  username: string
  secret: string
  integrationCode: string
}

export interface HaloSecrets {
  clientId: string
  clientSecret: string
}

export interface Connection {
  id: string
  org_id: string
  system: SystemKind
  label: string
  config: AutotaskConfig | HaloConfig | Record<string, unknown>
  last_verified_at: string | null
  last_verify_error: string | null
  created_at: string
  updated_at: string
}

export interface Entitlement {
  id: string
  org_id: string
  kind: 'single_run' | 'admin_grant'
  consumed_by_run_id: string | null
  consumed_at: string | null
  stripe_checkout_session_id: string | null
  stripe_payment_intent_id: string | null
  amount_total: number | null
  currency: string | null
  granted_by: string | null
  note: string | null
  created_at: string
}

export interface RunSelection {
  /** Entity keys the user ticked, e.g. ['companies', 'contacts', 'tickets']. */
  entities: string[]
  /** Only migrate records created on/after this ISO date. */
  since?: string
  until?: string
  /** Restrict to specific source company ids. Empty means all. */
  companyIds?: string[]
  /** Per-entity overrides, e.g. { tickets: { includeTimeEntries: false } }. */
  options?: Record<string, Record<string, unknown>>
}

export interface RunStats {
  processed?: number
  created?: number
  updated?: number
  skipped?: number
  failed?: number
}

export interface MigrationRun {
  id: string
  org_id: string
  created_by: string | null
  source_connection: string
  target_connection: string
  direction: Direction
  mode: RunMode
  status: RunStatus
  selection: RunSelection
  stats: RunStats
  error: string | null
  started_at: string | null
  finished_at: string | null
  leased_until: string | null
  lease_holder: string | null
  created_at: string
  updated_at: string
}

export interface RunTask {
  id: string
  run_id: string
  org_id: string
  entity: string
  phase: string
  seq: number
  status: TaskStatus
  cursor: TaskCursor | null
  processed: number
  created_count: number
  updated_count: number
  skipped_count: number
  failed_count: number
  total_estimate: number | null
  attempts: number
  last_error: string | null
  next_attempt_at: string | null
  started_at: string | null
  finished_at: string | null
  updated_at: string
}

/**
 * Everything the engine needs to resume an entity mid-flight. Persisted after
 * every slice, so a function timeout costs at most one slice of work.
 */
export interface TaskCursor {
  /** Page number for page-based sources (Autotask, Halo). */
  page?: number
  /** Opaque next-page URL when the API hands one back. */
  nextUrl?: string | null
  /** Index within the current page, for partial pages. */
  offset?: number
  /** Set once the source reports no further pages. */
  drained?: boolean
  /** Free-form per-entity state (e.g. the parent id list still to walk). */
  extra?: Record<string, unknown>
}

export interface RunLog {
  id: number
  run_id: string
  org_id: string
  level: LogLevel
  entity: string | null
  message: string
  context: Record<string, unknown> | null
  created_at: string
}

export interface RunFailure {
  id: string
  run_id: string
  org_id: string
  entity: string
  source_id: string | null
  source_name: string | null
  error: string
  payload: Record<string, unknown> | null
  resolved: boolean
  created_at: string
}
