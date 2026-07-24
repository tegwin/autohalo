import { NextResponse, type NextRequest } from 'next/server'
import type Stripe from 'stripe'
import { stripe } from '@/lib/stripe'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Stripe webhook — the only thing that grants paid entitlements.
 *
 * Three properties matter here:
 *  1. Signature verification against the raw body. Without it anyone could POST
 *     themselves free migrations.
 *  2. Idempotency. Stripe retries; stripe_events has a primary key on the event
 *     id, so a replay inserts nothing and returns 200.
 *  3. The org comes from the session metadata Stripe echoes back, never from
 *     the caller.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 })
  }

  const signature = request.headers.get('stripe-signature')
  if (!signature) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
  }

  const raw = await request.text()

  let event: Stripe.Event
  try {
    event = stripe().webhooks.constructEvent(raw, signature, secret)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid signature'
    return NextResponse.json({ error: `Signature verification failed: ${message}` }, { status: 400 })
  }

  const supabase = createAdminClient()

  // Claim the event id first. A duplicate delivery loses the race and exits.
  const { error: claimError } = await supabase
    .from('stripe_events')
    .insert({ id: event.id, type: event.type })

  if (claimError) {
    // 23505 = unique violation, i.e. we have already handled this event.
    if ((claimError as { code?: string }).code === '23505') {
      return NextResponse.json({ received: true, duplicate: true })
    }
    return NextResponse.json({ error: claimError.message }, { status: 500 })
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session

      if (session.payment_status !== 'paid') {
        return NextResponse.json({ received: true, ignored: 'not paid' })
      }

      const orgId = session.metadata?.org_id ?? session.client_reference_id
      if (!orgId) {
        console.error('[stripe] checkout.session.completed without an org id', session.id)
        return NextResponse.json({ received: true, ignored: 'no org' })
      }

      const { error } = await supabase.from('entitlements').insert({
        org_id: orgId,
        kind: 'single_run',
        stripe_checkout_session_id: session.id,
        stripe_payment_intent_id:
          typeof session.payment_intent === 'string' ? session.payment_intent : null,
        amount_total: session.amount_total,
        currency: session.currency,
        note: 'Purchased migration credit',
      })

      // A unique violation on the session id means the credit already exists.
      if (error && (error as { code?: string }).code !== '23505') {
        throw new Error(error.message)
      }
    }

    return NextResponse.json({ received: true })
  } catch (err) {
    // Roll the claim back so Stripe's retry can have another go.
    await supabase.from('stripe_events').delete().eq('id', event.id)
    const message = err instanceof Error ? err.message : 'Webhook handler failed'
    console.error('[stripe]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
