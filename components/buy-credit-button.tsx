'use client'

import { useState } from 'react'
import { CreditCard, Loader2 } from 'lucide-react'

export function BuyCreditButton() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function buy() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/stripe/checkout', { method: 'POST' })
      const json = await res.json()
      if (!res.ok || !json.url) throw new Error(json.error ?? 'Could not start checkout')
      window.location.href = json.url
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start checkout')
      setBusy(false)
    }
  }

  return (
    <div>
      <button className="btn-primary" onClick={buy} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
        Buy a migration credit
      </button>
      {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
    </div>
  )
}
