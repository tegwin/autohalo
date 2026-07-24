'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { CheckCircle2, Loader2, Plus, Trash2, XCircle } from 'lucide-react'
import type { AutotaskConfig, Connection, HaloConfig } from '@/lib/types'

export function ConnectionManager({
  initial,
  canManage,
}: {
  initial: Connection[]
  canManage: boolean
}) {
  const router = useRouter()
  const [adding, setAdding] = useState<'autotask' | 'halo' | null>(null)

  const autotask = initial.filter((c) => c.system === 'autotask')
  const halo = initial.filter((c) => c.system === 'halo')

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Autotask</h2>
          {canManage ? (
            <button className="btn-secondary" onClick={() => setAdding(adding === 'autotask' ? null : 'autotask')}>
              <Plus className="h-4 w-4" /> Add
            </button>
          ) : null}
        </div>

        {autotask.map((connection) => (
          <ConnectionCard key={connection.id} connection={connection} canManage={canManage} />
        ))}
        {autotask.length === 0 && adding !== 'autotask' ? (
          <p className="hint">No Autotask connection yet.</p>
        ) : null}

        {adding === 'autotask' ? (
          <AutotaskForm
            onDone={() => {
              setAdding(null)
              router.refresh()
            }}
            onCancel={() => setAdding(null)}
          />
        ) : null}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">HaloPSA</h2>
          {canManage ? (
            <button className="btn-secondary" onClick={() => setAdding(adding === 'halo' ? null : 'halo')}>
              <Plus className="h-4 w-4" /> Add
            </button>
          ) : null}
        </div>

        {halo.map((connection) => (
          <ConnectionCard key={connection.id} connection={connection} canManage={canManage} />
        ))}
        {halo.length === 0 && adding !== 'halo' ? <p className="hint">No Halo connection yet.</p> : null}

        {adding === 'halo' ? (
          <HaloForm
            onDone={() => {
              setAdding(null)
              router.refresh()
            }}
            onCancel={() => setAdding(null)}
          />
        ) : null}
      </section>
    </div>
  )
}

function ConnectionCard({ connection, canManage }: { connection: Connection; canManage: boolean }) {
  const router = useRouter()
  const [removing, setRemoving] = useState(false)

  const config = connection.config as Partial<AutotaskConfig & HaloConfig>
  const detail =
    connection.system === 'autotask'
      ? [config.username, config.zoneUrl ?? config.endpoint].filter(Boolean).join(' · ')
      : [config.tenant, config.baseUrl].filter(Boolean).join(' · ')

  async function remove() {
    if (!confirm(`Delete the connection "${connection.label}"? Existing run history is kept.`)) return
    setRemoving(true)
    await fetch(`/api/connections?id=${connection.id}`, { method: 'DELETE' })
    setRemoving(false)
    router.refresh()
  }

  return (
    <div className="card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{connection.label}</p>
          <p className="hint mt-0.5 truncate">{detail}</p>
        </div>
        {canManage ? (
          <button className="btn-danger shrink-0" onClick={remove} disabled={removing}>
            {removing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            <span className="sr-only">Delete</span>
          </button>
        ) : null}
      </div>

      <p className="mt-3 flex items-center gap-1.5 text-xs">
        {connection.last_verified_at ? (
          <>
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            <span className="text-ink-600 dark:text-ink-400">
              Verified {new Date(connection.last_verified_at).toLocaleString('en-GB')}
            </span>
          </>
        ) : (
          <>
            <XCircle className="h-4 w-4 text-red-600" />
            <span className="text-red-600">{connection.last_verify_error ?? 'Not verified'}</span>
          </>
        )}
      </p>
    </div>
  )
}

function useSubmit(onDone: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Could not save the connection')
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the connection')
    } finally {
      setBusy(false)
    }
  }

  return { busy, error, submit }
}

function AutotaskForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { busy, error, submit } = useSubmit(onDone)

  return (
    <form
      className="card space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        void submit({
          system: 'autotask',
          label: String(form.get('label')),
          username: String(form.get('username')).trim(),
          secret: String(form.get('secret')),
          integrationCode: String(form.get('integrationCode')).trim(),
          endpoint: String(form.get('endpoint')).trim() || undefined,
        })
      }}
    >
      <Field name="label" label="Name" defaultValue="Autotask (production)" required />
      <Field name="username" label="API user name" placeholder="xxx@company.com" required />
      <Field name="secret" label="Secret" type="password" required />
      <Field name="integrationCode" label="Integration code" required />
      <Field
        name="endpoint"
        label="Zone URL (optional)"
        placeholder="Left blank, we detect it from your username"
      />

      <Actions busy={busy} error={error} onCancel={onCancel} label="Verify and save" />
    </form>
  )
}

function HaloForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { busy, error, submit } = useSubmit(onDone)

  return (
    <form
      className="card space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        void submit({
          system: 'halo',
          label: String(form.get('label')),
          authUrl: String(form.get('authUrl')).trim(),
          baseUrl: String(form.get('baseUrl')).trim(),
          tenant: String(form.get('tenant')).trim() || undefined,
          clientId: String(form.get('clientId')).trim(),
          clientSecret: String(form.get('clientSecret')),
        })
      }}
    >
      <Field name="label" label="Name" defaultValue="HaloPSA (production)" required />
      <Field
        name="authUrl"
        label="Auth URL"
        placeholder="https://yourcompany.halopsa.com/auth"
        required
      />
      <Field
        name="baseUrl"
        label="API base URL"
        placeholder="https://yourcompany.halopsa.com/api"
        required
      />
      <Field name="tenant" label="Tenant (hosted instances only)" />
      <Field name="clientId" label="Client ID" required />
      <Field name="clientSecret" label="Client secret" type="password" required />

      <p className="hint">
        The Halo API application needs the <code>all</code> scope and agent-level permissions to
        create the records you are migrating.
      </p>

      <Actions busy={busy} error={error} onCancel={onCancel} label="Verify and save" />
    </form>
  )
}

function Field({
  name,
  label,
  type = 'text',
  placeholder,
  required,
  defaultValue,
}: {
  name: string
  label: string
  type?: string
  placeholder?: string
  required?: boolean
  defaultValue?: string
}) {
  return (
    <div>
      <label className="label" htmlFor={name}>
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        className="input"
        placeholder={placeholder}
        required={required}
        defaultValue={defaultValue}
        autoComplete="off"
      />
    </div>
  )
}

function Actions({
  busy,
  error,
  onCancel,
  label,
}: {
  busy: boolean
  error: string | null
  onCancel: () => void
  label: string
}) {
  return (
    <>
      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {label}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </>
  )
}
