import { baseFilter } from '../../connectors/autotask'
import type { TaskCursor } from '../../types'
import type { MigrationContext } from '../context'
import { runCopySlice, type EntityHandler } from '../handler'
import { autotaskPage, haloPage } from '../paging'
import { buildProvenanceNote } from './companies'

// ---------------------------------------------------------------------------
// Sites — Autotask CompanyLocations become Halo Sites.
// Halo requires every end user and ticket to hang off a site, so this runs
// before contacts even though Autotask treats locations as optional detail.
// ---------------------------------------------------------------------------

export interface AutotaskLocation {
  id: number
  companyID: number
  name: string
  address1?: string
  address2?: string
  city?: string
  state?: string
  postalCode?: string
  phone?: string
  isActive?: boolean
  isPrimary?: boolean
}

export interface HaloSite {
  id: number
  name: string
  client_id: number
  inactive?: boolean
}

export const sitesHandler: EntityHandler = {
  key: 'sites',
  label: 'Sites / locations',
  description: 'Autotask company locations to Halo sites. Needed before contacts and tickets.',
  seq: 25,
  directions: ['autotask_to_halo', 'halo_to_autotask'],
  dependsOn: ['companies'],

  async run(ctx, cursor) {
    return ctx.direction === 'autotask_to_halo'
      ? runCopySlice<AutotaskLocation>(ctx, cursor, {
          entity: 'sites',
          fetchPage: (c, cur) =>
            autotaskPage<AutotaskLocation>(
              c,
              'CompanyLocations',
              baseFilter({ companyIds: c.selection.companyIds, companyField: 'companyID' }),
              cur,
            ),
          sourceId: (i) => String(i.id),
          sourceName: (i) => i.name,
          async transform(c, item) {
            const clientId = await c.mapForeignKey('companies', item.companyID)
            if (!clientId) {
              // The parent company was filtered out or failed. Skipping keeps
              // the run going rather than writing an orphan.
              return null
            }
            return {
              name: item.name || 'Main',
              client_id: Number(clientId),
              inactive: item.isActive === false,
              phonenumber: item.phone ?? undefined,
              delivery_address: {
                line1: item.address1 ?? undefined,
                line2: item.address2 ?? undefined,
                line3: item.city ?? undefined,
                line4: item.state ?? undefined,
                postcode: item.postalCode ?? undefined,
              },
            }
          },
          async write(c, payload, existing) {
            const body = existing ? { ...payload, id: Number(existing) } : payload
            const res = await c.halo.post<HaloSite>('Site', body)
            if (!res?.id) throw new Error('Halo did not return an id for the created site')
            return String(res.id)
          },
        })
      : runCopySlice<HaloSite>(ctx, cursor, {
          entity: 'sites',
          fetchPage: (c, cur) => haloPage<HaloSite>(c, 'Site', { includeinactive: true }, cur),
          sourceId: (i) => String(i.id),
          sourceName: (i) => i.name,
          async transform(c, item) {
            const companyId = await c.mapForeignKey('companies', item.client_id)
            if (!companyId) return null
            return {
              companyID: Number(companyId),
              name: item.name,
              isActive: item.inactive !== true,
            }
          },
          async write(c, payload, existing) {
            if (existing) {
              await c.autotask.update('CompanyLocations', { ...payload, id: Number(existing) })
              return existing
            }
            const created = await c.autotask.create('CompanyLocations', payload)
            return String(created.itemId)
          },
        })
  },
}

// ---------------------------------------------------------------------------
// Contacts — Autotask Contacts become Halo Users (end users).
// ---------------------------------------------------------------------------

export interface AutotaskContact {
  id: number
  companyID: number
  companyLocationID?: number
  firstName?: string
  lastName?: string
  emailAddress?: string
  emailAddress2?: string
  phone?: string
  mobilePhone?: string
  title?: string
  isActive?: number | boolean
  addressLine?: string
  city?: string
  state?: string
  zipCode?: string
  note?: string
  createDate?: string
}

export interface HaloUser {
  id: number
  name: string
  client_id?: number
  site_id?: number
  emailaddress?: string
  inactive?: boolean
  firstname?: string
  surname?: string
}

export const contactsHandler: EntityHandler = {
  key: 'contacts',
  label: 'Contacts',
  description: 'Autotask Contacts to Halo Users, linked to the migrated client and site.',
  seq: 30,
  directions: ['autotask_to_halo', 'halo_to_autotask'],
  dependsOn: ['companies', 'sites'],

  async estimate(ctx) {
    if (ctx.sourceSystem !== 'autotask') return null
    const page = await ctx.autotask.queryPage<AutotaskContact>('Contacts', {
      MaxRecords: 1,
      filter: contactFilter(ctx),
    })
    return page.pageDetails?.count ?? null
  },

  async run(ctx, cursor) {
    return ctx.direction === 'autotask_to_halo'
      ? contactsToHalo(ctx, cursor)
      : usersToAutotask(ctx, cursor)
  },
}

function contactFilter(ctx: MigrationContext) {
  return baseFilter({
    since: ctx.selection.since,
    until: ctx.selection.until,
    companyIds: ctx.selection.companyIds,
    companyField: 'companyID',
  })
}

function contactsToHalo(ctx: MigrationContext, cursor: TaskCursor) {
  return runCopySlice<AutotaskContact>(ctx, cursor, {
    entity: 'contacts',
    fetchPage: (c, cur) => autotaskPage<AutotaskContact>(c, 'Contacts', contactFilter(c), cur, 'contacts'),
    sourceId: (i) => String(i.id),
    sourceName: (i) => `${i.firstName ?? ''} ${i.lastName ?? ''}`.trim() || i.emailAddress || `#${i.id}`,

    async transform(c, item) {
      const clientId = await c.mapForeignKey('companies', item.companyID)
      if (!clientId) return null
      const siteId = await c.mapForeignKey('sites', item.companyLocationID)

      const name = `${item.firstName ?? ''} ${item.lastName ?? ''}`.trim() || item.emailAddress || `Contact ${item.id}`

      return {
        name,
        firstname: item.firstName ?? undefined,
        surname: item.lastName ?? undefined,
        client_id: Number(clientId),
        site_id: siteId ? Number(siteId) : undefined,
        emailaddress: item.emailAddress ?? undefined,
        phonenumber: item.phone ?? undefined,
        mobilenumber: item.mobilePhone ?? undefined,
        jobtitle: item.title ?? undefined,
        inactive: item.isActive === 0 || item.isActive === false,
        notes: [item.note, buildProvenanceNote('Autotask contact', item.id)]
          .filter(Boolean)
          .join('\n\n'),
      }
    },

    async write(c, payload, existing) {
      const body = existing ? { ...payload, id: Number(existing) } : payload
      const res = await c.halo.post<HaloUser>('Users', body)
      if (!res?.id) throw new Error('Halo did not return an id for the created user')
      return String(res.id)
    },
  })
}

function usersToAutotask(ctx: MigrationContext, cursor: TaskCursor) {
  return runCopySlice<HaloUser>(ctx, cursor, {
    entity: 'contacts',
    fetchPage: (c, cur) => haloPage<HaloUser>(c, 'Users', { includeinactive: true }, cur),
    sourceId: (i) => String(i.id),
    sourceName: (i) => i.name,

    async transform(c, item) {
      const companyId = await c.mapForeignKey('companies', item.client_id)
      if (!companyId) return null
      const [first, ...rest] = (item.name ?? '').split(' ')
      return {
        companyID: Number(companyId),
        firstName: item.firstname ?? first ?? 'Unknown',
        lastName: item.surname ?? rest.join(' ') ?? '',
        emailAddress: item.emailaddress ?? undefined,
        isActive: item.inactive ? 0 : 1,
      }
    },

    async write(c, payload, existing) {
      if (existing) {
        await c.autotask.update('Contacts', { ...payload, id: Number(existing) })
        return existing
      }
      // Autotask contacts are created under their parent company.
      const created = await c.autotask.createChild(
        'Companies',
        payload.companyID as number,
        'Contacts',
        payload,
      )
      return String(created.itemId)
    },
  })
}

// ---------------------------------------------------------------------------
// Users / technicians — Autotask Resources become Halo Agents.
//
// Deliberately does NOT create Halo agents by default in live mode without the
// operator opting in: every Halo agent consumes a licence seat, and silently
// provisioning dozens of them is an expensive surprise. The option lives in
// selection.options.agents.createAgents.
// ---------------------------------------------------------------------------

export interface AutotaskResource {
  id: number
  userName?: string
  firstName?: string
  lastName?: string
  email?: string
  isActive?: boolean
  title?: string
  mobilePhone?: string
  officePhone?: string
  resourceType?: string
}

export interface HaloAgent {
  id: number
  name: string
  email?: string
  inactive?: boolean
  is_agent?: boolean
}

export const agentsHandler: EntityHandler = {
  key: 'agents',
  label: 'Users / technicians',
  description:
    'Autotask Resources to Halo Agents. Each Halo agent consumes a licence, so creation is opt-in.',
  seq: 10,
  directions: ['autotask_to_halo', 'halo_to_autotask'],

  async run(ctx, cursor) {
    const opts = ctx.selection.options?.agents ?? {}
    const createAgents = opts.createAgents === true

    if (ctx.direction === 'autotask_to_halo') {
      return runCopySlice<AutotaskResource>(ctx, cursor, {
        entity: 'agents',
        fetchPage: (c, cur) =>
          autotaskPage<AutotaskResource>(c, 'Resources', [{ op: 'exist', field: 'id' }], cur),
        sourceId: (i) => String(i.id),
        sourceName: (i) => `${i.firstName ?? ''} ${i.lastName ?? ''}`.trim() || i.email || `#${i.id}`,

        async transform(c, item) {
          const name = `${item.firstName ?? ''} ${item.lastName ?? ''}`.trim()
          if (!name && !item.email) return null

          // Match an existing Halo agent by email first. Most migrations run
          // against a Halo tenant where the technicians already exist, and
          // linking to them is both cheaper and more correct than duplicating.
          const existingId = item.email ? await findHaloAgentByEmail(c, item.email) : null
          if (existingId) {
            await c.recordMapping('agents', String(item.id), String(existingId), { linked: true })
            return null
          }

          if (!createAgents) {
            c.warn(
              `No Halo agent matches ${item.email ?? name}; tickets they own will fall back to the default agent.`,
              { resourceId: item.id },
            )
            return null
          }

          return {
            name: name || item.email,
            email: item.email ?? undefined,
            initials: initialsFor(item.firstName, item.lastName),
            inactive: item.isActive === false,
            is_agent: true,
          }
        },

        async write(c, payload, existing) {
          const body = existing ? { ...payload, id: Number(existing) } : payload
          const res = await c.halo.post<HaloAgent>('Agent', body)
          if (!res?.id) throw new Error('Halo did not return an id for the created agent')
          return String(res.id)
        },
      })
    }

    return runCopySlice<HaloAgent>(ctx, cursor, {
      entity: 'agents',
      fetchPage: (c, cur) => haloPage<HaloAgent>(c, 'Agent', {}, cur),
      sourceId: (i) => String(i.id),
      sourceName: (i) => i.name,
      async transform(_c, item) {
        if (!createAgents) return null
        const [first, ...rest] = (item.name ?? '').split(' ')
        return {
          firstName: first ?? item.name,
          lastName: rest.join(' ') || first || item.name,
          email: item.email ?? undefined,
          isActive: item.inactive !== true,
        }
      },
      async write(c, payload, existing) {
        if (existing) {
          await c.autotask.update('Resources', { ...payload, id: Number(existing) })
          return existing
        }
        const created = await c.autotask.create('Resources', payload)
        return String(created.itemId)
      },
    })
  },
}

async function findHaloAgentByEmail(ctx: MigrationContext, email: string): Promise<number | null> {
  const agents = await ctx.halo.lookup<HaloAgent>('Agent', { includeinactive: true })
  const match = agents.find((a) => a.email?.toLowerCase() === email.toLowerCase())
  return match?.id ?? null
}

function initialsFor(first?: string, last?: string): string | undefined {
  const value = `${first?.[0] ?? ''}${last?.[0] ?? ''}`.toUpperCase()
  return value || undefined
}
