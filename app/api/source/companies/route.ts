import { NextResponse, type NextRequest } from 'next/server'
import { getSessionContext } from '@/lib/auth'
import { AutotaskClient } from '@/lib/connectors/autotask'
import { HaloClient } from '@/lib/connectors/halo'
import { clientFor } from '@/lib/connectors/credentials'

export const runtime = 'nodejs'

export interface SourceCompany {
  id: string
  label: string
  sub?: string
}

/**
 * Live company search for the migration wizard's company picker.
 *
 * Queries the chosen SOURCE connection directly so the operator can scope a
 * live run to specific customers. Read-only, paged, and search-filtered so a
 * tenant with thousands of companies stays responsive. The connection is
 * resolved through clientFor(), which enforces that it belongs to the caller's
 * org — a client cannot browse another tenant's data by guessing an id.
 */
export async function GET(request: NextRequest) {
  const ctx = await getSessionContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const connectionId = request.nextUrl.searchParams.get('connectionId')
  const search = (request.nextUrl.searchParams.get('search') ?? '').trim()
  const page = Math.max(1, Number(request.nextUrl.searchParams.get('page') ?? 1))

  if (!connectionId) {
    return NextResponse.json({ error: 'Missing connectionId' }, { status: 400 })
  }

  try {
    const { system, client } = await clientFor(ctx.org.id, connectionId)
    const pageSize = 50

    if (system === 'autotask' && client instanceof AutotaskClient) {
      const filter = search
        ? [{ op: 'contains' as const, field: 'companyName', value: search }]
        : [{ op: 'exist' as const, field: 'id' }]
      const result = await client.queryPage<{
        id: number
        companyName: string
        companyNumber?: string
        city?: string
        isActive?: boolean
      }>('Companies', { MaxRecords: pageSize, filter })

      const items: SourceCompany[] = result.items.map((c) => ({
        id: String(c.id),
        label: c.companyName,
        sub: [c.companyNumber, c.city].filter(Boolean).join(' · ') || undefined,
      }))
      return NextResponse.json({
        items,
        hasMore: Boolean(result.pageDetails?.nextPageUrl),
      })
    }

    if (system === 'halo' && client instanceof HaloClient) {
      const result = await client.getPage<{ id: number; name: string; accountsid?: string }>(
        'Client',
        { search: search || undefined, page_size: pageSize, page_no: page, includeinactive: true },
      )
      const items: SourceCompany[] = result.items.map((c) => ({
        id: String(c.id),
        label: c.name,
        sub: c.accountsid || undefined,
      }))
      return NextResponse.json({ items, hasMore: items.length === pageSize })
    }

    return NextResponse.json({ error: 'Unsupported connection type' }, { status: 400 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not load companies'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
