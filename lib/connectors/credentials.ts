import { createAdminClient } from '../supabase/admin'
import { decryptJson, encryptJson } from '../crypto'
import { AutotaskClient } from './autotask'
import { HaloClient } from './halo'
import type {
  AutotaskConfig,
  AutotaskSecrets,
  Connection,
  HaloConfig,
  HaloSecrets,
  SystemKind,
} from '../types'

/**
 * The only place that decrypts connection secrets. Everything that needs a
 * live API client goes through here, which keeps the blast radius of the
 * plaintext to one module.
 *
 * Callers must pass org_id even though the service-role client bypasses RLS —
 * that explicit filter is what stops a bug in a caller from reaching another
 * tenant's credentials.
 */

interface ConnectionRow extends Connection {
  secret_ciphertext: string | null
  secret_iv: string | null
  secret_tag: string | null
  key_version: number
}

export async function loadConnection(
  orgId: string,
  connectionId: string,
): Promise<ConnectionRow> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('connections')
    .select('*')
    .eq('id', connectionId)
    .eq('org_id', orgId)
    .single<ConnectionRow>()

  if (error || !data) {
    throw new Error(`Connection ${connectionId} not found for this organisation`)
  }
  return data
}

function decryptSecrets<T>(row: ConnectionRow): T {
  if (!row.secret_ciphertext || !row.secret_iv || !row.secret_tag) {
    throw new Error(`Connection "${row.label}" has no stored credentials. Re-enter them in Connections.`)
  }
  return decryptJson<T>({
    ciphertext: row.secret_ciphertext,
    iv: row.secret_iv,
    tag: row.secret_tag,
    keyVersion: row.key_version,
  })
}

export async function autotaskClientFor(orgId: string, connectionId: string): Promise<AutotaskClient> {
  const row = await loadConnection(orgId, connectionId)
  if (row.system !== 'autotask') {
    throw new Error(`Connection "${row.label}" is not an Autotask connection`)
  }
  return new AutotaskClient(row.config as AutotaskConfig, decryptSecrets<AutotaskSecrets>(row))
}

export async function haloClientFor(orgId: string, connectionId: string): Promise<HaloClient> {
  const row = await loadConnection(orgId, connectionId)
  if (row.system !== 'halo') {
    throw new Error(`Connection "${row.label}" is not a Halo connection`)
  }
  return new HaloClient(row.config as HaloConfig, decryptSecrets<HaloSecrets>(row))
}

export type AnyClient = AutotaskClient | HaloClient

export async function clientFor(
  orgId: string,
  connectionId: string,
): Promise<{ system: SystemKind; client: AnyClient }> {
  const row = await loadConnection(orgId, connectionId)
  if (row.system === 'autotask') {
    return {
      system: 'autotask',
      client: new AutotaskClient(row.config as AutotaskConfig, decryptSecrets<AutotaskSecrets>(row)),
    }
  }
  return {
    system: 'halo',
    client: new HaloClient(row.config as HaloConfig, decryptSecrets<HaloSecrets>(row)),
  }
}

/** Writes a connection's secrets, encrypting on the way in. */
export async function saveConnectionSecrets(
  orgId: string,
  connectionId: string,
  secrets: AutotaskSecrets | HaloSecrets,
): Promise<void> {
  const envelope = encryptJson(secrets)
  const supabase = createAdminClient()
  const { error } = await supabase
    .from('connections')
    .update({
      secret_ciphertext: envelope.ciphertext,
      secret_iv: envelope.iv,
      secret_tag: envelope.tag,
      key_version: envelope.keyVersion,
    })
    .eq('id', connectionId)
    .eq('org_id', orgId)

  if (error) throw new Error(`Could not store credentials: ${error.message}`)
}
