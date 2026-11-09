/**
 * @marvinlee2011/dsh-cat-loop — Host half of the cat-loop plugin.
 *
 * The bundle composes one conversation preset (`cat-root`) plus the three team
 * presets (Plan, Build, Review). A cat-root conversation is the container: its
 * three child conversations are the teams, and this row owns everything the
 * durable nesting needs:
 *
 * - materializing child sessions with the subagent facts the UI and a cold
 *   resume read (`lib/bridge.js` → `ctx.catLoop.prepare`),
 * - keeping the container Agent live so those children stay editable and every
 *   hand-off can be authorized through it,
 * - the permission guard that keeps each team inside its filesystem and shell
 *   boundary (`lib/guard.js`),
 * - the two loopback snapshot routes the Client half reads (`lib/http.js`).
 *
 * Everything else is composition: see `cordis.patch.yml`.
 *
 * @module @marvinlee2011/dsh-cat-loop
 */

import { createCatLoop } from './lib/bridge.js'
import { installGuard } from './lib/guard.js'
import { installTeamsRoute } from './lib/http.js'
import { DEFAULT_PRESETS, DEFAULT_PROMPT_DIR, DEFAULT_TEST_DIR, PRESET_ROLES } from './lib/policy.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = '@marvinlee2011/dsh-cat-loop'

/**
 * Host services the row needs. `agentPresets` keeps the row inactive in a
 * profile that has no preset registry, where the conversations could not be
 * composed at all; `sessions` and `subagents` are what materializes the nested
 * children and authorizes their message hand-off.
 */
export const inject = ['tools', 'agents', 'agentPresets', 'webServer', 'sessions', 'subagents', 'sessionTitle']

/**
 * Mount the guard and publish the bridge service.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {unknown} config - raw Loader row configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  installGuard(ctx, settings)
  const service = createCatLoop(ctx, settings)
  ctx.provide('catLoop', service)
  installTeamsRoute(ctx, service)
  installRosterVisibility(ctx, settings.visiblePresets, settings.hiddenPresets)
  // Folder team Sessions live in their folder workspace; point the live Agent at
  // the real project directory so file tools, guards and messages agree on one root.
  ctx.on('agent/created', async ({ agent }) => {
    const project = service.projectRootOf?.(agent)
    if (typeof project !== 'string' || project === '' || project === agent.session.header.cwd) return
    try {
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory !== undefined) await workingDirectory.set(agent, project)
    } catch (error) {
      ctx.logger?.warn?.(`cat-loop: could not point ${agent.session.id} at ${project}: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

/**
 * Keep the session preset picker to the cat-loop container.
 *
 * The three team presets must stay registered — they are the compositions the
 * child conversations mount — but they are not choices a user should pick for a
 * new conversation. The picker renders the host roster (`agentPresets.list`),
 * so this wraps that one read-only remote and filters the exported rows. The
 * wrapper is restored with the activating fiber; the registry itself is
 * untouched, so `mount`, `resolve`, `select` and the admin document read all
 * keep seeing every preset.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {string[] | undefined} visiblePresets - strict allow-list, when configured.
 * @param {string[]} hiddenPresets - preset ids the picker must never offer.
 * @returns {void}
 */
function installRosterVisibility(ctx, visiblePresets, hiddenPresets) {
  const allowed = visiblePresets === undefined ? undefined : new Set(visiblePresets)
  const hidden = new Set(hiddenPresets)
  ctx.inject(['agentPresets'], (scoped) => {
    const registry = scoped.get('agentPresets')
    if (registry === undefined) return
    const original = registry.remoteExportList
    if (typeof original !== 'function') return
    const filtered = async function filteredRoster(...args) {
      const result = await original.apply(this, args)
      if (result === null || typeof result !== 'object' || !Array.isArray(result.presets)) return result
      return {
        ...result,
        presets: result.presets.filter((preset) => {
          if (preset === null || typeof preset !== 'object') return false
          if (allowed !== undefined) return allowed.has(preset.id)
          return !hidden.has(preset.id)
        }),
      }
    }
    registry.remoteExportList = filtered
    scoped.effect(
      () => () => {
        if (registry.remoteExportList === filtered) registry.remoteExportList = original
      },
      'cat-loop: preset roster visibility',
    )
  })
}

/**
 * Validate the row configuration and apply defaults. Validation fails loud at
 * activation: a boundary directory that resolves outside the workspace would
 * silently widen every team's permissions.
 * @param {unknown} config - raw Loader row configuration.
 * @returns {{ promptDir: string, testDir: string, presets: Record<string, string>, structure: 'folder' | 'nested', hiddenPresets: string[], visiblePresets?: string[], stateFile?: string }}
 */
export function normalizeConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const promptDir = directoryName(source.promptDir, DEFAULT_PROMPT_DIR, 'promptDir')
  const testDir = directoryName(source.testDir, DEFAULT_TEST_DIR, 'testDir')
  if (promptDir === testDir) {
    throw new Error(`cat-loop: promptDir and testDir must differ (both are ${JSON.stringify(promptDir)})`)
  }

  const presets = { ...DEFAULT_PRESETS }
  if (source.presets !== undefined) {
    if (source.presets === null || typeof source.presets !== 'object') {
      throw new Error('cat-loop: config.presets must be a mapping of role to preset id')
    }
    for (const role of PRESET_ROLES) {
      const value = source.presets[role]
      if (value === undefined) continue
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`cat-loop: config.presets.${role} must be a non-empty preset id`)
      }
      presets[role] = value.trim()
    }
  }
  const ids = new Set(PRESET_ROLES.map((role) => presets[role]))
  if (ids.size !== PRESET_ROLES.length) {
    throw new Error(`cat-loop: every role needs a distinct preset id (received ${JSON.stringify(presets)})`)
  }

  const stateFile =
    typeof source.stateFile === 'string' && source.stateFile.trim() !== '' ? source.stateFile.trim() : undefined

  // The picker offers one cat-loop entry: the Plan conversation itself. The
  // container shell (root) and the two peer teams are never started directly.
  const hiddenPresets = presetIdList(
    source.hiddenPresets,
    [presets.root, presets.build, presets.review],
    'hiddenPresets',
  )
  const visiblePresets =
    source.visiblePresets === undefined ? undefined : presetIdList(source.visiblePresets, undefined, 'visiblePresets')
  const structure = source.structure === undefined ? 'nested' : source.structure
  if (structure !== 'folder' && structure !== 'nested') {
    throw new Error('cat-loop: config.structure must be "folder" or "nested"')
  }

  return {
    promptDir,
    testDir,
    presets,
    structure,
    hiddenPresets,
    ...(visiblePresets === undefined ? {} : { visiblePresets }),
    ...(stateFile === undefined ? {} : { stateFile }),
  }
}

/**
 * Validate one preset-id list config field.
 * @param {unknown} value - raw config field.
 * @param {string[] | undefined} fallback - default ids when the field is absent.
 * @param {string} field - config field name for messages.
 * @returns {string[]} unique non-empty preset ids.
 */
function presetIdList(value, fallback, field) {
  if (value === undefined) return fallback === undefined ? [] : [...fallback]
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.trim() === '')) {
    throw new Error(`cat-loop: config.${field} must be an array of non-empty preset ids`)
  }
  return [...new Set(value.map((id) => id.trim()))]
}

/** Validate one workspace-relative directory name. */
function directoryName(value, fallback, field) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`cat-loop: config.${field} must be a non-empty directory name`)
  }
  const name = value.trim()
  if (name.startsWith('/') || name.includes('..') || name.includes('\\')) {
    throw new Error(`cat-loop: config.${field} must be a workspace-relative directory name (received ${JSON.stringify(name)})`)
  }
  return name
}
