import { createAdminClient } from '../supabase/admin'
import { contentHash } from '../crypto'
import { AutotaskClient } from '../connectors/autotask'
import { HaloClient } from '../connectors/halo'
import type {
  Direction,
  LogLevel,
  MigrationRun,
  RunSelection,
  SystemKind,
} from '../types'

/**
 * Everything a handler needs for one slice of work, plus the deadline that
 * makes serverless execution safe: handlers check `expired()` between records
 * and return their cursor, rather than being killed mid-write.
 */
export class MigrationContext {
  readonly orgId: string
  readonly runId: string
  readonly direction: Direction
  readonly mode: 'dry_run' | 'live'
  readonly selection: RunSelection
  readonly sourceSystem: SystemKind
  readonly targetSystem: SystemKind

  private readonly deadline: number
  private logBuffer: {
    run_id: string
    org_id: string
    level: LogLevel
    entity: string | null
    message: string
    context: Record<string, unknown> | null
  }[] = []

  constructor(
    run: MigrationRun,
    readonly source: AutotaskClient | HaloClient,
    readonly target: AutotaskClient | HaloClient,
    deadlineMs: number,
    public entity: string,
  ) {
    this.orgId = run.org_id
    this.runId = run.id
    this.direction = run.direction
    this.mode = run.mode
    this.selection = run.selection ?? { entities: [] }
    this.sourceSystem = run.direction === 'autotask_to_halo' ? 'autotask' : 'halo'
    this.targetSystem = run.direction === 'autotask_to_halo' ? 'halo' : 'autotask'
    this.deadline = deadlineMs
  }

  /** True once we are close enough to the function limit to stop cleanly. */
  expired(): boolean {
    return Date.now() >= this.deadline
  }

  msRemaining(): number {
    return Math.max(0, this.deadline - Date.now())
  }

  get autotask(): AutotaskClient {
    const client = this.sourceSystem === 'autotask' ? this.source : this.target
    if (!(client instanceof AutotaskClient)) throw new Error('Autotask client not available on this run')
    return client
  }

  get halo(): HaloClient {
    const client = this.sourceSystem === 'halo' ? this.source : this.target
    if (!(client instanceof HaloClient)) throw new Error('Halo client not available on this run')
    return client
  }

  /**
   * A "trial" run (mode dry_run) copies a small random sample of real records
   * so the customer can verify the result in their target system before paying
   * for the full run. It writes, unlike a conventional dry run — hence the
   * distinct name.
   */
  get isTrial(): boolean {
    return this.mode === 'dry_run'
  }

  // -------------------------------------------------------------------------
  // id_map
  // -------------------------------------------------------------------------

  /** The target id a source record was previously written to, if any. */
  async lookupTarget(entity: string, sourceId: string): Promise<{ targetId: string; hash: string | null } | null> {
    const supabase = createAdminClient()
    const { data } = await supabase
      .from('id_map')
      .select('target_id, content_hash')
      .eq('org_id', this.orgId)
      .eq('entity', entity)
      .eq('source_system', this.sourceSystem)
      .eq('source_id', String(sourceId))
      .eq('target_system', this.targetSystem)
      .maybeSingle<{ target_id: string; content_hash: string | null }>()
    return data ? { targetId: data.target_id, hash: data.content_hash } : null
  }

  /**
   * Translate a foreign key from source ids to target ids. Used constantly:
   * a ticket's companyID must become the Halo client_id that company became.
   */
  async mapForeignKey(entity: string, sourceId: string | number | null | undefined): Promise<string | null> {
    if (sourceId === null || sourceId === undefined || sourceId === '') return null
    const hit = await this.lookupTarget(entity, String(sourceId))
    return hit?.targetId ?? null
  }

  async recordMapping(
    entity: string,
    sourceId: string,
    targetId: string,
    payload: unknown,
  ): Promise<void> {
    const supabase = createAdminClient()
    await supabase.from('id_map').upsert(
      {
        org_id: this.orgId,
        entity,
        source_system: this.sourceSystem,
        source_id: String(sourceId),
        target_system: this.targetSystem,
        target_id: String(targetId),
        content_hash: contentHash(payload),
        run_id: this.runId,
      },
      { onConflict: 'org_id,entity,source_system,source_id,target_system' },
    )
  }

  /** Bulk prefetch of mappings for a page, to avoid N round-trips per page. */
  async prefetchMappings(entity: string, sourceIds: (string | number)[]): Promise<Map<string, { targetId: string; hash: string | null }>> {
    const out = new Map<string, { targetId: string; hash: string | null }>()
    if (!sourceIds.length) return out
    const supabase = createAdminClient()
    const ids = sourceIds.map(String)
    // Chunked to stay under URL length limits on the PostgREST `in` filter.
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200)
      const { data } = await supabase
        .from('id_map')
        .select('source_id, target_id, content_hash')
        .eq('org_id', this.orgId)
        .eq('entity', entity)
        .eq('source_system', this.sourceSystem)
        .eq('target_system', this.targetSystem)
        .in('source_id', chunk)
      for (const row of (data ?? []) as { source_id: string; target_id: string; content_hash: string | null }[]) {
        out.set(row.source_id, { targetId: row.target_id, hash: row.content_hash })
      }
    }
    return out
  }

  // -------------------------------------------------------------------------
  // Logging — buffered, flushed once per slice to keep write volume sane.
  // -------------------------------------------------------------------------

  log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    this.logBuffer.push({
      run_id: this.runId,
      org_id: this.orgId,
      level,
      entity: this.entity,
      message,
      context: context ?? null,
    })
    if (this.logBuffer.length >= 200) void this.flushLogs()
  }

  info(message: string, context?: Record<string, unknown>) { this.log('info', message, context) }
  warn(message: string, context?: Record<string, unknown>) { this.log('warn', message, context) }
  error(message: string, context?: Record<string, unknown>) { this.log('error', message, context) }

  async flushLogs(): Promise<void> {
    if (!this.logBuffer.length) return
    const batch = this.logBuffer
    this.logBuffer = []
    await createAdminClient().from('run_logs').insert(batch)
  }

  async recordFailure(
    entity: string,
    sourceId: string | null,
    sourceName: string | null,
    error: unknown,
    payload?: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    await createAdminClient().from('run_failures').insert({
      run_id: this.runId,
      org_id: this.orgId,
      entity,
      source_id: sourceId,
      source_name: sourceName,
      error: message.slice(0, 4000),
      payload: (payload ?? null) as Record<string, unknown> | null,
    })
  }
}
