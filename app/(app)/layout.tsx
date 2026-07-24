import Link from 'next/link'
import { Cable, CreditCard, LayoutDashboard, LogOut, Play, ShieldCheck } from 'lucide-react'
import { requireSession } from '@/lib/auth'
import { entitlementStatus } from '@/lib/entitlements'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireSession()
  const credits = await entitlementStatus(ctx.org.id, ctx.isPlatformAdmin)

  return (
    <div className="min-h-screen">
      <header className="border-b border-ink-200 bg-white dark:border-ink-800 dark:bg-ink-900">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3">
          <Link href="/dashboard" className="text-sm font-semibold uppercase tracking-widest text-brand-600">
            AutoHalo
          </Link>

          <nav className="flex flex-wrap items-center gap-1 text-sm">
            <NavLink href="/dashboard" icon={<LayoutDashboard className="h-4 w-4" />}>
              Dashboard
            </NavLink>
            <NavLink href="/connections" icon={<Cable className="h-4 w-4" />}>
              Connections
            </NavLink>
            <NavLink href="/migrations/new" icon={<Play className="h-4 w-4" />}>
              New migration
            </NavLink>
            <NavLink href="/billing" icon={<CreditCard className="h-4 w-4" />}>
              Billing
            </NavLink>
            {ctx.isPlatformAdmin ? (
              <NavLink href="/admin" icon={<ShieldCheck className="h-4 w-4" />}>
                Admin
              </NavLink>
            ) : null}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <div className="text-right">
              <p className="text-sm font-medium">{ctx.org.name}</p>
              <p className="hint">
                {ctx.isPlatformAdmin
                  ? 'Platform admin — billing bypassed'
                  : credits.unlimited
                    ? 'Unlimited migrations'
                    : `${credits.available} migration credit${credits.available === 1 ? '' : 's'}`}
              </p>
            </div>
            <form action="/auth/signout" method="post">
              <button type="submit" className="btn-secondary" title={`Sign out ${ctx.profile.email}`}>
                <LogOut className="h-4 w-4" />
                <span className="sr-only">Sign out</span>
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  )
}

function NavLink({
  href,
  icon,
  children,
}: {
  href: string
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-ink-600 transition hover:bg-ink-100 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-ink-800 dark:hover:text-white"
    >
      {icon}
      {children}
    </Link>
  )
}
