import { randomBytes } from 'node:crypto'

/**
 * Generates the values .env.example asks for. Run: npm run keygen
 */
console.log(`CREDENTIAL_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`)
console.log(`CRON_SECRET=${randomBytes(32).toString('hex')}`)
