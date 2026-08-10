'use client'
import { useState, useEffect } from 'react'
import { apolloClient } from '@/lib/apollo'
import { gql } from '@apollo/client'

const GET_ORGS = gql`
  query GetOrgs {
    organizations {
      id
      name
      quota_allowed
      quota_used
      workflows {
        id
        name
        workflow_runs(order_by: {started_at: desc}, limit: 1) {
          id
          status
        }
        workflow_steps {
          id
          step_type
          step_order
        }
        workflow_triggers {
          id
          trigger_type
        }
      }
    }
  }
`

const CREATE_WORKFLOW = gql`
  mutation CreateWorkflow($name: String!, $org_id: uuid!, $user_id: uuid!) {
    insert_workflows_one(object: {
      name: $name,
      org_id: $org_id,
      created_by: $user_id
    }) {
      id
      name
    }
  }
`

const ADD_STEP = gql`
  mutation AddStep($workflow_id: uuid!, $step_type: String!, $step_order: Int!, $config: jsonb!) {
    insert_workflow_steps_one(object: {
      workflow_id: $workflow_id,
      step_type: $step_type,
      step_order: $step_order,
      config: $config
    }) {
      id
      step_type
    }
  }
`

const ADD_TRIGGER = gql`
  mutation AddTrigger($workflow_id: uuid!, $trigger_type: String!) {
    insert_workflow_triggers_one(object: {
      workflow_id: $workflow_id,
      trigger_type: $trigger_type
    }) {
      id
      trigger_type
    }
  }
`

const SUBSCRIBE_STEP_RUNS = gql`
  subscription StepRuns($workflow_run_id: uuid!) {
    step_runs(where: {workflow_run_id: {_eq: $workflow_run_id}}, order_by: {started_at: asc}) {
      id
      status
      input
      output
      error
      attempt_count
      approved_by
      approved_at
      workflow_step {
        step_type
        step_order
      }
    }
  }
`

export default function Home() {
  const [orgs, setOrgs] = useState<any[]>([])
  const [selectedOrg, setSelectedOrg] = useState<any>(null)
  const [selectedUser, setSelectedUser] = useState<string>('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  const [selectedRole, setSelectedRole] = useState<string>('owner')
  const [activeRun, setActiveRun] = useState<string | null>(null)
  const [stepRuns, setStepRuns] = useState<any[]>([])
  const [newWorkflowName, setNewWorkflowName] = useState('')
  const [loading, setLoading] = useState(false)
  const [runLoading, setRunLoading] = useState(false)
  const [message, setMessage] = useState('')

  const users = [
    { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'Alice (Owner - Org A)', role: 'owner', org: '11111111-1111-1111-1111-111111111111' },
    { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name: 'Bob (Editor - Org A)', role: 'editor', org: '11111111-1111-1111-1111-111111111111' },
    { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', name: 'Carol (Viewer - Org A)', role: 'viewer', org: '11111111-1111-1111-1111-111111111111' },
    { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', name: 'Dave (Owner - Org B)', role: 'owner', org: '22222222-2222-2222-2222-222222222222' },
  ]

  useEffect(() => {
    loadOrgs()
  }, [])

  useEffect(() => {
    if (orgs.length > 0 && !selectedOrg) {
      const firstUser = users[0]
      const org = orgs.find((o: any) => o.id === firstUser.org)
      if (org) setSelectedOrg(org)
    }
  }, [orgs])

  useEffect(() => {
    if (!activeRun) return
    const subscription = apolloClient.subscribe({
      query: SUBSCRIBE_STEP_RUNS,
      variables: { workflow_run_id: activeRun }
    }).subscribe({
      next: ({ data }: { data: any }) => {
        if (data?.step_runs) setStepRuns(data.step_runs)
      },
      error: (err: any) => console.error('Subscription error:', err)
    })
    return () => subscription.unsubscribe()
  }, [activeRun])

  const loadOrgs = async () => {
    try {
      const result = await apolloClient.query({ query: GET_ORGS, fetchPolicy: 'network-only' })
      const data = result.data as any
      setOrgs(data.organizations)
      return data.organizations
    } catch (err) {
      console.error('Error loading orgs:', err)
      return []
    }
  }

  const handleUserSwitch = async (userId: string) => {
    const user = users.find(u => u.id === userId)
    if (user) {
      setSelectedUser(userId)
      setSelectedRole(user.role)
      let org = orgs.find((o: any) => o.id === user.org)
      if (!org) {
        const freshOrgs = await loadOrgs()
        org = freshOrgs.find((o: any) => o.id === user.org)
      }
      setSelectedOrg(org || null)
      setMessage(`Switched to ${user.name}`)
      setTimeout(() => setMessage(''), 3000)
    }
  }

  const createWorkflow = async () => {
    if (!newWorkflowName || !selectedOrg) return
    if (selectedRole === 'viewer') {
      setMessage('❌ Viewers cannot create workflows!')
      setTimeout(() => setMessage(''), 3000)
      return
    }
    setLoading(true)
    try {
      const result = await apolloClient.mutate({
        mutation: CREATE_WORKFLOW,
        variables: {
          name: newWorkflowName,
          org_id: selectedOrg.id,
          user_id: selectedUser
        }
      })
      const data = result.data as any
      const workflowId = data.insert_workflows_one.id

      const steps = [
        { type: 'llm_call', order: 1, config: { prompt: 'Analyze this request and respond with JSON: {"action": "approve" or "reject", "reason": "your reason"}', model: 'llama3-8b-8192' } },
        { type: 'http_request', order: 2, config: { url: 'https://httpbin.org/post', method: 'POST' } },
        { type: 'conditional_branch', order: 3, config: { condition: 'output.action === "approve"', true_path: 'continue', false_path: 'stop' } },
        { type: 'approval_gate', order: 4, config: { required_role: 'owner', message: 'Please approve to continue' } },
        { type: 'db_write', order: 5, config: { table: 'workflow_runs', action: 'update_status' } },
      ]

      for (const step of steps) {
        await apolloClient.mutate({
          mutation: ADD_STEP,
          variables: { workflow_id: workflowId, step_type: step.type, step_order: step.order, config: step.config }
        })
      }

      await apolloClient.mutate({ mutation: ADD_TRIGGER, variables: { workflow_id: workflowId, trigger_type: 'manual' } })
      await apolloClient.mutate({ mutation: ADD_TRIGGER, variables: { workflow_id: workflowId, trigger_type: 'webhook' } })

      setNewWorkflowName('')
      setMessage('✅ Workflow created with 5 steps!')
      const freshOrgs = await loadOrgs()
      const updatedOrg = freshOrgs.find((o: any) => o.id === selectedOrg.id)
      if (updatedOrg) setSelectedOrg(updatedOrg)
    } catch (err: any) {
      setMessage('❌ Error: ' + err.message)
    }
    setLoading(false)
    setTimeout(() => setMessage(''), 4000)
  }

  const triggerWorkflow = async (workflowId: string) => {
    if (selectedRole === 'viewer') {
      setMessage('❌ Viewers cannot trigger workflows!')
      setTimeout(() => setMessage(''), 3000)
      return
    }

    const workflow = selectedOrg?.workflows?.find((w: any) => w.id === workflowId)
    if (!workflow) {
      setMessage('❌ Cross-org violation blocked! You cannot access this workflow.')
      setTimeout(() => setMessage(''), 4000)
      return
    }

    setRunLoading(true)
    try {
      const res = await fetch('/api/trigger-workflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow_id: workflowId, user_id: selectedUser, role: selectedRole, org_id: selectedOrg.id })
      })
      const data = await res.json()
      if (data.run_id) {
        setActiveRun(data.run_id)
        setStepRuns([])
        setMessage('✅ Workflow started! Watching live...')
      } else {
        setMessage('❌ ' + (data.error || 'Failed to start'))
      }
    } catch (err: any) {
      setMessage('❌ Error: ' + err.message)
    }
    setRunLoading(false)
    const freshOrgs = await loadOrgs()
    const updatedOrg = freshOrgs.find((o: any) => o.id === selectedOrg?.id)
    if (updatedOrg) setSelectedOrg(updatedOrg)
    setTimeout(() => setMessage(''), 4000)
  }

  const approveStep = async (stepRunId: string) => {
    if (selectedRole === 'viewer') {
      setMessage('❌ Viewers cannot approve steps!')
      setTimeout(() => setMessage(''), 3000)
      return
    }
    try {
      const res = await fetch('/api/approve-step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step_run_id: stepRunId, user_id: selectedUser, role: selectedRole })
      })
      const data = await res.json()
      if (data.success) {
        setMessage('✅ Step approved! Continuing...')
      } else {
        setMessage('❌ ' + (data.error || 'Approval failed'))
      }
    } catch (err: any) {
      setMessage('❌ Error: ' + err.message)
    }
    setTimeout(() => setMessage(''), 4000)
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'bg-green-500'
      case 'running': return 'bg-blue-500 animate-pulse'
      case 'paused': return 'bg-yellow-500'
      case 'failed': return 'bg-red-500'
      default: return 'bg-gray-400'
    }
  }

  const currentUser = users.find(u => u.id === selectedUser)

  return (
    <div className="min-h-screen bg-gray-950 text-white p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-purple-400">SubSpace Workflow Builder</h1>
            <p className="text-gray-400 mt-1">AI Agent Workflow Orchestration Platform</p>
          </div>
          <div className="text-right">
            <div className="text-sm text-gray-400">Logged in as</div>
            <div className="font-semibold text-purple-300">{currentUser?.name}</div>
            <div className={`text-xs px-2 py-0.5 rounded mt-1 inline-block ${selectedRole === 'owner' ? 'bg-purple-600' : selectedRole === 'editor' ? 'bg-blue-600' : 'bg-gray-600'}`}>
              {selectedRole.toUpperCase()}
            </div>
          </div>
        </div>

        {message && (
          <div className={`mb-4 p-3 rounded-lg text-sm font-medium ${message.startsWith('❌') ? 'bg-red-900 text-red-200' : 'bg-green-900 text-green-200'}`}>
            {message}
          </div>
        )}

        <div className="grid grid-cols-12 gap-6">
          <div className="col-span-4 space-y-4">
            <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <h2 className="text-sm font-semibold text-gray-400 uppercase mb-3">Switch User</h2>
              <div className="space-y-2">
                {users.map(user => (
                  <button
                    key={user.id}
                    onClick={() => handleUserSwitch(user.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all ${selectedUser === user.id ? 'bg-purple-700 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
                  >
                    <div className="font-medium">{user.name}</div>
                  </button>
                ))}
              </div>
            </div>

            {selectedOrg && (
              <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
                <h2 className="text-sm font-semibold text-gray-400 uppercase mb-3">Org Quota</h2>
                <div className="text-lg font-bold text-white">{selectedOrg.name}</div>
                <div className="mt-2">
                  <div className="flex justify-between text-sm text-gray-400 mb-1">
                    <span>Used</span>
                    <span>{selectedOrg.quota_used} / {selectedOrg.quota_allowed}</span>
                  </div>
                  <div className="w-full bg-gray-700 rounded-full h-2">
                    <div
                      className="bg-purple-500 h-2 rounded-full transition-all"
                      style={{ width: `${Math.min((selectedOrg.quota_used / selectedOrg.quota_allowed) * 100, 100)}%` }}
                    />
                  </div>
                </div>
              </div>
            )}

            {selectedOrg && selectedRole !== 'viewer' && (
              <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
                <h2 className="text-sm font-semibold text-gray-400 uppercase mb-3">Create Workflow</h2>
                <input
                  type="text"
                  value={newWorkflowName}
                  onChange={e => setNewWorkflowName(e.target.value)}
                  placeholder="Workflow name..."
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 mb-3 focus:outline-none focus:border-purple-500"
                />
                <button
                  onClick={createWorkflow}
                  disabled={loading || !newWorkflowName}
                  className="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-gray-700 text-white font-medium py-2 rounded-lg text-sm transition-all"
                >
                  {loading ? 'Creating...' : '+ Create Workflow'}
                </button>
              </div>
            )}

            {selectedRole === 'viewer' && (
              <div className="bg-gray-900 rounded-xl p-4 border border-yellow-800">
                <p className="text-yellow-400 text-sm">👁 Viewer mode — read only. Cannot create or trigger workflows.</p>
              </div>
            )}
          </div>

          <div className="col-span-8 space-y-4">
            {selectedOrg ? (
              <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
                <h2 className="text-lg font-semibold mb-4">Workflows in {selectedOrg.name}</h2>
                {selectedOrg.workflows?.length === 0 ? (
                  <p className="text-gray-500 text-sm">No workflows yet. Create one!</p>
                ) : (
                  <div className="space-y-3">
                    {selectedOrg.workflows?.map((workflow: any) => (
                      <div key={workflow.id} className="bg-gray-800 rounded-xl p-4 border border-gray-700">
                        <div className="flex items-center justify-between mb-3">
                          <div>
                            <h3 className="font-semibold text-white">{workflow.name}</h3>
                            <div className="flex gap-2 mt-1">
                              {workflow.workflow_triggers?.map((t: any) => (
                                <span key={t.id} className="text-xs bg-gray-700 px-2 py-0.5 rounded text-gray-300">
                                  {t.trigger_type}
                                </span>
                              ))}
                            </div>
                          </div>
                          {selectedRole !== 'viewer' && (
                            <button
                              onClick={() => triggerWorkflow(workflow.id)}
                              disabled={runLoading}
                              className="bg-green-600 hover:bg-green-700 disabled:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-all"
                            >
                              {runLoading ? 'Starting...' : '▶ Run'}
                            </button>
                          )}
                        </div>

                        <div className="flex gap-2 flex-wrap">
                          {workflow.workflow_steps?.sort((a: any, b: any) => a.step_order - b.step_order).map((step: any) => (
                            <div key={step.id} className="flex items-center gap-1">
                              <span className="text-xs bg-gray-700 border border-gray-600 px-2 py-1 rounded text-gray-300">
                                {step.step_order}. {step.step_type}
                              </span>
                              {step.step_order < workflow.workflow_steps.length && (
                                <span className="text-gray-600 text-xs">→</span>
                              )}
                            </div>
                          ))}
                        </div>

                        {workflow.workflow_runs?.[0] && (
                          <div className="mt-2 flex items-center gap-2">
                            <span className="text-xs text-gray-500">Last run:</span>
                            <span className={`text-xs px-2 py-0.5 rounded text-white ${getStatusColor(workflow.workflow_runs[0].status)}`}>
                              {workflow.workflow_runs[0].status}
                            </span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-gray-900 rounded-xl p-8 border border-gray-800 text-center">
                <p className="text-gray-400">Loading organization data...</p>
              </div>
            )}

            {activeRun && (
              <div className="bg-gray-900 rounded-xl p-4 border border-purple-800">
                <h2 className="text-lg font-semibold mb-4 text-purple-300">
                  Live Run Status
                  <span className="ml-2 inline-block w-2 h-2 bg-green-400 rounded-full animate-pulse"></span>
                </h2>
                {stepRuns.length === 0 ? (
                  <p className="text-gray-500 text-sm">Waiting for steps...</p>
                ) : (
                  <div className="space-y-2">
                    {stepRuns.map((sr: any) => (
                      <div key={sr.id} className="bg-gray-800 rounded-lg p-3 border border-gray-700">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className={`w-3 h-3 rounded-full ${getStatusColor(sr.status)}`} />
                            <span className="text-sm font-medium">
                              Step {sr.workflow_step?.step_order}: {sr.workflow_step?.step_type}
                            </span>
                          </div>
                          <span className={`text-xs px-2 py-0.5 rounded text-white ${getStatusColor(sr.status)}`}>
                            {sr.status}
                          </span>
                        </div>

                        {sr.output && Object.keys(sr.output).length > 0 && (
                          <div className="mt-2 text-xs text-gray-400 bg-gray-900 rounded p-2 font-mono">
                            {JSON.stringify(sr.output, null, 2).slice(0, 200)}
                          </div>
                        )}

                        {sr.error && (
                          <div className="mt-2 text-xs text-red-400 bg-red-900/20 rounded p-2">
                            Error: {sr.error}
                          </div>
                        )}

                        {sr.status === 'paused' && sr.workflow_step?.step_type === 'approval_gate' && (
                          <div className="mt-3 flex items-center gap-3">
                            <span className="text-yellow-400 text-sm">⏸ Awaiting approval</span>
                            {selectedRole !== 'viewer' ? (
                              <button
                                onClick={() => approveStep(sr.id)}
                                className="bg-yellow-600 hover:bg-yellow-700 text-white px-3 py-1 rounded text-sm font-medium"
                              >
                                ✓ Approve
                              </button>
                            ) : (
                              <span className="text-red-400 text-xs">Viewers cannot approve</span>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <h2 className="text-sm font-semibold text-gray-400 uppercase mb-3">Cross-Org Isolation Test</h2>
              <p className="text-xs text-gray-500 mb-3">Switch to Dave (Org B) and try to access Org A workflows — it will be blocked.</p>
              <div className="flex gap-2">
                <button
                  onClick={() => handleUserSwitch('dddddddd-dddd-dddd-dddd-dddddddddddd')}
                  className="bg-red-800 hover:bg-red-700 text-white px-3 py-1.5 rounded text-sm"
                >
                  Switch to Org B User
                </button>
                <button
                  onClick={() => handleUserSwitch('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')}
                  className="bg-purple-800 hover:bg-purple-700 text-white px-3 py-1.5 rounded text-sm"
                >
                  Switch back to Org A
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
