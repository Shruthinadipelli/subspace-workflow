import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'SubSpace Workflow Builder',
  description: 'AI Agent Workflow Orchestration',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}