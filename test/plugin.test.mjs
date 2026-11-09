/**
 * cat-loop host row — activation, configuration, and the snapshot routes.
 *
 * Exercises the real `apply()` against a minimal Cordis-shaped context, so a
 * regression in service publication, guard registration, or route wiring fails
 * here instead of in a live session.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, inject, name, normalizeConfig } from '../index.js'
import * as role from '../lib/role.js'

/** A fake Session with the durable surface the bridge uses. */
function makeSession(id, meta) {
  return {
    id,
    header: { id, createdAt: Date.now(), cwd: meta.cwd, agentPreset: meta.agentPreset, parentSession: meta.parentSession, origin: meta.origin },
    log: [],
    append(type, data) {
      const event = { type, data }
      this.log.push(event)
      return event
    },
  }
}

/** A minimal Host context recording registrations. */
function fakeHost(workspace) {
  const listeners = new Map()
  const guards = []
  const provided = new Map()
  const routes = []
  const sessions = new Map()
  const agents = new Map()

  const registerSession = (id, meta) => {
    const session = makeSession(id, meta)
    sessions.set(id, session)
    return session
  }

  const ctx = {
    logger: { warn() {} },
    fs: { processPath: (target) => target.path },
    tools: { guard: (guard) => (guards.push(guard), () => {}), register: () => () => {} },
    webServer: { register: (route) => (routes.push(route), () => {}) },
    on: (event, listener, options) => {
      const entries = listeners.get(event) ?? []
      entries.push({ listener, options })
      listeners.set(event, entries)
      return () => {}
    },
    effect: (register) => (register(), () => {}),
    inject: (dependencies, callback) => {
      assert.ok(Array.isArray(dependencies))
      return callback === undefined ? () => {} : callback(ctx)
    },
    provide: (service, value) => (provided.set(service, value), () => {}),
    get: (service) => {
      if (service === 'workingDirectory') return { defaultDirectory: workspace, get: () => workspace }
      if (service === 'agentPresets') return { mount: async () => ({ id: 'mounted' }) }
      if (service === 'sessionTitle') {
        return { get: () => undefined, rename: (_session, title) => ({ title }) }
      }
      if (service === 'workspaceRegistry') return { list: () => [] }
      return undefined
    },
    agents: {
      get: (id) => agents.get(id),
      async create(options) {
        const session = registerSession(options.sessionId, options.meta)
        const agent = { session, status: 'inactive' }
        agents.set(session.id, agent)
        if (typeof options.setup === 'function') await options.setup(undefined, agent)
        return { agent, dispose: async () => {} }
      },
      async resume(options) {
        const session = sessions.get(options.resumeSessionId)
        if (session === undefined) throw new Error('missing session')
        const agent = { session, status: 'inactive' }
        agents.set(session.id, agent)
        return { agent, dispose: async () => {} }
      },
    },
    sessions: {
      get: (id) => sessions.get(id),
      async flush() {
        return true
      },
    },
    subagents: { prompt: async () => ({ messageId: 'message-1' }) },
  }

  return { ctx, listeners, guards, provided, routes, sessions, agents, registerSession }
}

test('the host row applies and publishes ctx.catLoop', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'cat-loop-plugin-'))
  const { ctx, provided, guards, listeners, routes } = fakeHost(workspace)

  assert.equal(name, '@marvinlee2011/dsh-cat-loop')
  assert.deepEqual(inject, ['tools', 'agents', 'agentPresets', 'webServer', 'sessions', 'subagents', 'sessionTitle'])

  apply(ctx, { promptDir: '.cat-prompt', testDir: '.cat-test', stateFile: join(workspace, 'state.json') })

  const service = provided.get('catLoop')
  assert.ok(service, 'ctx.catLoop must be provided')
  for (const method of ['send', 'status', 'roleOf', 'prepare', 'peek', 'stateForSession']) {
    assert.equal(typeof service[method], 'function', `ctx.catLoop.${method}`)
  }

  assert.equal(guards.length, 1)
  assert.equal(listeners.get('fs/write-intent')?.[0]?.options?.prepend, true)
  assert.equal(listeners.get('fs/edit-intent')?.[0]?.options?.prepend, true)
  assert.deepEqual(
    routes.map((route) => route.path),
    ['/api/cat-loop/peek', '/api/cat-loop/state', '/api/cat-loop/teams'],
  )
})

test('normalizeConfig rejects boundaries that could escape the workspace', () => {
  const defaults = normalizeConfig(undefined)
  assert.equal(defaults.promptDir, '.cat-prompt')
  assert.equal(defaults.testDir, '.cat-test')
  assert.deepEqual(defaults.presets, {
    root: 'cat-root',
    plan: 'cat-plan',
    build: 'cat-build',
    review: 'cat-review',
  })
  assert.deepEqual(
    defaults.hiddenPresets,
    ['cat-root', 'cat-build', 'cat-review'],
    'the container and the peer teams leave the picker; the Plan conversation is the cat-loop entry',
  )
  assert.equal(defaults.visiblePresets, undefined, 'shipped modes and the container stay visible')
  assert.deepEqual(normalizeConfig({ hiddenPresets: [] }).hiddenPresets, [])
  assert.deepEqual(
    normalizeConfig({ visiblePresets: ['cat-root', 'standard'] }).visiblePresets,
    ['cat-root', 'standard'],
  )
  assert.throws(() => normalizeConfig({ hiddenPresets: [''] }), /hiddenPresets/)
  assert.throws(() => normalizeConfig({ visiblePresets: [''] }), /visiblePresets/)

  assert.throws(() => normalizeConfig({ promptDir: '../x' }), /workspace-relative/)
  assert.throws(() => normalizeConfig({ testDir: '/tmp/x' }), /workspace-relative/)
  assert.throws(() => normalizeConfig({ promptDir: '.same', testDir: '.same' }), /must differ/)
  assert.throws(
    () => normalizeConfig({ presets: { plan: 'a', build: 'a', review: 'b' } }),
    /distinct preset id/,
  )
  assert.throws(() => normalizeConfig({ presets: { root: 'cat-plan' } }), /distinct preset id/)
  assert.equal(normalizeConfig({ presets: { plan: 'x-plan' } }).presets.plan, 'x-plan')
  assert.equal(normalizeConfig({ presets: { plan: 'x-plan' } }).presets.build, 'cat-build')
})

test('the role row registers its tools and reports a missing bridge on use', async () => {
  const registered = []
  const ctx = {
    tools: { register: (definition) => (registered.push(definition), () => {}) },
    effect: (register) => (register(), () => {}),
    get: () => undefined,
  }

  role.apply(ctx, { role: 'plan' })
  assert.deepEqual(
    registered.map((tool) => tool.name),
    ['cat_send', 'cat_status'],
  )
  assert.deepEqual(registered[0].parameters.required, ['to', 'purpose', 'body'])
  assert.equal(
    registered[0].output.render({}, { to: 'build', session_id: 's', message_id: 'm', provisioned: true })[0].type,
    'text',
  )

  await assert.rejects(
    registered[0].execute({ to: 'build', purpose: 'task', body: 'x' }, { agent: {} }),
    /host service is not composed/,
  )
  await assert.rejects(registered[1].execute({}, { agent: {} }), /host service is not composed/)

  assert.throws(
    () => role.apply({ tools: { register: () => () => {} }, effect: (register) => (register(), () => {}) }, { role: 'nope' }),
    /config\.role/,
  )
})

/** Run one registered Web route against a stub response. */
function runRoute(route, request) {
  return new Promise((resolve) => {
    const res = {
      status: 0,
      headers: {},
      body: '',
      writeHead(status, headers) {
        this.status = status
        this.headers = headers
      },
      end(body) {
        this.body = body
        resolve(this)
      },
    }
    route.handler({ method: request.method ?? 'GET', url: request.url, headers: request.headers }, res)
  })
}

test('the snapshot route materializes and serves the team conversations', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'cat-loop-route-'))
  const { ctx, routes, registerSession } = fakeHost(workspace)
  registerSession('session-container', { cwd: workspace, agentPreset: 'cat-root' })
  apply(ctx, { promptDir: '.cat-prompt', testDir: '.cat-test', stateFile: join(workspace, 'state.json'), structure: 'nested' })

  const route = routes.find((candidate) => candidate.path === '/api/cat-loop/state')
  assert.ok(route !== undefined, 'the snapshot route is registered')
  assert.equal(route.kind, 'exact')

  const response = await runRoute(route, {
    url: '/api/cat-loop/state?session=session-container',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
  })
  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.ok, true)
  assert.equal(body.kind, 'inline')
  assert.equal(body.container, 'session-container')
  assert.equal(body.workspace, workspace)
  assert.deepEqual(
    body.teams.map((team) => team.role),
    ['plan', 'build', 'review'],
  )
  for (const team of body.teams) {
    // Independent root conversations: no subagent address.
    assert.equal(team.parentSessionId, null)
    assert.equal(team.mode, null)
    assert.match(team.sessionId, /^session-/)
  }

  // The read-only peek route never materializes children and answers the same way.
  const peekRoute = routes.find((candidate) => candidate.path === '/api/cat-loop/peek')
  assert.ok(peekRoute !== undefined, 'the peek route is registered')
  const peeked = await runRoute(peekRoute, {
    url: '/api/cat-loop/peek?session=session-container',
    headers: { host: '127.0.0.1:3080' },
  })
  assert.equal(peeked.status, 200)
  assert.equal(JSON.parse(peeked.body).kind, 'inline')

  // The legacy route is an alias over the same handler.
  const alias = await runRoute(routes.find((candidate) => candidate.path === '/api/cat-loop/teams'), {
    url: '/api/cat-loop/teams?session=session-container',
    headers: { host: '127.0.0.1:3080' },
  })
  assert.equal(alias.status, 200)
  assert.equal(JSON.parse(alias.body).kind, 'inline')

  const foreign = await runRoute(route, {
    url: '/api/cat-loop/state?session=session-container',
    headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' },
  })
  assert.equal(foreign.status, 403)

  const wrongMethod = await runRoute(route, {
    method: 'POST',
    url: '/api/cat-loop/state?session=session-container',
    headers: { host: '127.0.0.1:3080' },
  })
  assert.equal(wrongMethod.status, 405)

  const unknown = await runRoute(route, {
    url: '/api/cat-loop/state?session=session-other',
    headers: { host: '127.0.0.1:3080' },
  })
  assert.equal(unknown.status, 200)
  assert.equal(JSON.parse(unknown.body).ok, false)
})

test('the preset picker offers only the visible preset ids', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'cat-loop-roster-'))
  const rows = [
    { id: 'cat-root', name: 'cat-loop' },
    { id: 'cat-plan', name: 'Plan team' },
    { id: 'cat-build', name: 'Build team' },
    { id: 'cat-review', name: 'Review team' },
    { id: 'standard', name: 'Standard' },
  ]
  const registry = {
    mount: async () => ({}),
    remoteExportList: async () => ({ presets: rows.map((row) => ({ ...row, isDefault: row.id === 'cat-root' })) }),
  }
  const fake = fakeHost(workspace)
  const originalGet = fake.ctx.get
  fake.ctx.get = (service) => (service === 'agentPresets' ? registry : originalGet(service))
  apply(fake.ctx, { promptDir: '.cat-prompt', testDir: '.cat-test', stateFile: join(workspace, 'state.json') })
  const filtered = await registry.remoteExportList()
  assert.deepEqual(
    filtered.presets.map((preset) => preset.id),
    ['cat-plan', 'standard'],
    'the picker offers the Plan conversation and the shipped modes only',
  )

  // Explicit visibility lists still work for a narrower product picker.
  const wide = fakeHost(workspace)
  const wideOriginalGet = wide.ctx.get
  const wideRegistry = {
    mount: async () => ({}),
    remoteExportList: async () => ({ presets: rows.map((row) => ({ ...row, isDefault: row.id === 'cat-root' })) }),
  }
  wide.ctx.get = (service) => (service === 'agentPresets' ? wideRegistry : wideOriginalGet(service))
  apply(wide.ctx, {
    promptDir: '.cat-prompt',
    testDir: '.cat-test',
    stateFile: join(workspace, 'state.json'),
    visiblePresets: ['cat-root', 'standard'],
  })
  const widened = await wideRegistry.remoteExportList()
  assert.deepEqual(
    widened.presets.map((preset) => preset.id),
    ['cat-root', 'standard'],
  )

  // An explicit empty hidden list shows every registered preset again.
  const all = fakeHost(workspace)
  const allOriginalGet = all.ctx.get
  const allRegistry = {
    mount: async () => ({}),
    remoteExportList: async () => ({ presets: rows.map((row) => ({ ...row, isDefault: row.id === 'cat-root' })) }),
  }
  all.ctx.get = (service) => (service === 'agentPresets' ? allRegistry : allOriginalGet(service))
  apply(all.ctx, { promptDir: '.cat-prompt', testDir: '.cat-test', stateFile: join(workspace, 'state.json'), hiddenPresets: [] })
  const everything = await allRegistry.remoteExportList()
  assert.equal(everything.presets.length, rows.length)
})
