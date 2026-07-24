import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowRight, Database, RefreshCw, ShieldCheck } from 'lucide-react'
import { getSessionContext } from '@/lib/auth'

export default async function HomePage() {
  const ctx = await getSessionContext()
  if (ctx) redirect('/dashboard')

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col justify-center px-6 py-16">
      <p className="text-sm font-semibold uppercase tracking-widest text-brand-600">AutoHalo</p>
      <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">
        Move your whole PSA, not just the easy bits.
      </h1>
      <p className="mt-4 max-w-2xl text-lg text-ink-600 dark:text-ink-300">
        Copy customers, contacts, sites, projects and their tasks, project templates,
        opportunities, contracts, knowledge base articles, documentation and tickets — with
        every time entry and note — between Autotask and HaloPSA. In either direction.
      </p>

      <div className="mt-10 grid gap-4 sm:grid-cols-3">
        <Feature
          icon={<Database className="h-5 w-5" />}
          title="Structure preserved"
          body="A project with tasks arrives as a project with tasks. Phases become milestones, notes and time entries stay attached."
        />
        <Feature
          icon={<RefreshCw className="h-5 w-5" />}
          title="Resumable and repeatable"
          body="Runs checkpoint continuously. Re-running updates what changed instead of creating duplicates."
        />
        <Feature
          icon={<ShieldCheck className="h-5 w-5" />}
          title="Credentials encrypted"
          body="API keys are sealed with AES-256-GCM before they reach the database and never reach your browser."
        />
      </div>

      <div className="mt-10 flex flex-wrap gap-3">
        <Link href="/signup" className="btn-primary">
          Create an account <ArrowRight className="h-4 w-4" />
        </Link>
        <Link href="/login" className="btn-secondary">
          Sign in
        </Link>
      </div>
    </main>
  )
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="card">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-700/20 dark:text-brand-400">
        {icon}
      </div>
      <h2 className="mt-3 font-semibold">{title}</h2>
      <p className="mt-1.5 text-sm text-ink-600 dark:text-ink-400">{body}</p>
    </div>
  )
}
