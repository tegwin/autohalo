import Link from 'next/link'
import { AuthForm } from '@/components/auth-form'

export default function SignupPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <Link href="/" className="text-sm font-semibold uppercase tracking-widest text-brand-600">
        AutoHalo
      </Link>
      <h1 className="mt-3 text-2xl font-bold">Create your account</h1>
      <p className="mt-1 text-sm text-ink-600 dark:text-ink-400">
        Your organisation and workspace are created automatically — nothing to configure first.
        Dry runs are free; you only pay when you run a live migration.
      </p>

      <div className="mt-6">
        <AuthForm mode="signup" />
      </div>

      <p className="mt-6 text-sm text-ink-600 dark:text-ink-400">
        Already registered?{' '}
        <Link href="/login" className="font-medium text-brand-600 hover:underline">
          Sign in
        </Link>
        .
      </p>
    </main>
  )
}
