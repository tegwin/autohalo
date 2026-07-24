import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getSessionContext } from '@/lib/auth'
import { grantEntitlement } from '@/lib/entitlements'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('grant'),
    orgId: z.string().uuid(),
    quantity: z.number().int().min(1).max(100),
    note: z.string().max(200),
  }),
  z.object({
    action: z.literal('set_unlimited'),
    orgId: z.string().uuid(),
    unlimited: z.boolean(),
  }),
  z.object({
    action: z.literal('set_platform_admin'),
    userId: z.string().uuid(),
    isAdmin: z.boolean(),
  }),
])

/**
 * Platform admin actions.
 *
 * Every branch re-checks is_platform_admin from the database rather than
 * trusting anything on the request — this endpoint hands out free product and
 * can promote other admins, so it is the one place worth being paranoid.
 */
export async function POST(request: NextRequest) {
  const ctx = await getSessionContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!ctx.isPlatformAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
  const body = parsed.data
  const supabase = createAdminClient()

  try {
    if (body.action === 'grant') {
      await grantEntitlement(body.orgId, ctx.userId, body.note, body.quantity)
      return NextResponse.json({ ok: true })
    }

    if (body.action === 'set_unlimited') {
      const { error } = await supabase
        .from('orgs')
        .update({ unlimited: body.unlimited })
        .eq('id', body.orgId)
      if (error) throw new Error(error.message)
      return NextResponse.json({ ok: true })
    }

    // Guard against removing the last administrator, which would lock everyone
    // out of the admin portal with no way back in through the UI.
    if (!body.isAdmin) {
      const { count } = await supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('is_platform_admin', true)
      if ((count ?? 0) <= 1) {
        return NextResponse.json(
          { error: 'Cannot remove the last platform administrator' },
          { status: 400 },
        )
      }
    }

    const { error } = await supabase
      .from('profiles')
      .update({ is_platform_admin: body.isAdmin })
      .eq('id', body.userId)
    if (error) throw new Error(error.message)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Action failed' },
      { status: 400 },
    )
  }
}
