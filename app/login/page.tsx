import Link from 'next/link'
import { AuthForm } from '@/components/auth-form'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>
}) {
  const { next, error } = await searchParams

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <Link href="/" className="text-sm font-semibold uppercase tracking-widest text-brand-600">
        AutoHalo
      </Link>
      <h1 className="mt-3 text-2xl font-bold">Sign in</h1>
      <p className="mt-1 text-sm text-ink-600 dark:text-ink-400">
        Use the email address your organisation was set up with.
      </p>

      {error ? (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : null}

      <div className="mt-6">
        <AuthForm mode="login" nextPath={next} />
      </div>

      <p className="mt-6 text-sm text-ink-600 dark:text-ink-400">
        No account yet?{' '}
        <Link href="/signup" className="font-medium text-brand-600 hover:underline">
          Create one
        </Link>
        .
      </p>
    </main>
  )
}
