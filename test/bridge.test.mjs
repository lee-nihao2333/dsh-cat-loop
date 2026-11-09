/**
 * cat-loop bridge — nested conversation materialization, snapshot, and delivery.
 *
 * The fake Host below implements the services the bridge touches: the Session
 * store (children live outside any Agent), the Agent registry (the container is
 * the one live parent), durable session titles, the workspace registry, and the
 * subagent prompt face used for cross-team delivery.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createCatLoop } from '../lib/bridge.js'
import { DEFAULT_PRESETS } from '../lib/policy.js'

/** A workspace that exists on disk, for cwd-shaped state. */
function workspaceFixture() {
  return mkdtempSync(join(tmpdir(), 'cat-loop-bridge-'))
}

/** A fake Session with the durable surface the bridge uses. */
function makeSession(id, meta, createdAt = Date.now()) {
  return {
    id,
    header: {
      id,
      createdAt,
      cwd: meta.cwd,
      agentPreset: meta.agentPreset,
      parentSession: meta.parentSession,
      origin: meta.origin,
      delegationDepth: meta.delegationDepth,
    },
    log: [],
    append(type, data) {
      const event = { type, data }
      this.log.push(event)
      return event
    },
  }
}

/**
 * A minimal Host context for the nested model.
 * @param {string} workspace - project directory.
 * @param {string} stateFile - bridge state path.
 */
function fakeHost(workspace, stateFile, options = {}) {
  /** @type {Map<string, object>} */
  const sessions = new Map()
  /** @type {Map<string, object>} */
  const agents = new Map()
  /** @type {object[]} */
  const createCalls = []
  /** @type {object[]} */
  const prompts = []
  /** @type {object[]} */
  const attached = []
  const registryCalls = { created: [], attached: [], archived: [] }
  /** @type {Map<string, string>} */
  const titles = new Map()

  const registerSession = (id, meta) => {
    const session = makeSession(id, meta)
    sessions.set(id, session)
    return session
  }

  const agentFor = (session) => {
    const agent = {
      session,
      status: 'inactive',
      steer(message) {
        prompts.push({ to: session.id, message })
      },
    }
    agents.set(session.id, agent)
    return agent
  }

  const ctx = {
    logger: { warn() {} },
    get(name) {
      if (name === 'agentPresets') return { mount: async () => ({ id: 'mounted' }) }
      if (name === 'workingDirectory') return { defaultDirectory: workspace }
      if (name === 'workspaceRegistry') {
        return {
          list: () => [
            {
              path: workspace,
              attachSession: async (sessionId) => {
                attached.push(sessionId)
              },
            },
          ],
          create: async (path, title) => {
            registryCalls.created.push({ path, title })
            return {
              id: 'ws-folder',
              path,
              attachSession: async (sessionId) => {
                registryCalls.attached.push(sessionId)
              },
            }
          },
          archiveSession: async (sessionId) => {
            registryCalls.archived.push(sessionId)
          },
        }
      }
      if (name === 'agentDefaultModel') {
        return {
          currentSelection: () => ({
            provider: 'deepseek-official',
            model: 'deepseek-flash',
            reasoningEffort: 'max',
          }),
        }
      }
      if (name === 'sessionTitle') {
        return {
          get: (session) => titles.get(session.id),
          rename: (session, title) => {
            titles.set(session.id, title)
            return { title }
          },
        }
      }
      return undefined
    },
    agents: {
      get: (id) => agents.get(id),
      async create(options) {
        createCalls.push(options)
        const session = registerSession(options.sessionId, options.meta)
        const agent = agentFor(session)
        if (typeof options.setup === 'function') await options.setup(undefined, agent)
        return {
          agent,
          // A disposed agent leaves its durable session behind; the manager
          // cold-resumes that stored conversation later.
          dispose: async () => {
            agents.delete(session.id)
          },
        }
      },
      async resume(options) {
        const session = sessions.get(options.resumeSessionId)
        if (session === undefined) throw new Error('missing persisted session')
        return { agent: agentFor(session), dispose: async () => {} }
      },
    },
    sessions: {
      get: (id) => sessions.get(id),
      async flush() {
        return true
      },
    },
    subagents: {
      async prompt(request, signal) {
        prompts.push({ request, signal })
        return { messageId: `message-${prompts.length}` }
      },
    },
  }

  const settings = {
    presets: { ...DEFAULT_PRESETS },
    structure: 'nested',
    stateFile,
    ...(options.structure === undefined ? {} : { structure: options.structure }),
  }
  return { ctx, settings, sessions, agents, createCalls, prompts, attached, registryCalls, titles, registerSession, agentFor }
}

/** A live calling agent for the named preset. */
function liveAgent(host, sessionId, presetId, workspace) {
  const session =
    host.sessions.get(sessionId) ?? host.registerSession(sessionId, { cwd: workspace, agentPreset: presetId })
  return host.agents.get(sessionId) ?? host.agentFor(session)
}

test('prepare materializes the container and its three independent teams', async () => {
  const workspace = workspaceFixture()
  const host = fakeHost(workspace, join(workspace, 'state.json'))
  const bridge = createCatLoop(host.ctx, host.settings)
  const container = host.registerSession('session-container', { cwd: workspace, agentPreset: 'cat-root' })

  const snapshot = await bridge.prepare('session-container')

  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.kind, 'inline')
  assert.equal(snapshot.container, 'session-container')
  assert.equal(snapshot.currentRole, 'root')
  assert.deepEqual(
    snapshot.teams.map((team) => team.role),
    ['plan', 'build', 'review'],
  )
  for (const team of snapshot.teams) {
    // Independent root conversations, not subagent children.
    assert.equal(team.parentSessionId, null)
    assert.equal(team.mode, null)
    assert.equal(team.status, 'stored')
    assert.match(team.sessionId, /^session-/)
  }

  // The container is a visible conversation: one closed turn and a title.
  assert.deepEqual(
    container.log
      .filter((event) => event.type === 'turn/start' || event.type === 'turn/end')
      .map((event) => event.type),
    ['turn/start', 'turn/end'],
  )
  assert.equal(host.titles.get('session-container'), 'cat-loop 三队')
  // Everything is listed under the user's own workspace: the container and the
  // three team conversations (no extra workspace is ever registered).
  assert.deepEqual(host.attached, ['session-container', ...snapshot.teams.map((team) => team.sessionId)])

  for (const team of snapshot.teams) {
    const session = host.sessions.get(team.sessionId)
    assert.equal(session.header.parentSession, undefined)
    assert.equal(session.header.origin, undefined)
    assert.equal(session.header.agentPreset, team.preset)
    assert.deepEqual(
      session.log.map((event) => event.type),
      ['turn/start', 'agent-preset/selected', 'step/start', 'system/message', 'user/message', 'step/end', 'turn/end'],
    )
    // The surface must open with a protected system head: the agent loop later
    // appends its own system message and would otherwise corrupt the log.
    assert.equal(session.log[3].data.message.role, 'system')
    assert.match(session.log[3].data.message.content[0].text, /cat-loop/)
    assert.match(session.log[4].data.content[0].text, /已就绪/)
    assert.equal(host.titles.get(team.sessionId), team.role)
    const created = host.createCalls.find((call) => call.sessionId === team.sessionId)
    assert.ok(created !== undefined)
    assert.deepEqual(created.agentOptions, {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'max',
    })
  }

  // The container carries no subagent catalog: the teams are not its children.
  assert.equal(container.log.filter((event) => event.type === 'subagent/catalog').length, 0)

  const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))
  assert.equal(state.version, 2)
  assert.equal(state.conversations['session-container'].flavor, 'inline')
  assert.equal(state.conversations['session-container'].plan, snapshot.teams[0].sessionId)
})

test('prepare is idempotent and answers for a team conversation', async () => {
  const workspace = workspaceFixture()
  const host = fakeHost(workspace, join(workspace, 'state.json'))
  const bridge = createCatLoop(host.ctx, host.settings)
  const container = host.registerSession('session-container', { cwd: workspace, agentPreset: 'cat-root' })

  const first = await bridge.prepare('session-container')
  const second = await bridge.prepare('session-container')
  assert.deepEqual(
    second.teams.map((team) => team.sessionId),
    first.teams.map((team) => team.sessionId),
  )
  assert.equal(container.log.filter((event) => event.type === 'turn/start').length, 1)
  assert.equal(host.createCalls.length, 3, 'the three teams are created exactly once')

  const planSession = first.teams[0].sessionId
  const plan = await bridge.prepare(planSession)
  assert.equal(plan.ok, true)
  assert.equal(plan.kind, 'inline')
  assert.equal(plan.container, 'session-container')
  assert.equal(plan.currentRole, 'plan')
  assert.deepEqual(
    plan.teams.map((team) => team.sessionId),
    first.teams.map((team) => team.sessionId),
  )
})

test('prepare rejects sessions outside the cat-loop presets', async () => {
  const workspace = workspaceFixture()
  const host = fakeHost(workspace, join(workspace, 'state.json'))
  const bridge = createCatLoop(host.ctx, host.settings)
  host.registerSession('session-other', { cwd: workspace, agentPreset: 'standard' })

  const snapshot = await bridge.prepare('session-other')
  assert.equal(snapshot.ok, false)
  assert.equal(snapshot.error.code, 'not-cat-loop')

  const missing = await bridge.prepare('session-missing')
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'session-unavailable')
})

test('cat_send wakes the target team conversation and steers the message', async () => {
  const workspace = workspaceFixture()
  const host = fakeHost(workspace, join(workspace, 'state.json'))
  const bridge = createCatLoop(host.ctx, host.settings)
  host.registerSession('session-container', { cwd: workspace, agentPreset: 'cat-root' })
  const snapshot = await bridge.prepare('session-container')
  const planId = snapshot.teams[0].sessionId
  const buildId = snapshot.teams[1].sessionId
  const plan = liveAgent(host, planId, 'cat-plan', workspace)

  const result = await bridge.send(plan, {
    to: 'build',
    purpose: 'task',
    body: 'Implement .cat-prompt/01-counter.md',
  })

  assert.equal(result.to, 'build')
  assert.equal(result.session_id, buildId)
  assert.equal(result.provisioned, false)
  assert.equal(host.prompts.length, 1)
  const { to, message } = host.prompts[0]
  assert.equal(to, buildId)
  assert.match(message.content[0].text, /^cat-loop · Plan team → Build team/)
  assert.match(message.content[0].text, /purpose: task/)
})

test('cat_send still supports a pre-2.0 conversation recorded as root sessions', async () => {
  const workspace = workspaceFixture()
  const stateFile = join(workspace, 'state.json')
  writeFileSync(
    stateFile,
    JSON.stringify({
      version: 1,
      workspaces: { [workspace]: { plan: 'session-plan', build: 'session-build', review: 'session-review' } },
    }),
    'utf8',
  )
  const host = fakeHost(workspace, stateFile)
  const bridge = createCatLoop(host.ctx, host.settings)
  host.registerSession('session-build', { cwd: workspace, agentPreset: 'cat-build' })
  host.registerSession('session-review', { cwd: workspace, agentPreset: 'cat-review' })
  const plan = liveAgent(host, 'session-plan', 'cat-plan', workspace)

  const legacy = await bridge.prepare('session-plan')
  assert.equal(legacy.ok, true)
  assert.equal(legacy.kind, 'legacy')
  assert.equal(legacy.currentRole, 'plan')

  const result = await bridge.send(plan, { to: 'build', purpose: 'note', body: 'hello' })
  assert.equal(result.session_id, 'session-build')
  assert.equal(result.message_id.length > 0, true)
})

test('status reports the nested teams from a child conversation', async () => {
  const workspace = workspaceFixture()
  const host = fakeHost(workspace, join(workspace, 'state.json'))
  const bridge = createCatLoop(host.ctx, host.settings)
  host.registerSession('session-container', { cwd: workspace, agentPreset: 'cat-root' })
  const snapshot = await bridge.prepare('session-container')
  const plan = liveAgent(host, snapshot.teams[0].sessionId, 'cat-plan', workspace)

  const report = bridge.status(plan)
  assert.equal(report.workspace, workspace)
  assert.deepEqual(
    report.teams.map((team) => team.role),
    ['plan', 'build', 'review'],
  )
  assert.equal(report.teams[0].session_id, snapshot.teams[0].sessionId)
  assert.equal(report.teams[0].status, 'current')
})

test('peek answers from durable state without materializing children', async () => {
  const workspace = workspaceFixture()
  const host = fakeHost(workspace, join(workspace, 'state.json'), { structure: 'nested' })
  const bridge = createCatLoop(host.ctx, host.settings)
  host.registerSession('session-container', { cwd: workspace, agentPreset: 'cat-root' })

  // Before prepare nothing is materialized, so the container is unknown.
  assert.equal(bridge.peek('session-container').ok, false)
  assert.equal(host.createCalls.length, 0, 'peek never creates a child session')

  const prepared = await bridge.prepare('session-container')
  assert.equal(prepared.kind, 'inline')
  const snapshot = bridge.peek('session-container')
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.kind, 'inline')
  assert.deepEqual(
    snapshot.teams.map((team) => team.role),
    ['plan', 'build', 'review'],
  )
  assert.ok(snapshot.teams.every((team) => typeof team.sessionId === 'string' && team.sessionId !== ''))
  assert.equal(snapshot.teams[0].parentSessionId, null)

  const child = bridge.peek(prepared.teams[1].sessionId)
  assert.equal(child.ok, true)
  assert.equal(child.kind, 'inline')
  assert.equal(child.currentRole, 'build')
  assert.equal(bridge.peek('session-unknown').ok, false)
})

test('folder structure groups three independent team conversations in a sidebar folder', async () => {
  const workspace = workspaceFixture()
  const host = fakeHost(workspace, join(workspace, 'state.json'), { structure: 'folder' })
  const bridge = createCatLoop(host.ctx, host.settings)
  host.registerSession('session-container', { cwd: workspace, agentPreset: 'cat-root' })

  const snapshot = await bridge.prepare('session-container')
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.kind, 'folder')
  // The folder is a child directory of the project, so the workspace-tree view
  // nests it under the project workspace.
  assert.equal(snapshot.folder, join(workspace, '.cat-loop'))
  assert.deepEqual(
    snapshot.teams.map((team) => team.role),
    ['plan', 'build', 'review'],
  )
  const ids = snapshot.teams.map((team) => team.sessionId)
  assert.ok(ids.every((id) => typeof id === 'string' && id !== ''))

  // Three independent, real team conversations living in the folder workspace.
  for (const [index, role] of ['plan', 'build', 'review'].entries()) {
    const session = host.sessions.get(ids[index])
    assert.equal(session.header.cwd, snapshot.folder)
    assert.equal(session.header.agentPreset, `cat-${role}`)
    assert.equal(session.header.parentSession, undefined)
  }
  const folderRegistration = host.registryCalls.created.find((row) => row.path === snapshot.folder)
  assert.ok(folderRegistration !== undefined, 'the folder workspace is registered')
  assert.equal(folderRegistration.title, 'cat-loop')
  const projectRegistration = host.registryCalls.created.find((row) => row.path === workspace)
  assert.ok(projectRegistration !== undefined, 'the project workspace is registered')
  assert.deepEqual([...host.registryCalls.attached].sort(), [...ids].sort())

  // Opening one team answers with the folder snapshot marked current.
  const teamSnapshot = await bridge.prepare(ids[0])
  assert.equal(teamSnapshot.kind, 'folder')
  assert.equal(teamSnapshot.currentRole, 'plan')

  // Guards and messages anchor at the real project, not the folder directory.
  assert.equal(bridge.projectRootOf(host.sessions.get(ids[1])), workspace)

  // cat_send reaches the peer team conversation through its inbox.
  const planAgent = (await host.ctx.agents.resume({ resumeSessionId: ids[0] })).agent
  await bridge.send(planAgent, { to: 'build', purpose: 'task', body: 'go' })
  assert.ok(host.prompts.some((row) => row.to === ids[1]))
})

test('a second cat-root entry for the same project answers with the folder teams', async () => {
  const workspace = workspaceFixture()
  const host = fakeHost(workspace, join(workspace, 'state.json'), { structure: 'folder' })
  const bridge = createCatLoop(host.ctx, host.settings)
  host.registerSession('session-container', { cwd: workspace, agentPreset: 'cat-root' })
  const first = await bridge.prepare('session-container')

  // The browser restores/creates another cat-root entry for the same project.
  host.registerSession('session-entry-2', { cwd: workspace, agentPreset: 'cat-root' })
  const second = await bridge.prepare('session-entry-2')
  assert.equal(second.kind, 'folder')
  assert.equal(second.folder, first.folder)
  assert.deepEqual(
    second.teams.map((team) => team.sessionId),
    first.teams.map((team) => team.sessionId),
    'the entry gets the same three team conversations so the client can redirect',
  )
})

test('a blank New Session inside a folder redirects to that folder instead of nesting', async () => {
  const workspace = workspaceFixture()
  const host = fakeHost(workspace, join(workspace, 'state.json'), { structure: 'folder' })
  const bridge = createCatLoop(host.ctx, host.settings)
  host.registerSession('session-container', { cwd: workspace, agentPreset: 'cat-root' })
  const first = await bridge.prepare('session-container')
  // A stray blank cat-root conversation created with the folder as its cwd.
  host.registerSession('session-stray', { cwd: first.folder, agentPreset: 'cat-root' })
  const second = await bridge.prepare('session-stray')
  assert.equal(second.kind, 'folder')
  assert.equal(second.folder, first.folder)
  const folderRegistrations = host.registryCalls.created.filter((row) => row.path === first.folder)
  assert.equal(folderRegistrations.length, 1, 'no second folder is created')
})
