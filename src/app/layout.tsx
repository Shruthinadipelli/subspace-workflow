import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'SubSpace — Workflow Control Room',
  description: 'Role-aware AI workflow orchestration with live runs, approvals, and quota controls.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
