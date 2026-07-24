'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

/**
 * Sign in / sign up.
 *
 * Sign-up carries `company` in the user metadata, which the auth trigger uses
 * to name the auto-provisioned org. That is the whole provisioning flow — no
 * post-signup wizard, no manual tenant creation.
 */
export function AuthForm({ mode, nextPath }: { mode: 'login' | 'signup'; nextPath?: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setNotice(null)
    setBusy(true)

    const form = new FormData(event.currentTarget)
    const email = String(form.get('email') ?? '').trim()
    const password = String(form.get('password') ?? '')
    const company = String(form.get('company') ?? '').trim()
    const fullName = String(form.get('full_name') ?? '').trim()

    const supabase = createClient()

    try {
      if (mode === 'signup') {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { company, full_name: fullName },
            emailRedirectTo: `${window.location.origin}/auth/callback`,
          },
        })
        if (signUpError) throw signUpError

        // With email confirmation on, there is no session yet.
        if (!data.session) {
          setNotice('Check your inbox to confirm your email address, then sign in.')
          setBusy(false)
          return
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
        if (signInError) throw signInError
      }

      startTransition(() => {
        router.push(nextPath && nextPath.startsWith('/') ? nextPath : '/dashboard')
        router.refresh()
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.')
      setBusy(false)
    }
  }

  const working = busy || pending

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {mode === 'signup' ? (
        <>
          <div>
            <label className="label" htmlFor="full_name">
              Your name
            </label>
            <input id="full_name" name="full_name" className="input" autoComplete="name" required />
          </div>
          <div>
            <label className="label" htmlFor="company">
              Company
            </label>
            <input
              id="company"
              name="company"
              className="input"
              autoComplete="organization"
              placeholder="Used to name your workspace"
              required
            />
          </div>
        </>
      ) : null}

      <div>
        <label className="label" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          className="input"
          autoComplete="email"
          required
        />
      </div>

      <div>
        <label className="label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          className="input"
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          minLength={10}
          required
        />
        {mode === 'signup' ? <p className="hint mt-1">At least 10 characters.</p> : null}
      </div>

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-700 dark:border-brand-700/50 dark:bg-brand-700/10 dark:text-brand-200">
          {notice}
        </p>
      ) : null}

      <button type="submit" className="btn-primary w-full" disabled={working}>
        {working ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {mode === 'signup' ? 'Create account' : 'Sign in'}
      </button>
    </form>
  )
}
