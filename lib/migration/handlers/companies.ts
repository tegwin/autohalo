import { baseFilter } from '../../connectors/autotask'
import type { TaskCursor } from '../../types'
import type { MigrationContext } from '../context'
import { runCopySlice, type EntityHandler, type SliceResult } from '../handler'
import { autotaskLabel, autotaskPicklistId } from '../lookups'
import { autotaskPage, haloPage } from '../paging'

export interface AutotaskCompany {
  id: number
  companyName: string
  companyNumber?: string
  companyType?: number
  phone?: string
  fax?: string
  webAddress?: string
  address1?: string
  address2?: string
  city?: string
  state?: string
  postalCode?: string
  countryID?: number
  isActive?: boolean
  ownerResourceID?: number
  parentCompanyID?: number
  taxID?: string
  createDate?: string
  sicCode?: string
}

export interface HaloClientRecord {
  id: number
  name: string
  inactive?: boolean
  toplevel_id?: number
  main_site_id?: number
  accountsid?: string
  notes?: string
  website?: string
}

/**
 * Autotask Company -> Halo Client.
 *
 * Halo splits what Autotask keeps in one place: the postal address and phone
 * live on a Site, not the Client. We create the client and let Halo's default
 * "Main" site absorb the address via the nested site payload, which is the
 * behaviour Halo's own importers use.
 */
export const companiesHandler: EntityHandler = {
  key: 'companies',
  label: 'Customers',
  description: 'Autotask Companies to Halo Clients (and back). Everything else depends on these.',
  seq: 20,
  directions: ['autotask_to_halo', 'halo_to_autotask'],

  async estimate(ctx) {
    if (ctx.sourceSystem === 'autotask') {
      const page = await ctx.autotask.queryPage<AutotaskCompany>('Companies', {
        MaxRecords: 1,
        filter: buildFilter(ctx),
      })
      return page.pageDetails?.count ?? null
    }
    const page = await ctx.halo.getPage<HaloClientRecord>('Client', { page_size: 1, page_no: 1 })
    return page.recordCount
  },

  async run(ctx, cursor): Promise<SliceResult> {
    return ctx.direction === 'autotask_to_halo'
      ? autotaskToHalo(ctx, cursor)
      : haloToAutotask(ctx, cursor)
  },
}

function buildFilter(ctx: MigrationContext) {
  return baseFilter({
    since: ctx.selection.since,
    until: ctx.selection.until,
    companyIds: ctx.selection.companyIds,
    companyField: 'id',
  })
}

function autotaskToHalo(ctx: MigrationContext, cursor: TaskCursor) {
  return runCopySlice<AutotaskCompany>(ctx, cursor, {
    entity: 'companies',
    fetchPage: (c, cur) => autotaskPage<AutotaskCompany>(c, 'Companies', buildFilter(c), cur, 'companies'),
    sourceId: (item) => String(item.id),
    sourceName: (item) => item.companyName,

    async transform(c, item) {
      const typeLabel = await autotaskLabel(c, 'Companies', 'companyType', item.companyType)
      const parentId = await c.mapForeignKey('companies', item.parentCompanyID)

      // Minimal, well-supported Client fields only. The address and phone are
      // migrated separately as Halo Sites (from Autotask CompanyLocations), so
      // there is no nested site payload here — Halo creates the Main site.
      const payload: Record<string, unknown> = {
        name: item.companyName,
        inactive: item.isActive === false,
        notes: buildProvenanceNote('Autotask company', item.id, typeLabel),
      }
      if (item.webAddress) payload.website = item.webAddress
      if (item.companyNumber) payload.accountsid = item.companyNumber
      // Only set a parent when we actually migrated one; a bad/0 id 400s Halo.
      if (parentId) payload.toplevel_id = Number(parentId)
      return payload
    },

    async write(c, payload, existingTargetId) {
      const body = existingTargetId ? { ...payload, id: Number(existingTargetId) } : payload
      const created = await c.halo.post<HaloClientRecord>('Client', body)
      if (!created?.id) throw new Error('Halo did not return an id for the created client')
      return String(created.id)
    },
  })
}

function haloToAutotask(ctx: MigrationContext, cursor: TaskCursor) {
  return runCopySlice<HaloClientRecord>(ctx, cursor, {
    entity: 'companies',
    fetchPage: (c, cur) => haloPage<HaloClientRecord>(c, 'Client', { includeinactive: true }, cur),
    sourceId: (item) => String(item.id),
    sourceName: (item) => item.name,

    async transform(c, item) {
      // Autotask requires a company type and an owner; both are picklists and
      // both are mandatory on create, so fall back to sane defaults.
      const typeId = await autotaskPicklistId(c, 'Companies', 'companyType', 'Customer', 1)
      const parentId = await c.mapForeignKey('companies', item.toplevel_id)

      return {
        companyName: item.name,
        companyType: typeId ?? 1,
        isActive: item.inactive !== true,
        webAddress: item.website ?? undefined,
        companyNumber: item.accountsid ?? undefined,
        parentCompanyID: parentId ? Number(parentId) : undefined,
        ownerResourceID: await defaultOwnerResourceId(c),
      }
    },

    async write(c, payload, existingTargetId) {
      if (existingTargetId) {
        await c.autotask.update('Companies', { ...payload, id: Number(existingTargetId) })
        return existingTargetId
      }
      const created = await c.autotask.create('Companies', payload)
      return String(created.itemId)
    },
  })
}

let cachedOwner: number | null | undefined

/**
 * Autotask rejects a company without an owner resource. Pick any active
 * internal resource once and reuse it; the customer can reassign in bulk after
 * the migration far more easily than we can guess per record.
 */
async function defaultOwnerResourceId(ctx: MigrationContext): Promise<number | undefined> {
  if (cachedOwner !== undefined) return cachedOwner ?? undefined
  try {
    const page = await ctx.autotask.queryPage<{ id: number }>('Resources', {
      MaxRecords: 1,
      filter: [{ op: 'eq', field: 'isActive', value: true }],
    })
    cachedOwner = page.items[0]?.id ?? null
  } catch {
    cachedOwner = null
  }
  return cachedOwner ?? undefined
}

/** A short provenance line so records are traceable back to their origin. */
export function buildProvenanceNote(
  kind: string,
  id: number | string,
  extra?: string | null,
): string {
  const parts = [`Migrated by AutoHalo from ${kind} #${id}`]
  if (extra) parts.push(`Type: ${extra}`)
  return parts.join('. ')
}
