import { NextResponse } from 'next/server'
import { canManage, getSessionContext } from '@/lib/auth'
import { siteUrl, stripeConfigured } from '@/lib/env'
import { stripe } from '@/lib/stripe'

export const runtime = 'nodejs'

/**
 * One-off Checkout session for a single migration credit.
 *
 * The org id rides on the session as metadata and as client_reference_id; the
 * webhook trusts that rather than anything the browser sends back, so a
 * customer cannot redirect a payment to a different org.
 */
export async function POST() {
  const ctx = await getSessionContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canManage(ctx)) {
    return NextResponse.json({ error: 'You need admin rights to purchase' }, { status: 403 })
  }
  if (!stripeConfigured()) {
    return NextResponse.json(
      { error: 'Billing is not configured on this deployment. Ask an administrator for a credit.' },
      { status: 503 },
    )
  }

  const base = siteUrl()

  try {
    const session = await stripe().checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: process.env.STRIPE_PRICE_ID!, quantity: 1 }],
      client_reference_id: ctx.org.id,
      customer_email: ctx.profile.email,
      metadata: {
        org_id: ctx.org.id,
        user_id: ctx.userId,
      },
      // Stripe returns the session id so the success page can poll until the
      // webhook has landed, instead of granting credit from the redirect.
      success_url: `${base}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/billing?checkout=cancelled`,
    })

    return NextResponse.json({ url: session.url })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not start checkout'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
