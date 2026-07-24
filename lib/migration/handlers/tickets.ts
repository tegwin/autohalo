import { baseFilter } from '../../connectors/autotask'
import type { TaskCursor } from '../../types'
import type { MigrationContext } from '../context'
import { runCopySlice, type EntityHandler } from '../handler'
import { autotaskLabel, autotaskPicklistId, haloIdForLabel, haloTicketTypes } from '../lookups'
import { autotaskPage, haloPage } from '../paging'

export interface AutotaskTicket {
  id: number
  ticketNumber?: string
  title: string
  description?: string
  companyID: number
  companyLocationID?: number
  contactID?: number
  status?: number
  priority?: number
  queueID?: number
  assignedResourceID?: number
  ticketType?: number
  issueType?: number
  subIssueType?: number
  source?: number
  resolution?: string
  projectID?: number
  createDate?: string
  dueDateTime?: string
  completedDate?: string
  lastActivityDate?: string
  estimatedHours?: number
  createdByContactID?: number
}

export interface AutotaskTicketNote {
  id: number
  ticketID: number
  title?: string
  description?: string
  noteType?: number
  publish?: number
  createDateTime?: string
  creatorResourceID?: number
  createdByContactID?: number
}

export interface AutotaskTimeEntry {
  id: number
  ticketID?: number
  taskID?: number
  resourceID?: number
  dateWorked?: string
  startDateTime?: string
  endDateTime?: string
  hoursWorked?: number
  hoursToBill?: number
  summaryNotes?: string
  internalNotes?: string
  billingCodeID?: number
  roleID?: number
  isNonBillable?: boolean
}

export interface HaloTicket {
  id: number
  summary?: string
  details?: string
  client_id?: number
  user_id?: number
  agent_id?: number
  status_id?: number
  priority_id?: number
  tickettype_id?: number
  site_id?: number
  dateoccurred?: string
}

export interface HaloAction {
  id: number
  ticket_id: number
  outcome?: string
  note?: string
  timetaken?: number
}

/**
 * Autotask Ticket -> Halo Ticket, with its full history.
 *
 * The history is the point of this entity. A ticket without its notes and time
 * is a shell, so each ticket pulls its TicketNotes and TimeEntries and writes
 * them as Halo Actions — Halo's single container for both. Time entries become
 * actions with `timetaken`; notes become actions with none.
 *
 * Both children are id-mapped independently, so a re-run tops up missing
 * history rather than duplicating what is already there.
 */
export const ticketsHandler: EntityHandler = {
  key: 'tickets',
  label: 'Tickets',
  description: 'Tickets with their notes and time entries. Runs last so every reference resolves.',
  seq: 100,
  directions: ['autotask_to_halo', 'halo_to_autotask'],
  dependsOn: ['companies', 'contacts', 'sites', 'agents', 'projects'],

  async estimate(ctx) {
    if (ctx.sourceSystem !== 'autotask') return null
    const page = await ctx.autotask.queryPage<AutotaskTicket>('Tickets', {
      MaxRecords: 1,
      filter: ticketFilter(ctx),
    })
    return page.pageDetails?.count ?? null
  },

  async run(ctx, cursor) {
    return ctx.direction === 'autotask_to_halo'
      ? ticketsToHalo(ctx, cursor)
      : ticketsToAutotask(ctx, cursor)
  },
}

function ticketFilter(ctx: MigrationContext) {
  return baseFilter({
    since: ctx.selection.since,
    until: ctx.selection.until,
    companyIds: ctx.selection.companyIds,
    companyField: 'companyID',
  })
}

function ticketsToHalo(ctx: MigrationContext, cursor: TaskCursor) {
  const options = ctx.selection.options?.tickets ?? {}
  const includeTime = options.includeTimeEntries !== false
  const includeNotes = options.includeNotes !== false

  return runCopySlice<AutotaskTicket>(ctx, cursor, {
    entity: 'tickets',
    fetchPage: (c, cur) => autotaskPage<AutotaskTicket>(c, 'Tickets', ticketFilter(c), cur, 'tickets'),
    sourceId: (i) => String(i.id),
    sourceName: (i) => i.title,

    async transform(c, item) {
      const clientId = await c.mapForeignKey('companies', item.companyID)
      if (!clientId) return null

      const [statusLabel, priorityLabel, typeLabel] = await Promise.all([
        autotaskLabel(c, 'Tickets', 'status', item.status),
        autotaskLabel(c, 'Tickets', 'priority', item.priority),
        autotaskLabel(c, 'Tickets', 'ticketType', item.ticketType),
      ])

      const types = await haloTicketTypes(c)
      const [statusId, priorityId] = await Promise.all([
        haloIdForLabel(c, 'Status', statusLabel, null),
        haloIdForLabel(c, 'Priority', priorityLabel, null),
      ])

      const [userId, siteId, agentId, projectId] = await Promise.all([
        c.mapForeignKey('contacts', item.contactID),
        c.mapForeignKey('sites', item.companyLocationID),
        c.mapForeignKey('agents', item.assignedResourceID),
        c.mapForeignKey('projects', item.projectID),
      ])

      return {
        summary: item.title,
        details: item.description ?? '',
        client_id: Number(clientId),
        site_id: siteId ? Number(siteId) : undefined,
        user_id: userId ? Number(userId) : undefined,
        agent_id: agentId ? Number(agentId) : undefined,
        status_id: statusId ?? undefined,
        priority_id: priorityId ?? undefined,
        tickettype_id: types.incident ?? undefined,
        // Preserve when it actually happened rather than when we imported it.
        dateoccurred: item.createDate ?? undefined,
        deadlinedate: item.dueDateTime ?? undefined,
        estimatedtime: item.estimatedHours ?? undefined,
        // Halo links a project ticket by parent.
        parent_id: projectId ? Number(projectId) : undefined,
        // Autotask's ticket number is the customer-visible reference; keeping
        // it in a searchable field is what makes a migration auditable.
        thirdpartyref: item.ticketNumber ?? String(item.id),
        resolution: item.resolution ?? undefined,
        _typeLabel: typeLabel ?? undefined,
      }
    },

    async write(c, payload, existing) {
      const { _typeLabel, ...body } = payload
      const request = existing ? { ...body, id: Number(existing) } : body
      const res = await c.halo.post<HaloTicket>('Tickets', request)
      if (!res?.id) throw new Error('Halo did not return an id for the created ticket')
      return String(res.id)
    },

    async after(c, item, targetId) {
      if (includeNotes) await copyTicketNotes(c, item.id, Number(targetId))
      if (includeTime) await copyTicketTimeEntries(c, item.id, Number(targetId))
    },
  })
}

/**
 * Ticket notes -> Halo actions.
 *
 * `publish` on an Autotask note controls customer visibility; Halo's inverse
 * flag is `hiddenfromuser`, so internal-only notes stay internal-only.
 */
async function copyTicketNotes(ctx: MigrationContext, ticketId: number, haloTicketId: number): Promise<void> {
  const notes = await ctx.autotask.queryAll<AutotaskTicketNote>(
    'TicketNotes',
    { filter: [{ op: 'eq', field: 'ticketID', value: ticketId }], MaxRecords: 500 },
    2000,
  )
  if (!notes.length) return

  const mapped = await ctx.prefetchMappings('ticket_notes', notes.map((n) => n.id))

  for (const note of notes) {
    if (mapped.has(String(note.id))) continue
    if (ctx.expired()) return

    try {
      const who = await resolveResourceName(ctx, note.creatorResourceID)
      const payload = {
        ticket_id: haloTicketId,
        outcome: note.title || 'Note',
        note: stripHtml(note.description ?? ''),
        note_html: note.description ?? '',
        who: who ?? undefined,
        // Autotask publish: 1 = internal only, 2 = all Autotask users,
        // 3 = customer visible. Anything below 3 stays hidden from end users.
        hiddenfromuser: (note.publish ?? 1) < 3,
        actiondatecreated: note.createDateTime ?? undefined,
        timetaken: 0,
      }
      const res = await ctx.halo.post<HaloAction>('Actions', payload)
      if (res?.id) await ctx.recordMapping('ticket_notes', String(note.id), String(res.id), payload)
    } catch (err) {
      await ctx.recordFailure('ticket_notes', String(note.id), note.title ?? null, err)
    }
  }
}

/** Time entries -> Halo actions carrying `timetaken`, so billing survives. */
async function copyTicketTimeEntries(ctx: MigrationContext, ticketId: number, haloTicketId: number): Promise<void> {
  const entries = await ctx.autotask.queryAll<AutotaskTimeEntry>(
    'TimeEntries',
    { filter: [{ op: 'eq', field: 'ticketID', value: ticketId }], MaxRecords: 500 },
    2000,
  )
  if (!entries.length) return

  const mapped = await ctx.prefetchMappings('time_entries', entries.map((e) => e.id))

  for (const entry of entries) {
    if (mapped.has(String(entry.id))) continue
    if (ctx.expired()) return

    try {
      const who = await resolveResourceName(ctx, entry.resourceID)
      const agentId = await ctx.mapForeignKey('agents', entry.resourceID)
      const payload = {
        ticket_id: haloTicketId,
        outcome: 'Time',
        note: entry.summaryNotes ?? '',
        note_html: entry.summaryNotes ?? '',
        who: who ?? undefined,
        who_agentid: agentId ? Number(agentId) : undefined,
        timetaken: entry.hoursWorked ?? 0,
        actionchargehours: entry.hoursToBill ?? entry.hoursWorked ?? 0,
        nocharge: entry.isNonBillable === true,
        actiondatecreated: entry.dateWorked ?? entry.startDateTime ?? undefined,
        actionarrivaldate: entry.startDateTime ?? undefined,
        actioncompletiondate: entry.endDateTime ?? undefined,
        // Internal notes are not for the end user.
        hiddenfromuser: Boolean(entry.internalNotes) && !entry.summaryNotes,
      }
      const res = await ctx.halo.post<HaloAction>('Actions', payload)
      if (res?.id) await ctx.recordMapping('time_entries', String(entry.id), String(res.id), payload)

      // Internal notes are a separate field in Autotask with no Halo
      // equivalent on the same action, so they become their own private note.
      if (entry.internalNotes && entry.summaryNotes) {
        await ctx.halo.post<HaloAction>('Actions', {
          ticket_id: haloTicketId,
          outcome: 'Internal note',
          note: entry.internalNotes,
          who: who ?? undefined,
          hiddenfromuser: true,
          timetaken: 0,
          actiondatecreated: entry.dateWorked ?? undefined,
        })
      }
    } catch (err) {
      await ctx.recordFailure('time_entries', String(entry.id), entry.summaryNotes?.slice(0, 80) ?? null, err)
    }
  }
}

const resourceNames = new Map<number, string | null>()

async function resolveResourceName(ctx: MigrationContext, resourceId?: number): Promise<string | null> {
  if (!resourceId) return null
  if (resourceNames.has(resourceId)) return resourceNames.get(resourceId) ?? null
  try {
    const resource = await ctx.autotask.getById<{ firstName?: string; lastName?: string }>(
      'Resources',
      resourceId,
    )
    const name = resource
      ? `${resource.firstName ?? ''} ${resource.lastName ?? ''}`.trim() || null
      : null
    resourceNames.set(resourceId, name)
    return name
  } catch {
    resourceNames.set(resourceId, null)
    return null
  }
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// Reverse: Halo tickets -> Autotask, with actions replayed as notes and time.
// ---------------------------------------------------------------------------

function ticketsToAutotask(ctx: MigrationContext, cursor: TaskCursor) {
  return runCopySlice<HaloTicket>(ctx, cursor, {
    entity: 'tickets',
    fetchPage: (c, cur) => haloPage<HaloTicket>(c, 'Tickets', { open_only: false }, cur),
    sourceId: (i) => String(i.id),
    sourceName: (i) => i.summary ?? `#${i.id}`,

    async transform(c, item) {
      const companyId = await c.mapForeignKey('companies', item.client_id)
      if (!companyId) return null

      const full = await c.halo.getOne<HaloTicket & { status_name?: string; priority_name?: string }>(
        'Tickets',
        item.id,
      )

      const [statusId, priorityId] = await Promise.all([
        autotaskPicklistId(c, 'Tickets', 'status', full?.status_name ?? null, 1),
        autotaskPicklistId(c, 'Tickets', 'priority', full?.priority_name ?? null, 2),
      ])

      const contactId = await c.mapForeignKey('contacts', item.user_id)

      return {
        companyID: Number(companyId),
        title: (item.summary ?? `Halo ticket ${item.id}`).slice(0, 255),
        description: item.details ?? '',
        status: statusId ?? 1,
        priority: priorityId ?? 2,
        contactID: contactId ? Number(contactId) : undefined,
        dueDateTime: undefined,
      }
    },

    async write(c, payload, existing) {
      if (existing) {
        await c.autotask.update('Tickets', { ...payload, id: Number(existing) })
        return existing
      }
      const created = await c.autotask.create('Tickets', payload)
      return String(created.itemId)
    },

    async after(c, item, targetId) {
      await copyHaloActions(c, item.id, Number(targetId))
    },
  })
}

async function copyHaloActions(ctx: MigrationContext, haloTicketId: number, autotaskTicketId: number): Promise<void> {
  const actions = await ctx.halo.getAll<HaloAction & { note?: string; timetaken?: number; who?: string; actiondatecreated?: string }>(
    'Actions',
    { ticket_id: haloTicketId },
    1000,
  )
  if (!actions.length) return

  const mapped = await ctx.prefetchMappings('ticket_notes', actions.map((a) => a.id))

  for (const action of actions) {
    if (mapped.has(String(action.id))) continue
    if (ctx.expired()) return

    try {
      if (action.timetaken && action.timetaken > 0) {
        const created = await ctx.autotask.create('TimeEntries', {
          ticketID: autotaskTicketId,
          hoursWorked: action.timetaken,
          summaryNotes: action.note ?? '',
          dateWorked: action.actiondatecreated ?? new Date().toISOString(),
        })
        await ctx.recordMapping('time_entries', String(action.id), String(created.itemId), action)
      } else {
        const created = await ctx.autotask.createChild('Tickets', autotaskTicketId, 'Notes', {
          ticketID: autotaskTicketId,
          title: (action.outcome ?? 'Note').slice(0, 250),
          description: action.note ?? '',
          noteType: 1,
          publish: 1,
        })
        await ctx.recordMapping('ticket_notes', String(action.id), String(created.itemId), action)
      }
    } catch (err) {
      await ctx.recordFailure('ticket_notes', String(action.id), action.outcome ?? null, err)
    }
  }
}
