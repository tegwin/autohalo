import { baseFilter } from '../../connectors/autotask'
import type { TaskCursor } from '../../types'
import type { MigrationContext } from '../context'
import { runCopySlice, type EntityHandler } from '../handler'
import { autotaskLabel, haloIdForLabel, haloTicketTypes } from '../lookups'
import { autotaskPage, haloPage } from '../paging'

export interface AutotaskProject {
  id: number
  projectName: string
  projectNumber?: string
  companyID: number
  type?: number
  status?: number
  description?: string
  startDateTime?: string
  endDateTime?: string
  projectLeadResourceID?: number
  estimatedTime?: number
  createDateTime?: string
  completedDateTime?: string
  contractID?: number
}

export interface AutotaskPhase {
  id: number
  projectID: number
  title: string
  description?: string
  startDate?: string
  dueDate?: string
  parentPhaseID?: number
  phaseNumber?: string
}

export interface AutotaskTask {
  id: number
  projectID: number
  phaseID?: number
  title: string
  description?: string
  status?: number
  priority?: number
  assignedResourceID?: number
  startDateTime?: string
  endDateTime?: string
  estimatedHours?: number
  taskNumber?: string
  taskType?: number
  completedDateTime?: string
}

export interface HaloProject {
  id: number
  summary?: string
  details?: string
  client_id?: number
}

/**
 * Autotask Project -> Halo project.
 *
 * In Halo a project is a ticket with a project ticket type, its phases are
 * milestones, and its tasks are child tickets pointing at both the project and
 * the milestone. Reproducing that shape is what makes a migrated project look
 * native rather than like a flat pile of tickets: an Autotask project called
 * "Migration" with tasks under it becomes a Halo project called "Migration"
 * with those same tasks under it.
 */
export const projectsHandler: EntityHandler = {
  key: 'projects',
  label: 'Projects',
  description: 'Projects with their phases (as milestones) and tasks (as child tickets).',
  seq: 80,
  directions: ['autotask_to_halo', 'halo_to_autotask'],
  dependsOn: ['companies', 'contacts', 'agents'],

  async estimate(ctx) {
    if (ctx.sourceSystem !== 'autotask') return null
    const page = await ctx.autotask.queryPage<AutotaskProject>('Projects', {
      MaxRecords: 1,
      filter: await projectFilter(ctx, false),
    })
    return page.pageDetails?.count ?? null
  },

  async run(ctx, cursor) {
    return ctx.direction === 'autotask_to_halo'
      ? projectsToHalo(ctx, cursor, false)
      : projectsToAutotask(ctx, cursor)
  },
}

/**
 * Autotask project templates are Projects whose `type` picklist entry is the
 * template one. The numeric id of that entry differs between instances, so it
 * is resolved from field metadata at runtime rather than hardcoded.
 */
export const projectTemplatesHandler: EntityHandler = {
  key: 'project_templates',
  label: 'Project templates',
  description:
    'Autotask project templates become Halo templates, with their task list preserved as the template body.',
  seq: 70,
  directions: ['autotask_to_halo'],
  dependsOn: ['companies'],

  async run(ctx, cursor) {
    return projectsToHalo(ctx, cursor, true)
  },
}

async function templateTypeIds(ctx: MigrationContext): Promise<number[]> {
  const values = await ctx.autotask.picklist('Projects', 'type')
  return values
    .filter((v) => /template/i.test(v.label))
    .map((v) => Number(v.value))
    .filter((v) => Number.isFinite(v))
}

async function projectFilter(ctx: MigrationContext, templatesOnly: boolean) {
  const filter = baseFilter({
    since: templatesOnly ? undefined : ctx.selection.since,
    until: templatesOnly ? undefined : ctx.selection.until,
    companyIds: templatesOnly ? undefined : ctx.selection.companyIds,
    companyField: 'companyID',
    dateField: 'createDateTime',
  })

  const templateTypes = await templateTypeIds(ctx)
  if (templatesOnly) {
    if (!templateTypes.length) {
      // Nothing in this instance is typed as a template. An impossible filter
      // is cleaner than silently migrating every project as a template.
      filter.push({ op: 'eq', field: 'id', value: -1 })
    } else {
      filter.push({ op: 'in', field: 'type', value: templateTypes })
    }
  } else if (templateTypes.length) {
    filter.push({ op: 'notIn', field: 'type', value: templateTypes })
  }
  return filter
}

function projectsToHalo(ctx: MigrationContext, cursor: TaskCursor, templatesOnly: boolean) {
  const entity = templatesOnly ? 'project_templates' : 'projects'

  return runCopySlice<AutotaskProject>(ctx, cursor, {
    entity,
    async fetchPage(c, cur) {
      return autotaskPage<AutotaskProject>(c, 'Projects', await projectFilter(c, templatesOnly), cur)
    },
    sourceId: (i) => String(i.id),
    sourceName: (i) => i.projectName,

    async transform(c, item) {
      const clientId = await c.mapForeignKey('companies', item.companyID)
      if (!clientId && !templatesOnly) return null

      const statusLabel = await autotaskLabel(c, 'Projects', 'status', item.status)
      const types = await haloTicketTypes(c)

      if (templatesOnly) {
        // A Halo template stores the default values a new ticket starts with.
        // We fold the Autotask template's task list into the body so the
        // structure is not lost even where Halo has no direct equivalent.
        const tasks = await c.autotask.queryAll<AutotaskTask>(
          'Tasks',
          { filter: [{ op: 'eq', field: 'projectID', value: item.id }], MaxRecords: 500 },
          500,
        )
        const taskList = tasks
          .map((t, index) => `${index + 1}. ${t.title}${t.description ? ` — ${t.description}` : ''}`)
          .join('\n')

        return {
          name: item.projectName,
          summary: item.projectName,
          details: [item.description, taskList && `Tasks:\n${taskList}`]
            .filter(Boolean)
            .join('\n\n'),
          tickettype_id: types.project ?? types.incident ?? undefined,
          _taskCount: tasks.length,
        }
      }

      const [agentId, statusId] = await Promise.all([
        c.mapForeignKey('agents', item.projectLeadResourceID),
        haloIdForLabel(c, 'Status', statusLabel, null),
      ])

      return {
        summary: item.projectName,
        details: item.description ?? '',
        client_id: Number(clientId),
        tickettype_id: types.project ?? types.incident ?? undefined,
        agent_id: agentId ? Number(agentId) : undefined,
        status_id: statusId ?? undefined,
        startdate: item.startDateTime ?? undefined,
        targetdate: item.endDateTime ?? undefined,
        deadlinedate: item.endDateTime ?? undefined,
        estimatedtime: item.estimatedTime ?? undefined,
        dateoccurred: item.createDateTime ?? undefined,
        thirdpartyref: item.projectNumber ?? String(item.id),
      }
    },

    async write(c, payload, existing) {
      const { _taskCount, name, ...rest } = payload
      if (templatesOnly) {
        const body = existing
          ? { id: Number(existing), name, ...rest }
          : { name, ...rest }
        const res = await c.halo.post<{ id: number }>('Template', body)
        if (!res?.id) throw new Error('Halo did not return an id for the created template')
        return String(res.id)
      }
      const body = existing ? { ...rest, id: Number(existing) } : rest
      const res = await c.halo.post<HaloProject>('Tickets', body)
      if (!res?.id) throw new Error('Halo did not return an id for the created project')
      return String(res.id)
    },

    async after(c, item, targetId) {
      if (templatesOnly) return
      const milestoneMap = await copyPhases(c, item.id, Number(targetId))
      await copyTasks(c, item.id, Number(targetId), milestoneMap)
    },
  })
}

/** Autotask phases -> Halo milestones on the project ticket. */
async function copyPhases(
  ctx: MigrationContext,
  projectId: number,
  haloProjectId: number,
): Promise<Map<number, number>> {
  const result = new Map<number, number>()
  const phases = await ctx.autotask.queryAll<AutotaskPhase>(
    'Phases',
    { filter: [{ op: 'eq', field: 'projectID', value: projectId }], MaxRecords: 500 },
    500,
  )
  if (!phases.length) return result

  const mapped = await ctx.prefetchMappings('project_phases', phases.map((p) => p.id))

  for (const phase of phases) {
    if (ctx.expired()) break
    const existing = mapped.get(String(phase.id))
    if (existing) {
      result.set(phase.id, Number(existing.targetId))
      continue
    }
    try {
      const payload = {
        ticket_id: haloProjectId,
        name: phase.title,
        details: phase.description ?? undefined,
        startdate: phase.startDate ?? undefined,
        targetdate: phase.dueDate ?? undefined,
      }
      const res = await ctx.halo.post<{ id: number }>('Milestone', payload)
      if (res?.id) {
        await ctx.recordMapping('project_phases', String(phase.id), String(res.id), payload)
        result.set(phase.id, res.id)
      }
    } catch (err) {
      await ctx.recordFailure('project_phases', String(phase.id), phase.title, err)
    }
  }
  return result
}

/**
 * Autotask tasks -> Halo child tickets on the project, attached to the
 * milestone their phase became. Their notes and time come across too, so a
 * task's history is as complete as a ticket's.
 */
async function copyTasks(
  ctx: MigrationContext,
  projectId: number,
  haloProjectId: number,
  milestones: Map<number, number>,
): Promise<void> {
  const tasks = await ctx.autotask.queryAll<AutotaskTask>(
    'Tasks',
    { filter: [{ op: 'eq', field: 'projectID', value: projectId }], MaxRecords: 500 },
    2000,
  )
  if (!tasks.length) return

  const types = await haloTicketTypes(ctx)
  const mapped = await ctx.prefetchMappings('project_tasks', tasks.map((t) => t.id))

  for (const task of tasks) {
    if (ctx.expired()) return
    if (mapped.has(String(task.id))) continue

    try {
      const [agentId, statusLabel] = await Promise.all([
        ctx.mapForeignKey('agents', task.assignedResourceID),
        autotaskLabel(ctx, 'Tasks', 'status', task.status),
      ])
      const statusId = await haloIdForLabel(ctx, 'Status', statusLabel, null)

      const payload = {
        summary: task.title,
        details: task.description ?? '',
        parent_id: haloProjectId,
        tickettype_id: types.projectTask ?? types.incident ?? undefined,
        milestone_id: task.phaseID ? milestones.get(task.phaseID) : undefined,
        agent_id: agentId ? Number(agentId) : undefined,
        status_id: statusId ?? undefined,
        startdate: task.startDateTime ?? undefined,
        targetdate: task.endDateTime ?? undefined,
        estimatedtime: task.estimatedHours ?? undefined,
        thirdpartyref: task.taskNumber ?? String(task.id),
      }

      const res = await ctx.halo.post<{ id: number }>('Tickets', payload)
      if (!res?.id) continue

      await ctx.recordMapping('project_tasks', String(task.id), String(res.id), payload)
      await copyTaskHistory(ctx, task.id, res.id)
    } catch (err) {
      await ctx.recordFailure('project_tasks', String(task.id), task.title, err)
    }
  }
}

async function copyTaskHistory(ctx: MigrationContext, taskId: number, haloTicketId: number): Promise<void> {
  const [notes, entries] = await Promise.all([
    ctx.autotask.queryAll<{ id: number; title?: string; description?: string; createDateTime?: string; publish?: number }>(
      'TaskNotes',
      { filter: [{ op: 'eq', field: 'taskID', value: taskId }], MaxRecords: 500 },
      500,
    ),
    ctx.autotask.queryAll<{ id: number; hoursWorked?: number; summaryNotes?: string; dateWorked?: string; resourceID?: number }>(
      'TimeEntries',
      { filter: [{ op: 'eq', field: 'taskID', value: taskId }], MaxRecords: 500 },
      500,
    ),
  ])

  const mappedNotes = await ctx.prefetchMappings('task_notes', notes.map((n) => n.id))
  for (const note of notes) {
    if (mappedNotes.has(String(note.id)) || ctx.expired()) continue
    try {
      const payload = {
        ticket_id: haloTicketId,
        outcome: note.title || 'Note',
        note: note.description ?? '',
        hiddenfromuser: (note.publish ?? 1) < 3,
        actiondatecreated: note.createDateTime ?? undefined,
        timetaken: 0,
      }
      const res = await ctx.halo.post<{ id: number }>('Actions', payload)
      if (res?.id) await ctx.recordMapping('task_notes', String(note.id), String(res.id), payload)
    } catch (err) {
      await ctx.recordFailure('task_notes', String(note.id), note.title ?? null, err)
    }
  }

  const mappedTime = await ctx.prefetchMappings('time_entries', entries.map((e) => e.id))
  for (const entry of entries) {
    if (mappedTime.has(String(entry.id)) || ctx.expired()) continue
    try {
      const agentId = await ctx.mapForeignKey('agents', entry.resourceID)
      const payload = {
        ticket_id: haloTicketId,
        outcome: 'Time',
        note: entry.summaryNotes ?? '',
        timetaken: entry.hoursWorked ?? 0,
        who_agentid: agentId ? Number(agentId) : undefined,
        actiondatecreated: entry.dateWorked ?? undefined,
      }
      const res = await ctx.halo.post<{ id: number }>('Actions', payload)
      if (res?.id) await ctx.recordMapping('time_entries', String(entry.id), String(res.id), payload)
    } catch (err) {
      await ctx.recordFailure('time_entries', String(entry.id), null, err)
    }
  }
}

// ---------------------------------------------------------------------------
// Reverse direction
// ---------------------------------------------------------------------------

function projectsToAutotask(ctx: MigrationContext, cursor: TaskCursor) {
  return runCopySlice<HaloProject>(ctx, cursor, {
    entity: 'projects',
    fetchPage: (c, cur) => haloPage<HaloProject>(c, 'Projects', {}, cur),
    sourceId: (i) => String(i.id),
    sourceName: (i) => i.summary ?? `#${i.id}`,

    async transform(c, item) {
      const companyId = await c.mapForeignKey('companies', item.client_id)
      if (!companyId) return null
      return {
        projectName: (item.summary ?? `Halo project ${item.id}`).slice(0, 100),
        companyID: Number(companyId),
        description: item.details ?? '',
        // Autotask requires these on create; 1 = Proposal-ish default.
        type: 4,
        status: 1,
        startDateTime: new Date().toISOString(),
        endDateTime: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      }
    },

    async write(c, payload, existing) {
      if (existing) {
        await c.autotask.update('Projects', { ...payload, id: Number(existing) })
        return existing
      }
      const created = await c.autotask.create('Projects', payload)
      return String(created.itemId)
    },
  })
}
