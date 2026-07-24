'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Gift, Infinity as InfinityIcon, Loader2, Ticket } from 'lucide-react'
import type { AdminOrgRow } from '@/app/(app)/admin/page'

/** Compact "3 days ago" style relative time for the last-login column. */
function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString('en-GB')
}

export function AdminOrgTable({ orgs }: { orgs: AdminOrgRow[] }) {
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function call(body: Record<string, unknown>, orgId: string) {
    setBusyId(orgId)
    setError(null)
    try {
      const res = await fetch('/api/admin/orgs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Action failed')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusyId(null)
    }
  }

  async function grant(orgId: string) {
    const raw = prompt('How many migration credits should this organisation receive?', '1')
    if (raw === null) return
    const quantity = Number(raw)
    if (!Number.isFinite(quantity) || quantity < 1) return
    const note = prompt('Reason (recorded against the grant)', 'Support grant') ?? 'Support grant'
    await call({ action: 'grant', orgId, quantity, note }, orgId)
  }

  async function unlockTrial(orgId: string) {
    const raw = prompt('How many extra free trial runs should this organisation get?', '1')
    if (raw === null) return
    const quantity = Number(raw)
    if (!Number.isFinite(quantity) || quantity < 1) return
    await call({ action: 'grant_trial', orgId, quantity }, orgId)
  }

  return (
    <>
      {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}
      <div className="table-shell">
        <table>
          <thead>
            <tr>
              <th>Organisation</th>
              <th>Accounts</th>
              <th>Runs</th>
              <th>Trials</th>
              <th>Credits</th>
              <th>Billing</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((org) => (
              <tr key={org.id}>
                <td>
                  <p className="font-medium">{org.name}</p>
                  <p className="hint">
                    {org.slug} · created {new Date(org.created_at).toLocaleDateString('en-GB')}
                  </p>
                </td>
                <td>
                  {org.members.length === 0 ? (
                    <span className="hint">—</span>
                  ) : (
                    <ul className="space-y-1.5">
                      {org.members.map((member) => (
                        <li key={member.email} className="text-xs leading-tight">
                          <span className="font-medium">{member.email}</span>
                          <span className="hint"> ({member.role})</span>
                          {member.isPlatformAdmin ? (
                            <span className="badge ml-1 bg-brand-100 text-brand-700 dark:bg-brand-700/20 dark:text-brand-300">
                              admin
                            </span>
                          ) : null}
                          <span className="hint block">
                            {member.lastSignInAt
                              ? `last login ${timeAgo(member.lastSignInAt)}`
                              : 'never logged in'}
                            {member.signedUpAt
                              ? ` · joined ${new Date(member.signedUpAt).toLocaleDateString('en-GB')}`
                              : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="tabular-nums" title="Total migration runs — count only, not their contents">
                  {org.runCount}
                </td>
                <td className="tabular-nums">{org.unlimited ? '∞' : org.trial_runs_remaining}</td>
                <td className="tabular-nums">{org.unlimited ? '∞' : org.creditsAvailable}</td>
                <td>
                  {org.unlimited ? (
                    <span className="badge bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                      unlimited
                    </span>
                  ) : (
                    <span className="badge bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-400">
                      pay per run
                    </span>
                  )}
                </td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="btn-secondary"
                      onClick={() => grant(org.id)}
                      disabled={busyId === org.id}
                    >
                      {busyId === org.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Gift className="h-4 w-4" />
                      )}
                      Grant
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() => unlockTrial(org.id)}
                      disabled={busyId === org.id}
                    >
                      <Ticket className="h-4 w-4" />
                      Unlock trial
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() =>
                        call({ action: 'set_unlimited', orgId: org.id, unlimited: !org.unlimited }, org.id)
                      }
                      disabled={busyId === org.id}
                    >
                      <InfinityIcon className="h-4 w-4" />
                      {org.unlimited ? 'Revoke unlimited' : 'Make unlimited'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
