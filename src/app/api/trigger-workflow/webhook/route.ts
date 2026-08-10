import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  const payload = await request.json().catch(() => ({}))
  const workflowId = payload.workflow_id || request.nextUrl.searchParams.get('workflow_id')
  const userId = payload.user_id || request.headers.get('x-workflow-user-id')
  if (!workflowId || !userId) return NextResponse.json({ error: 'workflow_id and user identity are required' }, { status: 400 })
  const origin = request.nextUrl.origin
  const response = await fetch(`${origin}/api/trigger-workflow`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflow_id: workflowId, user_id: userId, org_id: payload.org_id, role: payload.role, trigger_type: 'webhook', input: payload.input || payload }) })
  const result = await response.json()
  return NextResponse.json(result, { status: response.status })
}
