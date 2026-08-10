import { NextRequest, NextResponse } from 'next/server'

const HASURA_URL = `https://${process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN}.hasura.${process.env.NEXT_PUBLIC_NHOST_REGION}.nhost.run/v1/graphql`
const ADMIN_SECRET = process.env.NHOST_ADMIN_SECRET!

async function hasuraQuery(query: string, variables: any = {}) {
  const res = await fetch(HASURA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hasura-admin-secret': ADMIN_SECRET },
    body: JSON.stringify({ query, variables })
  })
  return res.json()
}

export async function POST(req: NextRequest) {
  try {
    const { step_run_id, user_id, role } = await req.json()

    // Only owner or editor can approve — checked in Action handler not just DB
    if (role === 'viewer') {
      return NextResponse.json({ error: 'Viewers cannot approve steps' }, { status: 403 })
    }

    // Get step run details
    const { data } = await hasuraQuery(`
      query {
        step_runs_by_pk(id: "${step_run_id}") {
          id
          status
          workflow_run_id
          workflow_step { step_type step_order config }
        }
      }
    `)

    const stepRun = data?.step_runs_by_pk
    if (!stepRun) return NextResponse.json({ error: 'Step run not found' }, { status: 404 })
    if (stepRun.status !== 'paused') return NextResponse.json({ error: 'Step is not paused' }, { status: 400 })

    // Approve the step
    await hasuraQuery(`
      mutation {
        update_step_runs_by_pk(
          pk_columns: {id: "${step_run_id}"},
          _set: {
            status: "completed",
            approved_by: "${user_id}",
            approved_at: "${new Date().toISOString()}",
            output: ${JSON.stringify(JSON.stringify({ approved: true, approved_by: user_id, role }))},
            completed_at: "${new Date().toISOString()}"
          }
        ) { id }
      }
    `)

    // Resume workflow run — mark as running
    await hasuraQuery(`
      mutation {
        update_workflow_runs_by_pk(
          pk_columns: {id: "${stepRun.workflow_run_id}"},
          _set: { status: "running" }
        ) { id }
      }
    `)

    // Continue with remaining steps after approval_gate
    continueAfterApproval(stepRun.workflow_run_id, stepRun.workflow_step.step_order).catch(console.error)

    return NextResponse.json({ success: true, message: 'Step approved, workflow resuming' })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

async function continueAfterApproval(runId: string, approvedStepOrder: number) {
  // Get remaining steps
  const { data } = await hasuraQuery(`
    query {
      workflow_runs_by_pk(id: "${runId}") {
        workflow {
          id
          org_id
          workflow_steps(where: {step_order: {_gt: ${approvedStepOrder}}}, order_by: {step_order: asc}) {
            id step_type step_order config
          }
        }
        step_runs { id workflow_step_id status output }
      }
    }
  `)

  const run = data?.workflow_runs_by_pk
  if (!run) return

  const remainingSteps = run.workflow.workflow_steps
  const existingStepRuns = run.step_runs

  for (const step of remainingSteps) {
    let stepRun = existingStepRuns.find((sr: any) => sr.workflow_step_id === step.id)

    // Create step run if doesn't exist
    if (!stepRun) {
      const { data: srData } = await hasuraQuery(`
        mutation { insert_step_runs_one(object: { workflow_run_id: "${runId}", workflow_step_id: "${step.id}", status: "pending" }) { id } }
      `)
      stepRun = srData.insert_step_runs_one
    }

    await hasuraQuery(`
      mutation { update_step_runs_by_pk(pk_columns: {id: "${stepRun.id}"}, _set: {status: "running"}) { id } }
    `)

    await new Promise(r => setTimeout(r, 800))

    let output: any = { completed: true, step: step.step_type }

    if (step.step_type === 'db_write') {
      output = { written: true, table: step.config?.table || 'workflow_runs' }
    } else if (step.step_type === 'notify') {
      output = { notified: true, channel: 'slack' }
    }

    await hasuraQuery(`
      mutation {
        update_step_runs_by_pk(
          pk_columns: {id: "${stepRun.id}"},
          _set: { status: "completed", output: ${JSON.stringify(JSON.stringify(output))}, completed_at: "${new Date().toISOString()}" }
        ) { id }
      }
    `)
  }

  // Increment quota and complete run
  await hasuraQuery(`
    mutation { update_organizations(where: {workflows: {workflow_runs: {id: {_eq: "${runId}"}}}}, _inc: {quota_used: 1}) { affected_rows } }
  `)

  await hasuraQuery(`
    mutation { update_workflow_runs_by_pk(pk_columns: {id: "${runId}"}, _set: {status: "completed", completed_at: "${new Date().toISOString()}"}) { id } }
  `)
}