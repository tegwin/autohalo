import Stripe from 'stripe'

let cached: Stripe | null = null

export function stripe(): Stripe {
  if (cached) return cached
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) {
    throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID.')
  }
  cached = new Stripe(key, { apiVersion: '2025-02-24.acacia' })
  return cached
}
