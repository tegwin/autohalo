import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { serverEnv } from './env'

/**
 * Tenant PSA credentials are the crown jewels of this app: they grant full
 * read/write access to a customer's Autotask and Halo instances. They are
 * encrypted with AES-256-GCM before they touch the database, using a key held
 * only in the server environment. A database leak alone therefore yields
 * nothing usable.
 *
 * key_version on the row lets us rotate the key later without a big-bang
 * re-encryption: decrypt with the version the row records, re-encrypt with the
 * current one on next write.
 */

const ALGORITHM = 'aes-256-gcm'
const CURRENT_KEY_VERSION = 1

export interface Envelope {
  ciphertext: string
  iv: string
  tag: string
  keyVersion: number
}

function keyFor(version: number): Buffer {
  if (version !== CURRENT_KEY_VERSION) {
    // Older keys would be looked up here, e.g. CREDENTIAL_ENCRYPTION_KEY_V1.
    const legacy = process.env[`CREDENTIAL_ENCRYPTION_KEY_V${version}`]
    if (!legacy) {
      throw new Error(`No encryption key configured for key version ${version}`)
    }
    return decodeKey(legacy)
  }
  return decodeKey(serverEnv().CREDENTIAL_ENCRYPTION_KEY)
}

function decodeKey(raw: string): Buffer {
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY must be 32 bytes encoded as base64. Run `npm run keygen`.',
    )
  }
  return key
}

export function encryptJson(value: unknown): Envelope {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, keyFor(CURRENT_KEY_VERSION), iv)
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    keyVersion: CURRENT_KEY_VERSION,
  }
}

export function decryptJson<T>(envelope: Envelope): T {
  const decipher = createDecipheriv(
    ALGORITHM,
    keyFor(envelope.keyVersion),
    Buffer.from(envelope.iv, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ])
  return JSON.parse(plaintext.toString('utf8')) as T
}

/** Constant-time comparison for shared secrets such as the cron token. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** Stable hash of an outbound payload, used to skip unchanged records. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 32)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
  return `{${entries.join(',')}}`
}
