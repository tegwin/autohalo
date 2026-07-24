import { NextResponse, type NextRequest } from 'next/server'
import { getSessionContext } from '@/lib/auth'
import { browseSource, isBrowsable } from '@/lib/source-browse'

export const runtime = 'nodejs'

/**
 * Live record search for the wizard's per-entity pickers, e.g.
 * /api/source/tickets?connectionId=…&search=…&page=1
 *
 * The connection is resolved through clientFor() inside browseSource, which
 * enforces that it belongs to the caller's org — a client cannot browse
 * another tenant's data by supplying a foreign connection id.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ entity: string }> },
) {
  const ctx = await getSessionContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { entity } = await params
  if (!isBrowsable(entity)) {
    return NextResponse.json({ error: `Cannot browse "${entity}"` }, { status: 400 })
  }

  const connectionId = request.nextUrl.searchParams.get('connectionId')
  const search = (request.nextUrl.searchParams.get('search') ?? '').trim()
  const page = Math.max(1, Number(request.nextUrl.searchParams.get('page') ?? 1))
  if (!connectionId) {
    return NextResponse.json({ error: 'Missing connectionId' }, { status: 400 })
  }

  try {
    const result = await browseSource(ctx.org.id, connectionId, entity, search, page)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not load records'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
