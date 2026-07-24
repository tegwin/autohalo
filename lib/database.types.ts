import type {
  AutotaskConfig,
  Direction,
  HaloConfig,
  LogLevel,
  OrgRole,
  RunMode,
  RunSelection,
  RunStats,
  RunStatus,
  SystemKind,
  TaskCursor,
  TaskStatus,
} from './types'

/**
 * Typed schema for the Supabase client.
 *
 * Hand-written to match supabase/migrations/0001_init.sql rather than
 * generated, so the two live side by side in review and a schema change that
 * is not reflected here shows up as a type error rather than a runtime one.
 *
 * `Insert` marks database-defaulted columns optional; `Update` makes everything
 * optional. That is what gives `.update({...})` and `.insert({...})` real
 * checking instead of collapsing to `never`.
 */

type Timestamp = string

type Relationship = {
  foreignKeyName: string
  columns: string[]
  isOneToOne?: boolean
  referencedRelation: string
  referencedColumns: string[]
}

type TableDef<Row, Insert, Update, Rels extends Relationship[] = []> = {
  Row: Row
  Insert: Insert
  Update: Update
  Relationships: Rels
}

/**
 * Foreign keys that the client actually embeds via `select('..., other(*)')`.
 * Only the joins we use need declaring; the rest stay as empty tuples.
 */
type MembershipRelationships = [
  {
    foreignKeyName: 'memberships_user_id_fkey'
    columns: ['user_id']
    isOneToOne: false
    referencedRelation: 'profiles'
    referencedColumns: ['id']
  },
  {
    foreignKeyName: 'memberships_org_id_fkey'
    columns: ['org_id']
    isOneToOne: false
    referencedRelation: 'orgs'
    referencedColumns: ['id']
  },
]

export type OrgRow = {
  id: string
  name: string
  slug: string
  created_at: Timestamp
  unlimited: boolean
  trial_runs_remaining: number
  trial_sample_size: number
}

export type ProfileRow = {
  id: string
  email: string
  full_name: string | null
  is_platform_admin: boolean
  created_at: Timestamp
}

export type MembershipRow = {
  org_id: string
  user_id: string
  role: OrgRole
  created_at: Timestamp
}

export type ConnectionRow = {
  id: string
  org_id: string
  system: SystemKind
  label: string
  config: AutotaskConfig | HaloConfig | Record<string, unknown>
  secret_ciphertext: string | null
  secret_iv: string | null
  secret_tag: string | null
  key_version: number
  last_verified_at: Timestamp | null
  last_verify_error: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

export type EntitlementRow = {
  id: string
  org_id: string
  kind: 'single_run' | 'admin_grant'
  consumed_by_run_id: string | null
  consumed_at: Timestamp | null
  stripe_checkout_session_id: string | null
  stripe_payment_intent_id: string | null
  amount_total: number | null
  currency: string | null
  granted_by: string | null
  note: string | null
  created_at: Timestamp
}

export type MigrationRunRow = {
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
  started_at: Timestamp | null
  finished_at: Timestamp | null
  leased_until: Timestamp | null
  lease_holder: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

export type RunTaskRow = {
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
  next_attempt_at: Timestamp | null
  started_at: Timestamp | null
  finished_at: Timestamp | null
  updated_at: Timestamp
}

export type IdMapRow = {
  id: string
  org_id: string
  entity: string
  source_system: SystemKind
  source_id: string
  target_system: SystemKind
  target_id: string
  target_connection: string | null
  content_hash: string | null
  run_id: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

export type RunLogRow = {
  id: number
  run_id: string
  org_id: string
  level: LogLevel
  entity: string | null
  message: string
  context: Record<string, unknown> | null
  created_at: Timestamp
}

export type RunFailureRow = {
  id: string
  run_id: string
  org_id: string
  entity: string
  source_id: string | null
  source_name: string | null
  error: string
  payload: Record<string, unknown> | null
  resolved: boolean
  created_at: Timestamp
}

export type StripeEventRow = {
  id: string
  type: string
  processed_at: Timestamp
}

/** Columns with database defaults are optional on insert. */
type Insertable<Row, Defaulted extends keyof Row> = Omit<Row, Defaulted> &
  Partial<Pick<Row, Defaulted>>

export type Database = {
  public: {
    Tables: {
      orgs: TableDef<
        OrgRow,
        Insertable<OrgRow, 'id' | 'created_at' | 'unlimited' | 'trial_runs_remaining' | 'trial_sample_size'>,
        Partial<OrgRow>
      >
      profiles: TableDef<
        ProfileRow,
        Insertable<ProfileRow, 'full_name' | 'is_platform_admin' | 'created_at'>,
        Partial<ProfileRow>
      >
      memberships: TableDef<
        MembershipRow,
        Insertable<MembershipRow, 'role' | 'created_at'>,
        Partial<MembershipRow>,
        MembershipRelationships
      >
      connections: TableDef<
        ConnectionRow,
        Insertable<
          ConnectionRow,
          | 'id'
          | 'config'
          | 'secret_ciphertext'
          | 'secret_iv'
          | 'secret_tag'
          | 'key_version'
          | 'last_verified_at'
          | 'last_verify_error'
          | 'created_at'
          | 'updated_at'
        >,
        Partial<ConnectionRow>
      >
      entitlements: TableDef<
        EntitlementRow,
        Insertable<
          EntitlementRow,
          | 'id'
          | 'kind'
          | 'consumed_by_run_id'
          | 'consumed_at'
          | 'stripe_checkout_session_id'
          | 'stripe_payment_intent_id'
          | 'amount_total'
          | 'currency'
          | 'granted_by'
          | 'note'
          | 'created_at'
        >,
        Partial<EntitlementRow>
      >
      migration_runs: TableDef<
        MigrationRunRow,
        Insertable<
          MigrationRunRow,
          | 'id'
          | 'created_by'
          | 'mode'
          | 'status'
          | 'selection'
          | 'stats'
          | 'error'
          | 'started_at'
          | 'finished_at'
          | 'leased_until'
          | 'lease_holder'
          | 'created_at'
          | 'updated_at'
        >,
        Partial<MigrationRunRow>
      >
      run_tasks: TableDef<
        RunTaskRow,
        Insertable<
          RunTaskRow,
          | 'id'
          | 'phase'
          | 'status'
          | 'cursor'
          | 'processed'
          | 'created_count'
          | 'updated_count'
          | 'skipped_count'
          | 'failed_count'
          | 'total_estimate'
          | 'attempts'
          | 'last_error'
          | 'next_attempt_at'
          | 'started_at'
          | 'finished_at'
          | 'updated_at'
        >,
        Partial<RunTaskRow>
      >
      id_map: TableDef<
        IdMapRow,
        Insertable<IdMapRow, 'id' | 'target_connection' | 'content_hash' | 'run_id' | 'created_at' | 'updated_at'>,
        Partial<IdMapRow>
      >
      run_logs: TableDef<
        RunLogRow,
        Insertable<RunLogRow, 'id' | 'level' | 'entity' | 'context' | 'created_at'>,
        Partial<RunLogRow>
      >
      run_failures: TableDef<
        RunFailureRow,
        Insertable<
          RunFailureRow,
          'id' | 'source_id' | 'source_name' | 'payload' | 'resolved' | 'created_at'
        >,
        Partial<RunFailureRow>
      >
      stripe_events: TableDef<
        StripeEventRow,
        Insertable<StripeEventRow, 'processed_at'>,
        Partial<StripeEventRow>
      >
    }
    Views: Record<never, never>
    Functions: {
      consume_entitlement: {
        Args: { p_org_id: string; p_run_id: string }
        Returns: boolean
      }
      consume_trial_run: {
        Args: { p_org_id: string }
        Returns: boolean
      }
      grant_trial_runs: {
        Args: { p_org_id: string; p_count: number }
        Returns: undefined
      }
      claim_run: {
        Args: { p_holder: string; p_lease_seconds?: number }
        Returns: string | null
      }
      is_platform_admin: { Args: Record<never, never>; Returns: boolean }
      is_org_member: { Args: { target_org: string }; Returns: boolean }
      is_org_admin: { Args: { target_org: string }; Returns: boolean }
    }
    Enums: {
      org_role: OrgRole
      system_kind: SystemKind
      run_status: RunStatus
      task_status: TaskStatus
      run_mode: RunMode
      entitlement_kind: 'single_run' | 'admin_grant'
      log_level: LogLevel
    }
    CompositeTypes: Record<never, never>
  }
}
