/**
 * cat-loop composition — the three teams' tool surfaces, checked against the
 * real bundle patch.
 *
 * The permission boundary has two halves: the runtime guard (policy/guard tests)
 * and what each preset actually mounts. This file locks the second half, so a
 * patch edit that gives Plan a shell or drops the Review team's tools fails in
 * CI instead of in a session.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const lines = patch.split('\n')

/** Lines of one top-level inserted row (4-space `- id:`), up to the next sibling. */
function row(id) {
  const start = lines.findIndex((line) => line === '    - id: ' + id)
  assert.notEqual(start, -1, 'row ' + id + ' is missing from cordis.patch.yml')
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^    - id: /.test(lines[index]) || /^- /.test(lines[index])) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

const root = row('preset-cat-root')
const plan = row('preset-cat-plan')
const build = row('preset-cat-build')
const review = row('preset-cat-review')

function configValue(body, key) {
  const match = new RegExp('^        ' + key + ': (.+)$', 'm').exec(body)
  assert.ok(match, 'config.' + key + ' is missing')
  return match[1].trim()
}

function roleOf(body) {
  const match = /^              role: (\w+)$/m.exec(body)
  assert.ok(match, 'the preset must mount cat-loop/role with a role')
  return match[1]
}

test('one container preset and three distinct team presets are declared', () => {
  const ids = [configValue(root, 'id'), configValue(plan, 'id'), configValue(build, 'id'), configValue(review, 'id')]
  assert.deepEqual(ids, ['cat-root', 'cat-plan', 'cat-build', 'cat-review'])
  assert.equal(new Set(ids).size, 4)

  const orders = [root, plan, build, review].map((body) => Number(configValue(body, 'order')))
  assert.equal(new Set(orders).size, 4)
  assert.ok(orders[0] < orders[1] && orders[1] < orders[2] && orders[2] < orders[3], 'the container leads the roster')

  for (const body of [root, plan, build, review]) {
    assert.equal((body.match(/name: '@deepseek-ai\/dsh-persona'/g) ?? []).length, 1, 'each conversation has a persona')
  }
  for (const body of [plan, build, review]) {
    assert.equal((body.match(/name: '@marvinlee2011\/dsh-cat-loop\/role'/g) ?? []).length, 1, 'exactly one cat-role row per team preset')
  }
  assert.deepEqual([roleOf(plan), roleOf(build), roleOf(review)], ['plan', 'build', 'review'])
})

test('the container preset is a work-free shell', () => {
  assert.ok(!root.includes('@deepseek-ai/dsh-tool-bash'), 'the container must not mount a shell')
  assert.ok(!root.includes('@deepseek-ai/dsh-tool-fs'), 'the container must not mount file tools')
  assert.ok(!root.includes("name: 'cat-loop/role'"), 'the container has no team tools')
  assert.match(root, /container of a cat-loop conversation/, 'the persona explains the container role')
})

test('the Plan team is mounted without any shell tool', () => {
  assert.ok(!plan.includes('@deepseek-ai/dsh-tool-bash'), 'Plan must not mount bash')
  assert.ok(!plan.includes('@deepseek-ai/dsh-tool-pwsh'), 'Plan must not mount pwsh')
  assert.ok(plan.includes('@deepseek-ai/dsh-tool-fs'), 'Plan still reads and writes briefs')
  assert.ok(plan.includes('@deepseek-ai/dsh-tool-fs-search'), 'Plan reads the workspace')
  assert.match(plan, /\.cat-prompt/, 'the Plan persona names its writable directory')
})

test('Build and Review mount a shell; Review names only .cat-test', () => {
  for (const body of [build, review]) {
    assert.ok(body.includes('@deepseek-ai/dsh-tool-bash'), 'the team may run commands')
    assert.ok(body.includes('@deepseek-ai/dsh-tool-fs'), 'the team edits files')
    assert.match(body, /\.cat-test/, 'the persona names the Review directory')
  }
  assert.match(build, /except `\.cat-test\/`/, 'the Build persona states its write exclusion')
  assert.match(review, /write only under `\.cat-test\/`/, 'the Review persona states its write boundary')
  assert.match(review, /shell may only name paths under `\.cat-test\/`/, 'the Review persona states its command boundary')
})

test('every cat-loop conversation can read and complete a goal', () => {
  // A cat-loop conversation is the profile default now, so the shipped goal
  // tools must exist in every preset the plugin mounts; without them a goal
  // created in one of these conversations could not be marked complete.
  for (const body of [root, plan, build, review]) {
    assert.ok(body.includes("'@deepseek-ai/dsh-tool-goal'"), 'the preset mounts the goal tool')
    assert.ok(body.includes("'@deepseek-ai/dsh-command-goal'"), 'the preset mounts the goal command')
  }
})

test('New Sessions keep the shipped default preset; cat-loop is opt-in', () => {
  // The registry default stays `standard`, so a New Session is an ordinary
  // conversation unless the user explicitly picks the cat-loop preset.
  assert.doesNotMatch(patch, /^    default: cat-root$/m)
  assert.doesNotMatch(patch, /\n- id: agent-preset-registry\n  name: '@deepseek-ai\/dsh-agent-preset-registry'\n/)
  assert.match(row('cat-loop'), /root: cat-root/)
})

test('the bundle mounts the Agent Teams runtime and its own host row', () => {
  for (const id of ['agent-team', 'tool-agent-team', 'ui-agent-team', 'cat-loop']) {
    const body = row(id)
    assert.ok(body.length > 0, 'row ' + id + ' is inserted')
  }
  assert.match(row('agent-team'), /@deepseek-ai\/dsh-experimental-agent-team/)
  assert.match(row('tool-agent-team'), /@deepseek-ai\/dsh-experimental-tool-agent-team/)
  assert.match(row('ui-agent-team'), /@deepseek-ai\/dsh-experimental-client-ui-agent-team/)
  assert.match(row('cat-loop'), /promptDir: \.cat-prompt/)
  assert.match(row('cat-loop'), /testDir: \.cat-test/)
})

test('the base continuable-subagent tools are disabled, as the Teams profile does', () => {
  for (const id of ['tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork']) {
    const override = new RegExp('^- id: ' + id + '\\n  disabled: true$', 'm')
    assert.match(patch, override, id + ' must be disabled to keep delegation on the Team tools')
  }
})

test('the bundle ships a Web client half with its display resources', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.immediately, true)
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar-right'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-subagent'))
  assert.ok(manifest.files.includes('client.js'))
  assert.ok(existsSync(new URL('../client.js', import.meta.url)), 'client.js must exist')
  assert.ok(existsSync(new URL('../lib/http.js', import.meta.url)), 'the snapshot route must exist')
})
