/**
 * cat-loop permission matrix — the boundary contract the plugin promises.
 *
 * These tests exercise the pure policy and the real guard registration path
 * (with a minimal Cordis-shaped context), so a regression in the enforcement
 * seam fails here rather than in a live session.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { installGuard } from '../lib/guard.js'
import {
  DEFAULT_PRESETS,
  decideShell,
  decideWrite,
  roleForPreset,
  rootsFor,
} from '../lib/policy.js'

/** A throwaway workspace with the two boundary directories present. */
function workspaceFixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'cat-loop-policy-'))
  mkdirSync(join(workspace, '.cat-prompt'))
  mkdirSync(join(workspace, '.cat-test'))
  writeFileSync(join(workspace, 'src.js'), 'export const answer = 42\n')
  writeFileSync(join(workspace, '.cat-test', 'check.mjs'), '// check\n')
  return workspace
}

/** A minimal Cordis-shaped host context recording what the guard registers. */
function fakeHost(workspace) {
  /** @type {Map<string, Array<{ listener: Function, options: unknown }>>} */
  const listeners = new Map()
  /** @type {Function[]} */
  const guards = []
  const workingDirectory = { defaultDirectory: workspace, get: () => workspace }
  const ctx = {
    fs: { processPath: (target) => target.path },
    tools: { guard: (guard) => (guards.push(guard), () => {}) },
    on: (name, listener, options) => {
      const entries = listeners.get(name) ?? []
      entries.push({ listener, options })
      listeners.set(name, entries)
      return () => {}
    },
    effect: (register) => (register(), () => {}),
    get: (name) => (name === 'workingDirectory' ? workingDirectory : undefined),
  }
  return { ctx, listeners, guards }
}

/** One live session shaped like the Harness session the guard reads. */
function session(workspace, preset) {
  return { id: `session-${preset}`, header: { cwd: workspace, agentPreset: preset } }
}

/** Run one registered fs intent listener. */
async function runIntent(listeners, event, path, actor) {
  const [entry] = listeners.get(event) ?? []
  assert.ok(entry, `${event} must be registered`)
  let delegated = false
  const result = await entry.listener({ path }, actor, () => {
    delegated = true
    return undefined
  })
  return { result, delegated }
}

test('roleForPreset maps only the configured presets', () => {
  assert.equal(roleForPreset('cat-plan'), 'plan')
  assert.equal(roleForPreset('cat-build'), 'build')
  assert.equal(roleForPreset('cat-review'), 'review')
  assert.equal(roleForPreset('standard'), undefined)
  assert.equal(roleForPreset(undefined), undefined)
  assert.equal(roleForPreset('cat-plan', { ...DEFAULT_PRESETS, plan: 'cat-plan-2' }), undefined)
})

test('file writes follow the three-team boundary', () => {
  const workspace = workspaceFixture()
  const roots = rootsFor(workspace)

  assert.deepEqual(decideWrite('plan', join(workspace, '.cat-prompt', '01-task.md'), roots), { allowed: true })
  assert.equal(decideWrite('plan', join(workspace, 'src.js'), roots).allowed, false)
  assert.equal(decideWrite('plan', join(workspace, '.cat-test', 'check.mjs'), roots).allowed, false)

  assert.deepEqual(decideWrite('build', join(workspace, 'src.js'), roots), { allowed: true })
  assert.deepEqual(decideWrite('build', join(workspace, '.cat-prompt', '01-task.md'), roots), { allowed: true })
  assert.equal(decideWrite('build', join(workspace, '.cat-test', 'check.mjs'), roots).allowed, false)
  assert.equal(decideWrite('build', join(workspace, '.cat-test'), roots).allowed, false)

  assert.deepEqual(decideWrite('review', join(workspace, '.cat-test', 'check.mjs'), roots), { allowed: true })
  assert.equal(decideWrite('review', join(workspace, 'src.js'), roots).allowed, false)
  assert.equal(decideWrite('review', join(workspace, '.cat-prompt', '01-task.md'), roots).allowed, false)

  // A sibling directory whose name merely starts with the boundary name is outside it.
  assert.equal(decideWrite('review', join(workspace, '.cat-testing', 'x'), roots).allowed, false)
  assert.equal(decideWrite('build', join(workspace, '.cat-testing', 'x'), roots).allowed, true)
})

test('a relative escape cannot leave the boundary', () => {
  const workspace = workspaceFixture()
  const roots = rootsFor(workspace)
  // `..` segments and neighbouring prefixes are resolved before the check.
  assert.equal(decideWrite('review', join(workspace, '.cat-test', '..', 'src.js'), roots).allowed, false)
  assert.equal(decideWrite('plan', join(workspace, '.cat-prompt', '..', '.cat-test', 'x'), roots).allowed, false)
})

test('shell commands follow the three-team boundary', () => {
  const workspace = workspaceFixture()
  const roots = rootsFor(workspace)

  assert.equal(decideShell('plan', 'npm test', roots).allowed, false)
  assert.equal(decideShell('build', 'npm test', roots).allowed, true)
  assert.equal(decideShell('build', 'node .cat-test/check.mjs', roots).allowed, false)
  assert.equal(decideShell('build', 'rm -rf .cat-test', roots).allowed, false)
  assert.equal(decideShell('review', 'bash .cat-test/run-checks.sh', roots).allowed, true)
  assert.equal(decideShell('review', 'node .cat-test/check.mjs --reporter=spec', roots).allowed, true)
  assert.equal(decideShell('review', 'cat src.js', roots).allowed, false)
  assert.equal(decideShell('review', 'cd .cat-test && ls', roots).allowed, true)
  // Paths outside the workspace are not the Review team's business.
  assert.equal(decideShell('review', 'node --version', roots).allowed, true)
  assert.equal(decideShell('review', '/usr/bin/node -e "1"', roots).allowed, true)
})

test('the guard refuses cross-boundary fs intents and delegates the rest', async () => {
  const workspace = workspaceFixture()
  const { ctx, listeners, guards } = fakeHost(workspace)
  installGuard(ctx, { promptDir: '.cat-prompt', testDir: '.cat-test', presets: DEFAULT_PRESETS })

  assert.equal(listeners.get('fs/write-intent')?.[0]?.options?.prepend, true)
  assert.equal(listeners.get('fs/edit-intent')?.[0]?.options?.prepend, true)

  const planActor = { agent: { session: session(workspace, 'cat-plan') } }
  const denied = await runIntent(listeners, 'fs/write-intent', join(workspace, 'src.js'), planActor).catch((error) => error)
  assert.equal(denied.code, 'CAT_LOOP_PERMISSION_DENIED')

  const allowed = await runIntent(listeners, 'fs/write-intent', join(workspace, '.cat-prompt', '01.md'), planActor)
  assert.equal(allowed.delegated, true)

  const buildActor = { agent: { session: session(workspace, 'cat-build') } }
  const buildDenied = await runIntent(listeners, 'fs/edit-intent', join(workspace, '.cat-test', 'check.mjs'), buildActor).catch(
    (error) => error,
  )
  assert.equal(buildDenied.code, 'CAT_LOOP_PERMISSION_DENIED')

  const reviewActor = { agent: { session: session(workspace, 'cat-review') } }
  const reviewAllowed = await runIntent(listeners, 'fs/edit-intent', join(workspace, '.cat-test', 'check.mjs'), reviewActor)
  assert.equal(reviewAllowed.delegated, true)

  // A session outside the cat-loop presets is untouched.
  const other = await runIntent(listeners, 'fs/write-intent', join(workspace, 'src.js'), {
    agent: { session: session(workspace, 'standard') },
  })
  assert.equal(other.delegated, true)

  assert.equal(guards.length, 1)
})

test('the tool guard denies shell and write calls by role', () => {
  const workspace = workspaceFixture()
  const { ctx, guards } = fakeHost(workspace)
  installGuard(ctx, { promptDir: '.cat-prompt', testDir: '.cat-test', presets: DEFAULT_PRESETS })
  const [guard] = guards

  const call = (preset, name, args) => guard({ name, arguments: args, agent: { session: session(workspace, preset) } })

  // Plan has no shell even if a future preset mounts one.
  assert.match(call('cat-plan', 'bash', { command: 'ls' }) ?? '', /Plan team cannot execute commands/)
  // Build may run, but may not name the Review directory.
  assert.equal(call('cat-build', 'bash', { command: 'npm test' }), undefined)
  assert.match(call('cat-build', 'bash', { command: 'cat .cat-test/out.txt' }) ?? '', /must not touch \.cat-test/)
  // Review runs only against .cat-test and cannot widen its sandbox.
  assert.equal(call('cat-review', 'bash', { command: 'bash .cat-test/run.sh' }), undefined)
  assert.match(call('cat-review', 'bash', { command: 'cat src.js' }) ?? '', /may only name paths under/)
  assert.match(
    call('cat-review', 'bash', { command: 'bash .cat-test/run.sh', sandbox_permissions: 'danger-full-access' }) ?? '',
    /must not widen its sandbox/,
  )

  // File tools are pre-screened with a precise message (the fs intent is the hard layer).
  assert.equal(call('cat-plan', 'write', { path: join(workspace, '.cat-prompt', 'x.md') }), undefined)
  assert.match(call('cat-plan', 'write', { path: join(workspace, 'src.js') }) ?? '', /Plan team may only write/)
  assert.match(call('cat-build', 'edit', { path: join(workspace, '.cat-test', 'x.mjs') }) ?? '', /Build team must not write/)
  assert.equal(call('cat-review', 'write', { path: join(workspace, '.cat-test', 'x.mjs') }), undefined)
  assert.match(call('cat-review', 'write', { path: join(workspace, 'src.js') }) ?? '', /Review team may only write/)

  // Unrelated tools and non-cat sessions pass through.
  assert.equal(call('cat-review', 'read', { path: join(workspace, 'src.js') }), undefined)
  assert.equal(call('standard', 'bash', { command: 'rm -rf .cat-test' }), undefined)
})
