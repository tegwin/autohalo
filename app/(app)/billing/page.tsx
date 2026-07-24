import { canManage, requireSession } from '@/lib/auth'
import { entitlementStatus } from '@/lib/entitlements'
import { stripeConfigured } from '@/lib/env'
import { BuyCreditButton } from '@/components/buy-credit-button'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Entitlement } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>
}) {
  const { checkout } = await searchParams
  const ctx = await requireSession()
  const credits = await entitlementStatus(ctx.org.id, ctx.isPlatformAdmin)

  const supabase = createAdminClient()
  const { data: history } = await supabase
    .from('entitlements')
    .select('*')
    .eq('org_id', ctx.org.id)
    .order('created_at', { ascending: false })
    .limit(50)

  const entitlements = (history ?? []) as Entitlement[]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Billing</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-600 dark:text-ink-400">
          One purchase covers one live migration run. Dry runs are always free, and a credit is
          only spent when a live run starts.
        </p>
      </div>

      {checkout === 'success' ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-800/50 dark:bg-emerald-900/20 dark:text-emerald-300">
          Payment received. Your credit appears here as soon as Stripe confirms it — usually within
          a few seconds. Refresh if it has not shown up.
        </p>
      ) : null}
      {checkout === 'cancelled' ? (
        <p className="rounded-lg border border-ink-200 bg-ink-100 px-3 py-2 text-sm dark:border-ink-700 dark:bg-ink-800">
          Checkout cancelled. Nothing was charged.
        </p>
      ) : null}

      <div className="card">
        <p className="hint">Available credits</p>
        <p className="mt-1 text-3xl font-bold">
          {credits.unlimited ? 'Unlimited' : credits.available}
        </p>
        <p className="mt-2 text-sm text-ink-600 dark:text-ink-400">
          {credits.reason === 'admin'
            ? 'You are a platform administrator — billing is bypassed on your account.'
            : credits.reason === 'unlimited'
              ? 'This organisation has been granted unlimited migrations.'
              : credits.reason === 'purchased'
                ? 'Ready to run a live migration.'
                : 'Buy a credit to run a live migration.'}
        </p>

        {!credits.unlimited && canManage(ctx) ? (
          <div className="mt-4">
            {stripeConfigured() ? (
              <BuyCreditButton />
            ) : (
              <p className="hint">
                Card payment is not configured on this deployment. Ask an administrator to grant a
                credit.
              </p>
            )}
          </div>
        ) : null}
      </div>

      <section>
        <h2 className="mb-3 text-lg font-semibold">History</h2>
        {entitlements.length === 0 ? (
          <div className="card text-sm text-ink-600 dark:text-ink-400">Nothing purchased yet.</div>
        ) : (
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Source</th>
                  <th>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {entitlements.map((item) => (
                  <tr key={item.id}>
                    <td className="whitespace-nowrap">
                      {new Date(item.created_at).toLocaleString('en-GB')}
                    </td>
                    <td>{item.kind === 'admin_grant' ? `Granted${item.note ? ` — ${item.note}` : ''}` : 'Purchased'}</td>
                    <td>
                      {item.amount_total
                        ? new Intl.NumberFormat('en-GB', {
                            style: 'currency',
                            currency: (item.currency ?? 'gbp').toUpperCase(),
                          }).format(item.amount_total / 100)
                        : '—'}
                    </td>
                    <td>
                      {item.consumed_by_run_id ? (
                        <span className="badge bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-400">
                          used
                        </span>
                      ) : (
                        <span className="badge bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                          available
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
