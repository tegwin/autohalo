import { baseFilter } from '../../connectors/autotask'
import { HALO } from '../../connectors/haloResources'
import { runCopySlice, type EntityHandler } from '../handler'
import { autotaskLabel, haloIdForLabel, haloTicketTypes } from '../lookups'
import { autotaskPage, haloPage } from '../paging'

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

export interface AutotaskOpportunity {
  id: number
  title: string
  companyID: number
  contactID?: number
  ownerResourceID?: number
  amount?: number
  cost?: number
  probability?: number
  stage?: number
  status?: number
  projectedCloseDate?: string
  createDate?: string
  description?: string
  useQuote?: boolean
}

export interface HaloOpportunity {
  id: number
  summary?: string
  client_id?: number
  details?: string
}

export const opportunitiesHandler: EntityHandler = {
  key: 'opportunities',
  label: 'Opportunities',
  description: 'Sales opportunities with value, stage and expected close date.',
  seq: 90,
  directions: ['autotask_to_halo', 'halo_to_autotask'],
  dependsOn: ['companies', 'contacts', 'agents'],

  async estimate(ctx) {
    if (ctx.sourceSystem !== 'autotask') return null
    const page = await ctx.autotask.queryPage<AutotaskOpportunity>('Opportunities', {
      MaxRecords: 1,
      filter: baseFilter({ since: ctx.selection.since, until: ctx.selection.until }),
    })
    return page.pageDetails?.count ?? null
  },

  async run(ctx, cursor) {
    if (ctx.direction === 'autotask_to_halo') {
      return runCopySlice<AutotaskOpportunity>(ctx, cursor, {
        entity: 'opportunities',
        fetchPage: (c, cur) =>
          autotaskPage<AutotaskOpportunity>(
            c,
            'Opportunities',
            baseFilter({
              since: c.selection.since,
              until: c.selection.until,
              companyIds: c.selection.companyIds,
              companyField: 'companyID',
            }),
            cur,
            'opportunities',
          ),
        sourceId: (i) => String(i.id),
        sourceName: (i) => i.title,

        async transform(c, item) {
          const clientId = await c.mapForeignKey('companies', item.companyID)
          if (!clientId) return null

          const stageLabel = await autotaskLabel(c, 'Opportunities', 'stage', item.stage)
          const [userId, agentId, types] = await Promise.all([
            c.mapForeignKey('contacts', item.contactID),
            c.mapForeignKey('agents', item.ownerResourceID),
            haloTicketTypes(c),
          ])

          return {
            summary: item.title,
            details: item.description ?? '',
            client_id: Number(clientId),
            user_id: userId ? Number(userId) : undefined,
            agent_id: agentId ? Number(agentId) : undefined,
            tickettype_id: types.opportunity ?? undefined,
            opportunityvalue: item.amount ?? 0,
            opportunityprobability: item.probability ?? undefined,
            // Halo's own field for the sales stage label.
            opportunitystage: stageLabel ?? undefined,
            targetdate: item.projectedCloseDate ?? undefined,
            dateoccurred: item.createDate ?? undefined,
            thirdpartyref: String(item.id),
          }
        },

        async write(c, payload, existing) {
          const body = existing ? { ...payload, id: Number(existing) } : payload
          const res = await c.halo.post<HaloOpportunity>(HALO.opportunity, body)
          if (!res?.id) throw new Error('Halo did not return an id for the created opportunity')
          return String(res.id)
        },
      })
    }

    return runCopySlice<HaloOpportunity>(ctx, cursor, {
      entity: 'opportunities',
      fetchPage: (c, cur) => haloPage<HaloOpportunity>(c, HALO.opportunity, {}, cur),
      sourceId: (i) => String(i.id),
      sourceName: (i) => i.summary ?? `#${i.id}`,
      async transform(c, item) {
        const companyId = await c.mapForeignKey('companies', item.client_id)
        if (!companyId) return null
        return {
          title: (item.summary ?? `Halo opportunity ${item.id}`).slice(0, 128),
          companyID: Number(companyId),
          description: item.details ?? '',
          status: 1,
          stage: 1,
          projectedCloseDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          amount: 0,
          cost: 0,
          probability: 50,
          useQuote: false,
          advancedField1: 0,
          advancedField2: 0,
          advancedField3: 0,
          advancedField4: 0,
          barriers: '',
          helpNeeded: '',
          nextStep: '',
        }
      },
      async write(c, payload, existing) {
        if (existing) {
          await c.autotask.update('Opportunities', { ...payload, id: Number(existing) })
          return existing
        }
        const created = await c.autotask.create('Opportunities', payload)
        return String(created.itemId)
      },
    })
  },
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export interface AutotaskContract {
  id: number
  contractName: string
  companyID: number
  contractType?: number
  status?: number
  startDate?: string
  endDate?: string
  description?: string
  contractNumber?: string
  estimatedRevenue?: number
  setupFee?: number
  isDefaultContract?: boolean
}

export const contractsHandler: EntityHandler = {
  key: 'contracts',
  label: 'Contracts',
  description: 'Autotask Contracts to Halo client contracts, with dates and value.',
  seq: 50,
  directions: ['autotask_to_halo'],
  dependsOn: ['companies'],

  async run(ctx, cursor) {
    return runCopySlice<AutotaskContract>(ctx, cursor, {
      entity: 'contracts',
      fetchPage: (c, cur) =>
        autotaskPage<AutotaskContract>(
          c,
          'Contracts',
          baseFilter({
            companyIds: c.selection.companyIds,
            companyField: 'companyID',
            dateField: 'startDate',
            since: c.selection.since,
          }),
          cur,
          'contracts',
        ),
      sourceId: (i) => String(i.id),
      sourceName: (i) => i.contractName,

      async transform(c, item) {
        const clientId = await c.mapForeignKey('companies', item.companyID)
        if (!clientId) return null
        const typeLabel = await autotaskLabel(c, 'Contracts', 'contractType', item.contractType)

        return {
          ref: item.contractName,
          client_id: Number(clientId),
          startdate: item.startDate ?? undefined,
          enddate: item.endDate ?? undefined,
          details: [item.description, typeLabel && `Autotask contract type: ${typeLabel}`]
            .filter(Boolean)
            .join('\n\n'),
          // Autotask status is a picklist; anything not explicitly inactive
          // is treated as a live contract.
          inactive: false,
        }
      },

      async write(c, payload, existing) {
        const body = existing ? { ...payload, id: Number(existing) } : payload
        const res = await c.halo.post<{ id: number }>(HALO.contract, body)
        if (!res?.id) throw new Error('Halo did not return an id for the created contract')
        return String(res.id)
      },
    })
  },
}

// ---------------------------------------------------------------------------
// Products / catalogue items
// ---------------------------------------------------------------------------

export interface AutotaskProduct {
  id: number
  name: string
  description?: string
  sku?: string
  unitCost?: number
  unitPrice?: number
  msrp?: number
  isActive?: boolean
  productCategory?: number
  manufacturerName?: string
  manufacturerProductName?: string
  billingType?: number
}

export const productsHandler: EntityHandler = {
  key: 'products',
  label: 'Products',
  description: 'Autotask product catalogue to Halo items, with cost and sale price.',
  seq: 40,
  directions: ['autotask_to_halo'],

  async run(ctx, cursor) {
    return runCopySlice<AutotaskProduct>(ctx, cursor, {
      entity: 'products',
      fetchPage: (c, cur) =>
        autotaskPage<AutotaskProduct>(c, 'Products', [{ op: 'exist', field: 'id' }], cur, 'products'),
      sourceId: (i) => String(i.id),
      sourceName: (i) => i.name,

      async transform(c, item) {
        const categoryLabel = await autotaskLabel(
          c,
          'Products',
          'productCategory',
          item.productCategory,
        )
        const groupId = await haloIdForLabel(c, 'ItemGroup', categoryLabel, null)

        return {
          name: item.name,
          description: item.description ?? item.name,
          itemcode: item.sku ?? String(item.id),
          baseprice: item.unitPrice ?? item.msrp ?? 0,
          costprice: item.unitCost ?? 0,
          inactive: item.isActive === false,
          group_id: groupId ?? undefined,
          manufacturer: item.manufacturerName ?? undefined,
        }
      },

      async write(c, payload, existing) {
        const body = existing ? { ...payload, id: Number(existing) } : payload
        const res = await c.halo.post<{ id: number }>(HALO.item, body)
        if (!res?.id) throw new Error('Halo did not return an id for the created item')
        return String(res.id)
      },
    })
  },
}
