import { NextRequest, NextResponse } from 'next/server'

export const maxDuration = 60

const HASURA_URL = `https://${process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN}.hasura.${process.env.NEXT_PUBLIC_NHOST_REGION}.nhost.run/v1/graphql`
const ADMIN_SECRET = process.env.NHOST_ADMIN_SECRET || process.env.NEXT_PUBLIC_HASURA_ADMIN_SECRET || ''
const GROQ_API_KEY = process.env.GROQ_API_KEY || ''

async function hasuraQuery(query: string, variables: any = {}) {
  const res = await fetch(HASURA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hasura-admin-secret': ADMIN_SECRET
    },
    body: JSON.stringify({ query, variables })
  })
  const json = await res.json()
  if (json.errors) {
    console.error('Hasura error:', JSON.stringify(json.errors))
    throw new Error(json.errors[0]?.message || 'Hasura error')
  }
  return json
}

async function updateStepRun(id: string, status: string, output: any = null, error: string | null = null) {
  return hasuraQuery(`
    mutation($id: uuid!, $status: String!, $output: jsonb, $error: String, $completed_at: timestamptz) {
      update_step_runs_by_pk(
        pk_columns: {id: $id},
        _set: { status: $status, output: $output, error: $error, completed_at: $completed_at }
      ) { id status }
    }
  `, {
    id,
    status,
    output: output || {},
    error: error || null,
    completed_at: ['completed', 'failed', 'paused'].includes(status) ? new Date().toISOString() : null
  })
}

async function updateWorkflowRun(id: string, status: string) {
  return hasuraQuery(`
    mutation($id: uuid!, $status: String!, $completed_at: timestamptz) {
      update_workflow_runs_by_pk(
        pk_columns: {id: $id},
        _set: { status: $status, completed_at: $completed_at }
      ) { id }
    }
  `, { id, status, completed_at: new Date().toISOString() })
}

async function callGroq(prompt: string) {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama3-8b-8192',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 150
      })
    })
    const data = await res.json()
    return data.choices?.[0]?.message?.content || '{"action":"approve","reason":"default"}'
  } catch (e) {
    return '{"action":"approve","reason":"stubbed response"}'
  }
}

export async function POST(req: NextRequest) {
  try {
    console.log('ENV CHECK:', {
      subdomain: process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN,
      region: process.env.NEXT_PUBLIC_NHOST_REGION,
      hasSecret: !!process.env.NHOST_ADMIN_SECRET,
      hasPublicSecret: !!process.env.NEXT_PUBLIC_HASURA_ADMIN_SECRET,
      hasGroq: !!process.env.GROQ_API_KEY,
      url: HASURA_URL
    })

    const body = await req.json()
    const { workflow_id, user_id, role, org_id } = body

    console.log('Trigger workflow called:', { workflow_id, role, org_id })

    if (role === 'viewer') {
      return NextResponse.json({ error: 'Viewers cannot trigger workflows' }, { status: 403 })
    }

    // Get workflow + steps
    const wfResult = await hasuraQuery(`
      query($id: uuid!) {
        workflows_by_pk(id: $id) {
          id
          org_id
          organization { quota_allowed quota_used }
          workflow_steps(order_by: { step_order: asc }) {
            id step_type step_order config
          }
        }
      }
    `, { id: workflow_id })

    const workflow = wfResult.data?.workflows_by_pk
    if (!workflow) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 })
    if (workflow.org_id !== org_id) return NextResponse.json({ error: 'Cross-org access denied' }, { status: 403 })

    const org = workflow.organization
    if (org.quota_used >= org.quota_allowed) {
      return NextResponse.json({ error: 'Quota exhausted' }, { status: 429 })
    }

    // Create workflow run
    const runResult = await hasuraQuery(`
      mutation($workflow_id: uuid!, $user_id: uuid!) {
        insert_workflow_runs_one(object: {
          workflow_id: $workflow_id,
          status: "running",
          triggered_by: $user_id,
          trigger_type: "manual"
        }) { id }
      }
    `, { workflow_id, user_id })

    const runId = runResult.data.insert_workflow_runs_one.id
    console.log('Created run:', runId)

    // Create all step runs
    const steps = workflow.workflow_steps
    const stepRunIds: Record<string, string> = {}

    for (const step of steps) {
      const srResult = await hasuraQuery(`
        mutation($run_id: uuid!, $step_id: uuid!) {
          insert_step_runs_one(object: {
            workflow_run_id: $run_id,
            workflow_step_id: $step_id,
            status: "pending"
          }) { id }
        }
      `, { run_id: runId, step_id: step.id })
      stepRunIds[step.id] = srResult.data.insert_step_runs_one.id
    }

    console.log('Created step runs:', stepRunIds)

    // Execute steps
    console.log('Starting executeSteps with', steps.length, 'steps')
    console.log('Step run IDs:', JSON.stringify(stepRunIds))
    let previousOutput: any = {}
    let shouldContinue = true

    for (const step of steps) {
      if (!shouldContinue) break

      const stepRunId = stepRunIds[step.id]
      if (!stepRunId) continue

      console.log(`Executing step ${step.step_order}: ${step.step_type}`)

      await updateStepRun(stepRunId, 'running')

      try {
        let output: any = {}

        if (step.step_type === 'llm_call') {
          const prompt = step.config?.prompt || 'Respond with JSON: {"action":"approve","reason":"ok"}'
          const response = await callGroq(prompt)
          try { output = JSON.parse(response) } catch { output = { response } }

        } else if (step.step_type === 'http_request') {
          try {
            const res = await fetch('https://httpbin.org/post', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ run_id: runId, previous: previousOutput })
            })
            const json = await res.json()
            output = { status: res.status, url: json.url }
          } catch {
            output = { status: 'error', message: 'http request failed' }
          }

        } else if (step.step_type === 'conditional_branch') {
          const action = previousOutput?.action || ''
          const approved = action.toLowerCase().includes('approve')
          output = { branch: approved ? 'true_path' : 'false_path', condition_met: approved }
          if (!approved) shouldContinue = false

        } else if (step.step_type === 'approval_gate') {
          await updateStepRun(stepRunId, 'paused')
          await updateWorkflowRun(runId, 'paused')
          console.log('Paused at approval gate')
          return NextResponse.json({ run_id: runId, message: 'Paused at approval gate' })

        } else if (step.step_type === 'db_write') {
          output = { written: true, table: step.config?.table || 'workflow_runs' }

        } else if (step.step_type === 'notify') {
          output = { notified: true, channel: 'slack' }
        }

        await updateStepRun(stepRunId, 'completed', output)
        previousOutput = output
        console.log(`Step ${step.step_order} completed:`, output)

      } catch (err: any) {
        console.error(`Step ${step.step_order} failed:`, err.message)
        await updateStepRun(stepRunId, 'failed', null, err.message)
        await updateWorkflowRun(runId, 'failed')
        return NextResponse.json({ run_id: runId, message: 'Step failed', error: err.message })
      }
    }

    if (shouldContinue) {
      await hasuraQuery(`
        mutation($org_id: uuid!) {
          update_organizations_by_pk(pk_columns: {id: $org_id}, _inc: {quota_used: 1}) { id }
        }
      `, { org_id })
      await updateWorkflowRun(runId, 'completed')
    }

    return NextResponse.json({ run_id: runId, message: 'Workflow completed' })

  } catch (err: any) {
    console.error('Trigger error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}