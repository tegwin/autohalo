import { HALO } from '../../connectors/haloResources'
import type { MigrationContext } from '../context'
import { runCopySlice, type EntityHandler } from '../handler'
import { autotaskPage, haloPage } from '../paging'

/**
 * Documentation: knowledge base articles and the Autotask Documents module.
 *
 * Autotask keeps these in two places — KnowledgeBaseArticles (the classic KB)
 * and Documents (the newer IT-documentation module). Halo has one home for
 * both, so they land as KB articles with a category that records where they
 * came from. Losing that distinction would make the migrated KB impossible to
 * audit against the source.
 */

export interface AutotaskKbArticle {
  id: number
  title?: string
  name?: string
  keywords?: string
  html?: string
  description?: string
  isActive?: boolean
  publish?: number
  createdDateTime?: string
  createDate?: string
  categoryId?: number
  articleCategoryID?: number
}

export interface AutotaskDocument {
  id: number
  title?: string
  name?: string
  html?: string
  description?: string
  documentCategoryID?: number
  companyID?: number
  isActive?: boolean
  createDateTime?: string
}

export interface HaloKbArticle {
  id: number
  name?: string
  note?: string
}

/** Autotask spells the title field differently across these two entities. */
function titleOf(item: { title?: string; name?: string; id: number }): string {
  return item.title ?? item.name ?? `Article ${item.id}`
}

function bodyOf(item: { html?: string; description?: string }): string {
  return item.html ?? item.description ?? ''
}

export const kbArticlesHandler: EntityHandler = {
  key: 'kb_articles',
  label: 'Knowledge base articles',
  description: 'Autotask KB articles to Halo KB, keeping the body HTML and keywords.',
  seq: 60,
  directions: ['autotask_to_halo', 'halo_to_autotask'],

  async run(ctx, cursor) {
    if (ctx.direction === 'autotask_to_halo') {
      return runCopySlice<AutotaskKbArticle>(ctx, cursor, {
        entity: 'kb_articles',
        fetchPage: (c, cur) =>
          autotaskPage<AutotaskKbArticle>(
            c,
            'KnowledgeBaseArticles',
            [{ op: 'exist', field: 'id' }],
            cur,
            'kb_articles',
          ),
        sourceId: (i) => String(i.id),
        sourceName: (i) => titleOf(i),

        async transform(_c, item) {
          const body = bodyOf(item)
          if (!titleOf(item) && !body) return null
          return {
            name: titleOf(item),
            note: body,
            // Autotask publish >= 3 means customer-facing.
            published: (item.publish ?? 1) >= 3,
            inactive: item.isActive === false,
            keywords: item.keywords ?? undefined,
            article_type: 1,
          }
        },

        async write(c, payload, existing) {
          const body = existing ? { ...payload, id: Number(existing) } : payload
          const res = await c.halo.post<HaloKbArticle>(HALO.kbArticle, body)
          if (!res?.id) throw new Error('Halo did not return an id for the created KB article')
          return String(res.id)
        },
      })
    }

    return runCopySlice<HaloKbArticle>(ctx, cursor, {
      entity: 'kb_articles',
      fetchPage: (c, cur) => haloPage<HaloKbArticle>(c, HALO.kbArticle, {}, cur),
      sourceId: (i) => String(i.id),
      sourceName: (i) => i.name ?? `#${i.id}`,
      async transform(_c, item) {
        if (!item.name) return null
        return {
          title: item.name,
          html: item.note ?? '',
          isActive: true,
          publish: 1,
        }
      },
      async write(c, payload, existing) {
        if (existing) {
          await c.autotask.update('KnowledgeBaseArticles', { ...payload, id: Number(existing) })
          return existing
        }
        const created = await c.autotask.create('KnowledgeBaseArticles', payload)
        return String(created.itemId)
      },
    })
  },
}

export const documentsHandler: EntityHandler = {
  key: 'documents',
  label: 'Documentation',
  description: 'The Autotask Documents module, migrated into Halo KB with its category preserved.',
  seq: 65,
  directions: ['autotask_to_halo'],
  dependsOn: ['companies'],

  async run(ctx, cursor) {
    return runCopySlice<AutotaskDocument>(ctx, cursor, {
      entity: 'documents',
      fetchPage: (c, cur) =>
        autotaskPage<AutotaskDocument>(c, 'Documents', [{ op: 'exist', field: 'id' }], cur),
      sourceId: (i) => String(i.id),
      sourceName: (i) => titleOf(i),

      async transform(c, item) {
        // The list payload omits the body on this entity; fetch it per record.
        const body = await documentBody(c, item)
        const clientId = await c.mapForeignKey('companies', item.companyID)

        return {
          name: titleOf(item),
          note: body,
          client_id: clientId ? Number(clientId) : undefined,
          published: false,
          inactive: item.isActive === false,
          article_type: 1,
        }
      },

      async write(c, payload, existing) {
        const body = existing ? { ...payload, id: Number(existing) } : payload
        const res = await c.halo.post<HaloKbArticle>(HALO.kbArticle, body)
        if (!res?.id) throw new Error('Halo did not return an id for the created document')
        return String(res.id)
      },
    })
  },
}

async function documentBody(ctx: MigrationContext, item: AutotaskDocument): Promise<string> {
  if (item.html || item.description) return bodyOf(item)
  try {
    const full = await ctx.autotask.getById<AutotaskDocument>('Documents', item.id)
    return full ? bodyOf(full) : ''
  } catch {
    return ''
  }
}
