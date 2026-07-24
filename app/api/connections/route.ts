import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { canManage, getSessionContext } from '@/lib/auth'
import { AutotaskClient } from '@/lib/connectors/autotask'
import { HaloClient } from '@/lib/connectors/halo'
import { encryptJson } from '@/lib/crypto'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

const autotaskSchema = z.object({
  system: z.literal('autotask'),
  label: z.string().min(1).max(80),
  endpoint: z.string().url().optional(),
  username: z.string().min(1),
  secret: z.string().min(1),
  integrationCode: z.string().min(1),
})

const haloSchema = z.object({
  system: z.literal('halo'),
  label: z.string().min(1).max(80),
  authUrl: z.string().url(),
  baseUrl: z.string().url(),
  tenant: z.string().optional(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
})

const bodySchema = z.discriminatedUnion('system', [autotaskSchema, haloSchema])

/**
 * Creates a connection and verifies it in the same request.
 *
 * Verification happens before the row is committed as usable: a connection
 * that has never authenticated is worse than no connection, because it fails
 * halfway through a migration instead of at setup.
 */
export async function POST(request: NextRequest) {
  const ctx = await getSessionContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canManage(ctx)) {
    return NextResponse.json({ error: 'You need admin rights on this organisation' }, { status: 403 })
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid connection details', issues: parsed.error.flatten() },
      { status: 400 },
    )
  }
  const body = parsed.data
  const supabase = createAdminClient()

  try {
    if (body.system === 'autotask') {
      // Resolve the zone from the username so the operator does not have to
      // know which webservicesN their account lives on.
      let zoneUrl = body.endpoint
      if (!zoneUrl) {
        zoneUrl = await AutotaskClient.discoverZone(body.username)
      }

      const secrets = {
        username: body.username,
        secret: body.secret,
        integrationCode: body.integrationCode,
      }
      const client = new AutotaskClient({ endpoint: zoneUrl, zoneUrl, username: body.username }, secrets)
      const verification = await client.verify()
      if (!verification.ok) {
        return NextResponse.json({ error: verification.error }, { status: 400 })
      }

      const envelope = encryptJson(secrets)
      const { data, error } = await supabase
        .from('connections')
        .insert({
          org_id: ctx.org.id,
          system: 'autotask',
          label: body.label,
          config: { endpoint: zoneUrl, zoneUrl, username: body.username },
          secret_ciphertext: envelope.ciphertext,
          secret_iv: envelope.iv,
          secret_tag: envelope.tag,
          key_version: envelope.keyVersion,
          last_verified_at: new Date().toISOString(),
          last_verify_error: null,
        })
        .select('id, label, system, config, last_verified_at')
        .single()

      if (error) throw new Error(error.message)
      return NextResponse.json({ connection: data, threshold: verification.threshold })
    }

    const secrets = { clientId: body.clientId, clientSecret: body.clientSecret }
    const config = {
      authUrl: body.authUrl,
      baseUrl: body.baseUrl,
      tenant: body.tenant,
      clientId: body.clientId,
    }
    const client = new HaloClient(config, secrets)
    const verification = await client.verify()
    if (!verification.ok) {
      return NextResponse.json({ error: verification.error }, { status: 400 })
    }

    const envelope = encryptJson(secrets)
    const { data, error } = await supabase
      .from('connections')
      .insert({
        org_id: ctx.org.id,
        system: 'halo',
        label: body.label,
        config,
        secret_ciphertext: envelope.ciphertext,
        secret_iv: envelope.iv,
        secret_tag: envelope.tag,
        key_version: envelope.keyVersion,
        last_verified_at: new Date().toISOString(),
        last_verify_error: null,
      })
      .select('id, label, system, config, last_verified_at')
      .single()

    if (error) throw new Error(error.message)
    return NextResponse.json({ connection: data, agentCount: verification.agentCount })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not save the connection'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function DELETE(request: NextRequest) {
  const ctx = await getSessionContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canManage(ctx)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const id = request.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  const supabase = createAdminClient()
  const { error } = await supabase
    .from('connections')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.org.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}
