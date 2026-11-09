/**
 * cat-loop runtime seam — the part unit tests with a fake context cannot prove.
 *
 * The file boundary depends on one subtle Cordis fact: `fs/write-intent` is a
 * single-slot waterfall, the shipped observation policy answers WITHOUT calling
 * `next()`, and this plugin's listener must therefore run BEFORE it. This test
 * loads the real Cordis runtime, registers a listener that mimics the shipped
 * policy first, then installs the real guard and dispatches exactly as
 * `dsh-tool-fs` does. A wrong registration order would let the eager listener
 * swallow the decision and the denial would never be reached.
 *
 * Opt-in because the Harness runtime lives outside this package: point
 * DSH_CORDIS_FILE at `<dsh>/node_modules/@deepseek-ai/cordis/lib/index.js`.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { installGuard } from '../lib/guard.js'
import { DEFAULT_PRESETS } from '../lib/policy.js'

const cordisFile = process.env.DSH_CORDIS_FILE
const skip = cordisFile === undefined ? 'set DSH_CORDIS_FILE to the harness cordis/lib/index.js' : false

/** Workspace with both boundary directories present. */
function workspaceFixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'cat-loop-runtime-'))
  mkdirSync(join(workspace, '.cat-prompt'))
  mkdirSync(join(workspace, '.cat-test'))
  return workspace
}

/** A root context with the three services the guard reads. */
async function runtimeContext(workspace) {
  const { Context } = await import(pathToFileURL(cordisFile).href)
  const ctx = new Context()
  const guards = []
  ctx.provide('tools', { guard: (guard) => (guards.push(guard), () => {}) })
  ctx.provide('fs', { processPath: (target) => target.path })
  ctx.provide('workingDirectory', { defaultDirectory: workspace, get: () => workspace })
  return { ctx, guards }
}

/** One live session shaped like the harness session the guard reads. */
function actor(workspace, preset) {
  return { agent: { session: { id: 'session-' + preset, header: { cwd: workspace, agentPreset: preset } } } }
}

test('the guard precedes the shipped intent policy in the real waterfall', { skip }, async () => {
  const workspace = workspaceFixture()
  const { ctx, guards } = await runtimeContext(workspace)

  // The shipped fs-observation-policy answers the single slot without next().
  ctx.on('fs/write-intent', () => ({ kind: 'createIfAbsent' }))
  ctx.on('fs/edit-intent', () => ({ version: 'observed-version' }))

  installGuard(ctx, { promptDir: '.cat-prompt', testDir: '.cat-test', presets: DEFAULT_PRESETS })
  assert.equal(guards.length, 1, 'the monotonic tool guard is registered')

  const planWrite = { path: join(workspace, '.cat-prompt', '01-task.md') }
  const allowed = ctx.waterfall('fs/write-intent', planWrite, actor(workspace, 'cat-plan'), () => undefined)
  assert.deepEqual(allowed, { kind: 'createIfAbsent' }, 'an allowed write still gets the shipped policy\'s intent')

  const planEscape = { path: join(workspace, 'src.js') }
  assert.throws(
    () => ctx.waterfall('fs/write-intent', planEscape, actor(workspace, 'cat-plan'), () => undefined),
    /Plan team may only write/,
    'our listener must run before the eager policy, or the denial would never be reached',
  )

  // Non-cat sessions are untouched by the guard.
  const foreign = ctx.waterfall('fs/write-intent', planEscape, actor(workspace, 'standard'), () => undefined)
  assert.deepEqual(foreign, { kind: 'createIfAbsent' })

  // Edits follow the same slot with their own intent shape.
  const edit = ctx.waterfall('fs/edit-intent', { path: join(workspace, '.cat-test', 'check.mjs') }, actor(workspace, 'cat-review'), () => undefined)
  assert.deepEqual(edit, { version: 'observed-version' })
  assert.throws(
    () => ctx.waterfall('fs/edit-intent', { path: join(workspace, 'src.js') }, actor(workspace, 'cat-review'), () => undefined),
    /Review team may only write/,
  )
  assert.throws(
    () => ctx.waterfall('fs/edit-intent', { path: join(workspace, '.cat-test', 'check.mjs') }, actor(workspace, 'cat-build'), () => undefined),
    /Build team must not write/,
  )
})

/** Poll a condition for a short while; used instead of reaching into Cordis internals. */
async function waitFor(condition, timeoutMs = 1500) {
  const started = Date.now()
  for (;;) {
    if (await condition()) return
    if (Date.now() - started > timeoutMs) throw new Error('condition was not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('the host row materializes independent team conversations', { skip }, async () => {
  const workspace = workspaceFixture()
  const stateFile = join(workspace, 'state.json')
  const { Context } = await import(pathToFileURL(cordisFile).href)
  const hostModule = await import('../index.js')

  /** Fake Session surface used by the bridge. */
  const sessions = new Map()
  const makeSession = (id, meta) => {
    const session = {
      id,
      header: { id, createdAt: Date.now(), cwd: meta.cwd, agentPreset: meta.agentPreset, parentSession: meta.parentSession, origin: meta.origin },
      log: [],
      append(type, data) {
        this.log.push({ type, data })
        return { type, data }
      },
    }
    sessions.set(id, session)
    return session
  }
  const container = makeSession('session-container', { cwd: workspace, agentPreset: 'cat-root' })
  const agents = new Map()
  const ctx = new Context()
  ctx.provide('tools', { guard: () => () => {}, register: () => () => {} })
  ctx.provide('webServer', { register: () => () => {} })
  ctx.provide('agentPresets', { mount: async () => ({}) })
  ctx.provide('agents', {
    get: (id) => agents.get(id),
    async create(options) {
      const session = makeSession(options.sessionId, options.meta)
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
      return { agent }
    },
  })
  ctx.provide('sessions', {
    get: (id) => sessions.get(id),
    async flush() {
      return true
    },
  })
  ctx.provide('subagents', { prompt: async () => ({ messageId: 'message-1' }) })
  ctx.provide('sessionTitle', { get: () => undefined, rename: () => ({ title: 'cat-loop 三队' }) })

  ctx.plugin(
    { name: hostModule.name, inject: hostModule.inject, apply: hostModule.apply },
    { promptDir: '.cat-prompt', testDir: '.cat-test', stateFile, structure: 'nested' },
  )
  await waitFor(() => ctx.get('catLoop') !== undefined)
  const service = ctx.get('catLoop')

  const snapshot = await service.prepare(container.id)
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.kind, 'inline')
  assert.deepEqual(
    snapshot.teams.map((team) => team.role),
    ['plan', 'build', 'review'],
  )
  for (const team of snapshot.teams) {
    // Independent root conversations in the user's own workspace.
    assert.equal(team.parentSessionId, null)
    const session = sessions.get(team.sessionId)
    assert.equal(session.header.parentSession, undefined)
    assert.equal(session.header.origin, undefined)
    assert.equal(session.header.cwd, workspace)
  }
  assert.equal(container.log.filter((event) => event.type === 'subagent/catalog').length, 0)
  assert.equal(container.log.filter((event) => event.type === 'turn/start').length, 1)
})
