import { NextResponse } from 'next/server'

const subdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN
const region = process.env.NEXT_PUBLIC_NHOST_REGION
const adminSecret = process.env.NHOST_ADMIN_SECRET || process.env.NEXT_PUBLIC_HASURA_ADMIN_SECRET

const hasuraUrl = subdomain && region
  ? `https://${subdomain}.hasura.${region}.nhost.run/v1/graphql`
  : null

export async function POST(request: Request) {
  if (!hasuraUrl || !adminSecret) {
    return NextResponse.json({ error: 'Nhost server configuration is missing.' }, { status: 503 })
  }

  try {
    const body = await request.json()
    const response = await fetch(hasuraUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hasura-admin-secret': adminSecret,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    })

    const payload = await response.json()
    return NextResponse.json(payload, { status: response.status })
  } catch {
    return NextResponse.json({ error: 'Unable to reach the Nhost data plane.' }, { status: 502 })
  }
}
