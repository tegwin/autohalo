import { createAdminClient } from '../../supabase/admin'
import { HALO } from '../../connectors/haloResources'
import type { TaskCursor } from '../../types'
import type { MigrationContext } from '../context'
import { emptySlice, type EntityHandler, type SliceResult } from '../handler'

/**
 * Attachments.
 *
 * These do not have a queryable top-level list in Autotask — you fetch them per
 * parent record. So rather than paging a source entity, this handler walks the
 * id_map of records we have already migrated and pulls each one's attachments
 * across. That also means it is inherently incremental: re-running only picks
 * up attachments it has not already mapped.
 *
 * Attachment bodies are base64 and can be tens of megabytes, so this runs with
 * a hard per-slice byte budget as well as the usual time deadline. Files above
 * MAX_ATTACHMENT_BYTES are skipped with an explicit failure row rather than
 * risking an out-of-memory kill that would take the whole slice with it.
 */

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const SLICE_BYTE_BUDGET = 60 * 1024 * 1024
const PARENT_BATCH = 25

interface AutotaskAttachment {
  id: number
  parentID?: number
  title?: string
  fullPath?: string
  contentType?: string
  attachmentType?: string
  data?: string
  fileSize?: number
  attachDate?: string
}

/** Which migrated entities carry attachments, and how to reach them. */
const ATTACHABLE: { entity: string; autotaskParent: string; haloField: string }[] = [
  { entity: 'tickets', autotaskParent: 'Tickets', haloField: 'ticket_id' },
  { entity: 'projects', autotaskParent: 'Projects', haloField: 'ticket_id' },
  { entity: 'project_tasks', autotaskParent: 'Tasks', haloField: 'ticket_id' },
  { entity: 'opportunities', autotaskParent: 'Opportunities', haloField: 'ticket_id' },
  { entity: 'companies', autotaskParent: 'Companies', haloField: 'client_id' },
]

export const attachmentsHandler: EntityHandler = {
  key: 'attachments',
  label: 'Attachments',
  description:
    'Files attached to migrated tickets, projects, tasks, opportunities and companies. Large files are reported rather than silently dropped.',
  seq: 110,
  directions: ['autotask_to_halo'],
  dependsOn: ['tickets', 'projects', 'opportunities', 'companies'],

  async run(ctx, cursor): Promise<SliceResult> {
    const result = emptySlice({ ...cursor })
    let bytesThisSlice = 0

    const groupIndex = Number(cursor.extra?.groupIndex ?? 0)
    let lastSourceId = String(cursor.extra?.lastSourceId ?? '')

    for (let g = groupIndex; g < ATTACHABLE.length; g++) {
      const group = ATTACHABLE[g]!

      for (;;) {
        if (ctx.expired() || bytesThisSlice >= SLICE_BYTE_BUDGET) {
          result.cursor = {
            ...result.cursor,
            extra: { ...result.cursor.extra, groupIndex: g, lastSourceId },
          }
          return result
        }

        const parents = await nextParents(ctx, group.entity, lastSourceId)
        if (!parents.length) break

        for (const parent of parents) {
          if (ctx.expired() || bytesThisSlice >= SLICE_BYTE_BUDGET) {
            result.cursor = {
              ...result.cursor,
              extra: { ...result.cursor.extra, groupIndex: g, lastSourceId },
            }
            return result
          }

          try {
            const copied = await copyAttachmentsFor(
              ctx,
              group.autotaskParent,
              group.haloField,
              parent.source_id,
              parent.target_id,
            )
            result.created += copied.created
            result.skipped += copied.skipped
            result.failed += copied.failed
            result.processed += copied.created + copied.skipped
            bytesThisSlice += copied.bytes
          } catch (err) {
            result.failed++
            await ctx.recordFailure('attachments', parent.source_id, group.entity, err)
          }
          lastSourceId = parent.source_id
        }
      }

      // Finished this group; reset the position for the next one.
      lastSourceId = ''
    }

    result.cursor = {
      ...result.cursor,
      drained: true,
      extra: { ...result.cursor.extra, groupIndex: ATTACHABLE.length, lastSourceId: '' },
    }
    result.done = true
    return result
  },
}

/**
 * Next batch of already-migrated parents. Ordered by source_id so the walk is
 * resumable from a single scalar.
 */
async function nextParents(
  ctx: MigrationContext,
  entity: string,
  after: string,
): Promise<{ source_id: string; target_id: string }[]> {
  const supabase = createAdminClient()
  let query = supabase
    .from('id_map')
    .select('source_id, target_id')
    .eq('org_id', ctx.orgId)
    .eq('entity', entity)
    .eq('source_system', ctx.sourceSystem)
    .eq('target_system', ctx.targetSystem)
    .order('source_id', { ascending: true })
    .limit(PARENT_BATCH)

  if (after) query = query.gt('source_id', after)

  const { data } = await query
  return (data ?? []) as { source_id: string; target_id: string }[]
}

async function copyAttachmentsFor(
  ctx: MigrationContext,
  autotaskParent: string,
  haloField: string,
  sourceParentId: string,
  targetParentId: string,
): Promise<{ created: number; skipped: number; failed: number; bytes: number }> {
  const stats = { created: 0, skipped: 0, failed: 0, bytes: 0 }

  const page = await ctx.autotask.queryChild<AutotaskAttachment>(
    autotaskParent,
    sourceParentId,
    'Attachments',
    { filter: [{ op: 'exist', field: 'id' }], MaxRecords: 100 },
  )
  const attachments = page.items ?? []
  if (!attachments.length) return stats

  const mapped = await ctx.prefetchMappings('attachments', attachments.map((a) => a.id))

  for (const attachment of attachments) {
    if (mapped.has(String(attachment.id))) {
      stats.skipped++
      continue
    }
    if (ctx.expired()) return stats

    try {
      if ((attachment.fileSize ?? 0) > MAX_ATTACHMENT_BYTES) {
        stats.skipped++
        await ctx.recordFailure(
          'attachments',
          String(attachment.id),
          attachment.title ?? null,
          new Error(
            `Attachment is ${Math.round((attachment.fileSize ?? 0) / 1024 / 1024)}MB, above the ${
              MAX_ATTACHMENT_BYTES / 1024 / 1024
            }MB limit. Move it manually.`,
          ),
        )
        continue
      }

      // The list response omits the body; fetch the single record for `data`.
      const full = await ctx.autotask.getById<AutotaskAttachment>('Attachments', attachment.id)
      const data = full?.data
      if (!data) {
        stats.skipped++
        continue
      }
      stats.bytes += data.length

      const payload: Record<string, unknown> = {
        [haloField]: Number(targetParentId),
        filename: attachment.title ?? full?.fullPath ?? `attachment-${attachment.id}`,
        data_base64: data,
        isimage: (attachment.contentType ?? '').startsWith('image/'),
      }

      const res = await ctx.halo.post<{ id: number }>(HALO.attachment, payload)
      if (res?.id) {
        // Do not store the base64 in the mapping hash — only the metadata.
        await ctx.recordMapping('attachments', String(attachment.id), String(res.id), {
          filename: payload.filename,
          parent: targetParentId,
        })
        stats.created++
      } else {
        stats.failed++
      }
    } catch (err) {
      stats.failed++
      await ctx.recordFailure('attachments', String(attachment.id), attachment.title ?? null, err)
    }
  }

  return stats
}

export function attachmentCursorStart(): TaskCursor {
  return { extra: { groupIndex: 0, lastSourceId: '' } }
}
