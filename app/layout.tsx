import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'AutoHalo — Autotask to HaloPSA migration',
  description:
    'Copy customers, contacts, projects, tickets, time entries, documentation and more between Autotask and HaloPSA.',
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body className="min-h-screen">{children}</body>
    </html>
  )
}
