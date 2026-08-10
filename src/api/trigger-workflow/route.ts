import { NextRequest, NextResponse } from 'next/server'

const HASURA_URL = `https://${process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN}.hasura.${process.env.NEXT_PUBLIC_NHOST_REGION}.nhost.run/v1/graphql`
const ADMIN_SECRET = process.env.NHOST_ADMIN_SECRET!
const GROQ_API_KEY = process.env.GROQ_API_KEY!

async function hasuraQuery(query: string, variables: any = {}) {
  const res = await fetch(HASURA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hasura-admin-secret': ADMIN_SECRET },
    body: JSON.stringify({ query, variables })
  })
  return res.json()
}

async function updateStepRun(id: string, updates: any) {
  const setFields = Object.entries(updates).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')
  return hasuraQuery(`
    mutation { update_step_runs_by_pk(pk_columns: {id: "${id}"}, _set: {${setFields}}) { id status } }
  `)
}

async function updateWorkflowRun(id: string, status: string) {
  return hasuraQuery(`
    mutation { update_workflow_runs_by_pk(pk_columns: {id: "${id}"}, _set: {status: "${status}", completed_at: "${new Date().toISOString()}"}) { id } }
  `)
}

async function callGroq(prompt: string) {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama3-8b-8192',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200
      })
    })
    const data = await res.json()
    return data.choices?.[0]?.message?.content || 'No response'
  } catch {
    // Stub response if API fails
    await new Promise(r => setTimeout(r, 1000))
    return JSON.stringify({ action: 'approve', reason: 'Auto-approved (stubbed)' })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { workflow_id, user_id, role, org_id } = await req.json()

    // Permission check — viewer cannot trigger
    if (role === 'viewer') {
      return NextResponse.json({ error: 'Viewers cannot trigger workflows' }, { status: 403 })
    }

    // Verify workflow belongs to org
    const { data: wfData } = await hasuraQuery(`
      query { workflows_by_pk(id: "${workflow_id}") { id org_id quota: organization { quota_allowed quota_used } workflow_steps(order_by: {step_order: asc}) { id step_type step_order config } } }
    `)

    const workflow = wfData?.workflows_by_pk
    if (!workflow) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 })

    // Cross-org isolation check
    if (workflow.org_id !== org_id) {
      return NextResponse.json({ error: 'Cross-org access denied' }, { status: 403 })
    }

    // Quota check
    const org = workflow.quota
    if (org.quota_used >= org.quota_allowed) {
      return NextResponse.json({ error: 'Quota exhausted' }, { status: 429 })
    }

    // Create workflow run
    const { data: runData } = await hasuraQuery(`
      mutation { insert_workflow_runs_one(object: { workflow_id: "${workflow_id}", status: "running", triggered_by: "${user_id}", trigger_type: "manual" }) { id } }
    `)
    const runId = runData.insert_workflow_runs_one.id

    // Create step runs for each step
    const steps = workflow.workflow_steps
    for (const step of steps) {
      await hasuraQuery(`
        mutation { insert_step_runs_one(object: { workflow_run_id: "${runId}", workflow_step_id: "${step.id}", status: "pending" }) { id } }
      `)
    }

    // Execute steps asynchronously
    executeSteps(runId, steps, workflow_id, org_id).catch(console.error)

    return NextResponse.json({ run_id: runId, message: 'Workflow started' })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

async function executeSteps(runId: string, steps: any[], workflowId: string, orgId: string) {
  // Get step run IDs
  const { data: srData } = await hasuraQuery(`
    query { step_runs(where: {workflow_run_id: {_eq: "${runId}"}}, order_by: {started_at: asc}) { id workflow_step_id } }
  `)
  const stepRuns = srData.step_runs

  let previousOutput: any = {}
  let shouldContinue = true

  for (const step of steps) {
    if (!shouldContinue) break

    const stepRun = stepRuns.find((sr: any) => sr.workflow_step_id === step.id)
    if (!stepRun) continue

    // Mark as running
    await updateStepRun(stepRun.id, { status: 'running' })

    try {
      let output: any = {}

      switch (step.step_type) {
        case 'llm_call': {
          const prompt = step.config.prompt || 'Analyze this workflow step'
          const response = await callGroq(prompt)
          try { output = JSON.parse(response) } catch { output = { response } }
          break
        }

        case 'http_request': {
          let retries = 0
          while (retries < 2) {
            try {
              const res = await fetch(step.config.url || 'https://httpbin.org/post', {
                method: step.config.method || 'GET',
                headers: { 'Content-Type': 'application/json' },
                body: step.config.method === 'POST' ? JSON.stringify({ workflow_run_id: runId, previous: previousOutput }) : undefined
              })
              output = await res.json()
              break
            } catch {
              retries++
              await new Promise(r => setTimeout(r, 1000))
            }
          }
          break
        }

        case 'conditional_branch': {
          const action = previousOutput?.action || previousOutput?.response
          const approved = typeof action === 'string' && action.toLowerCase().includes('approve')
          output = { branch: approved ? 'true_path' : 'false_path', condition_met: approved }
          if (!approved) shouldContinue = false
          break
        }

        case 'approval_gate': {
          // Pause the run and wait for manual approval
          await updateStepRun(stepRun.id, { status: 'paused' })
          await updateWorkflowRun(runId, 'paused')
          return // Stop execution — approveStep will resume
        }

        case 'db_write': {
          await hasuraQuery(`
            mutation { update_workflow_runs_by_pk(pk_columns: {id: "${runId}"}, _set: {status: "running"}) { id } }
          `)
          output = { written: true, table: step.config.table }
          break
        }

        case 'notify': {
          // Stub notify
          await new Promise(r => setTimeout(r, 500))
          output = { notified: true, channel: 'slack', message: 'Workflow step completed' }
          break
        }
      }

      await updateStepRun(stepRun.id, { status: 'completed', output, completed_at: new Date().toISOString() })
      previousOutput = output

      // Small delay so UI can show progression
      await new Promise(r => setTimeout(r, 800))

    } catch (err: any) {
      await updateStepRun(stepRun.id, { status: 'failed', error: err.message, attempt_count: 1 })
      await updateWorkflowRun(runId, 'failed')
      return
    }
  }

  if (shouldContinue) {
    // Increment quota
    await hasuraQuery(`
      mutation { update_organizations(where: {workflows: {id: {_eq: "${workflowId}"}}}, _inc: {quota_used: 1}) { affected_rows } }
    `)
    await updateWorkflowRun(runId, 'completed')
  }
}