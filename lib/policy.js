/**
 * cat-loop permission policy — the pure decision functions behind the three
 * team boundaries.
 *
 * This module deliberately imports nothing from the Harness: a profile-installed
 * bundle resolves its own dependencies, while Harness packages are only
 * resolvable through the Loader's row table. Keeping the policy pure also makes
 * the boundary matrix directly testable with `node --test`.
 *
 * Roles and their boundaries (workspace-relative):
 *
 * | role   | file writes            | shell                                    |
 * |--------|------------------------|------------------------------------------|
 * | plan   | only `.cat-prompt/`    | none (no shell tool is mounted)          |
 * | build  | anything except        | a command may not name `.cat-test`       |
 * |        | `.cat-test/`           |                                          |
 * | review | only `.cat-test/`      | a command may only name `.cat-test`      |
 * |        |                        | paths (read the rest with the file tools)|
 *
 * Reads are not restricted for any role.
 *
 * @module cat-loop/policy
 */

import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Default directory the Plan team writes task briefs into. */
export const DEFAULT_PROMPT_DIR = '.cat-prompt'

/** Default directory the Review team owns and writes check code into. */
export const DEFAULT_TEST_DIR = '.cat-test'

/** Role order used by roster output. */
export const ROLE_ORDER = Object.freeze(['plan', 'build', 'review'])

/** The container role: one ordinary conversation that owns the three teams. */
export const ROOT_ROLE = 'root'

/** Preset id supplying each role; overridable through the host row's config. */
export const DEFAULT_PRESETS = Object.freeze({
  root: 'cat-root',
  plan: 'cat-plan',
  build: 'cat-build',
  review: 'cat-review',
})

/** Every preset-backed role, container first. */
export const PRESET_ROLES = Object.freeze([ROOT_ROLE, ...ROLE_ORDER])

/** Human-facing role titles. */
export const ROLE_TITLES = Object.freeze({ plan: 'Plan', build: 'Build', review: 'Review' })

/**
 * Tools that run an arbitrary command line. The Plan preset mounts none of
 * them; the guard still denies them so a future composition change cannot
 * silently widen the Plan boundary.
 */
export const SHELL_TOOLS = Object.freeze([
  'bash',
  'pwsh',
  'bash_persistent',
  'pwsh_persistent',
  'terminal',
  'terminal_create',
  'run_code',
])

const SHELL_TOOL_SET = new Set(SHELL_TOOLS)

/** Whether a tool name executes an arbitrary command line. */
export function isShellTool(name) {
  return SHELL_TOOL_SET.has(name)
}

/**
 * Whether path comparison must ignore case for this host. macOS APFS and
 * Windows NTFS are case-insensitive by default, so a case-only difference must
 * not be reported as an escape.
 */
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

function comparable(value) {
  return CASE_INSENSITIVE ? value.toLowerCase() : value
}

/**
 * Canonicalize a path for containment checks. Existing ancestors are resolved
 * through symlinks (the filesystem provider reports real paths, and macOS
 * aliases `/tmp` to `/private/tmp`); a not-yet-existing tail is appended as
 * written, so a create into a missing directory is classified correctly.
 * @param {string} path - path to canonicalize.
 * @returns {string} absolute canonical path.
 */
export function canonicalPath(path) {
  let current = resolve(path)
  const tail = []
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return tail.length === 0 ? real : join(real, ...tail.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      tail.push(basename(current))
      current = parent
    }
  }
}

/**
 * Whether `candidate` is `root` or a descendant of it, after canonicalization.
 * @param {string} root - directory that bounds the check.
 * @param {string} candidate - path to classify.
 * @returns {boolean} true when contained.
 */
export function contains(root, candidate) {
  const left = comparable(canonicalPath(root))
  const right = comparable(canonicalPath(candidate))
  if (left === right) return true
  return right.startsWith(left.endsWith(sep) ? left : left + sep)
}

/**
 * Build the role roots for one workspace.
 * @param {string} workspace - absolute workspace directory (a session cwd).
 * @param {{ promptDir?: string, testDir?: string }} [dirs] - configured directory names.
 * @returns {{ workspace: string, promptRoot: string, testRoot: string, promptDir: string, testDir: string }}
 */
export function rootsFor(workspace, dirs = {}) {
  const promptDir = dirs.promptDir ?? DEFAULT_PROMPT_DIR
  const testDir = dirs.testDir ?? DEFAULT_TEST_DIR
  return Object.freeze({
    workspace,
    promptRoot: join(workspace, promptDir),
    testRoot: join(workspace, testDir),
    promptDir,
    testDir,
  })
}

/**
 * Resolve a session's preset id to its cat-loop role.
 * @param {string | undefined} presetId - durable `agentPreset` of the session.
 * @param {Record<string, string>} [presets] - role to preset-id map.
 * @returns {'plan' | 'build' | 'review' | undefined}
 */
export function roleForPreset(presetId, presets = DEFAULT_PRESETS) {
  if (typeof presetId !== 'string' || presetId === '') return undefined
  for (const role of ROLE_ORDER) {
    if (presets[role] === presetId) return role
  }
  return undefined
}

/**
 * Decide one file mutation against a role boundary.
 * @param {'plan' | 'build' | 'review' | string} role - calling role.
 * @param {string} targetPath - canonical or raw destination path.
 * @param {ReturnType<typeof rootsFor>} roots - role roots for the workspace.
 * @returns {{ allowed: true } | { allowed: false, reason: string }}
 */
export function decideWrite(role, targetPath, roots) {
  const target = canonicalPath(targetPath)
  if (role === 'plan') {
    if (contains(roots.promptRoot, target)) return { allowed: true }
    return {
      allowed: false,
      reason:
        `[cat-loop] the Plan team may only write under ${roots.promptRoot}; ${target} is outside it. ` +
        `Write task briefs into ${roots.promptDir}/ instead — the rest of the workspace is read-only for this team.`,
    }
  }
  if (role === 'build') {
    if (!contains(roots.testRoot, target)) return { allowed: true }
    return {
      allowed: false,
      reason:
        `[cat-loop] the Build team must not write under ${roots.testRoot}; ${target} belongs to the Review team. ` +
        'Change the implementation files instead and hand the review over with cat_send.',
    }
  }
  if (role === 'review') {
    if (contains(roots.testRoot, target)) return { allowed: true }
    return {
      allowed: false,
      reason:
        `[cat-loop] the Review team may only write under ${roots.testRoot}; ${target} is outside it. ` +
        `Keep check code and reports under ${roots.testDir}/ and read the implementation with the read tools.`,
    }
  }
  return { allowed: false, reason: `[cat-loop] unknown role ${JSON.stringify(role)}; refusing the write.` }
}

/**
 * Split a command line into candidate tokens. Quoting is dropped so a quoted
 * path is still inspected; the split is deliberately permissive because the
 * guard is a policy fence over a model-controlled string, not a shell parser.
 * @param {string} command - raw command line.
 * @returns {string[]} tokens.
 */
export function commandTokens(command) {
  return command.split(/[\s;&|<>()`"']+/u).filter((token) => token !== '')
}

/** Whether a token looks like a filesystem path rather than a flag or a word. */
function looksLikePath(token) {
  if (token.startsWith('-')) return false
  if (token.includes('/') || token.includes('\\')) return true
  if (token.startsWith('.')) return true
  return /\.[A-Za-z0-9_]+$/u.test(token)
}

/**
 * Decide one shell command against a role boundary. Plan cannot run a command
 * at all, Build may not name the Review directory, and Review may only name
 * paths inside it.
 * @param {'plan' | 'build' | 'review' | string} role - calling role.
 * @param {string} command - raw command line.
 * @param {ReturnType<typeof rootsFor>} roots - role roots for the workspace.
 * @returns {{ allowed: true } | { allowed: false, reason: string }}
 */
export function decideShell(role, command, roots) {
  const text = typeof command === 'string' ? command : ''
  if (role === 'plan') {
    return {
      allowed: false,
      reason:
        '[cat-loop] the Plan team cannot execute commands; only the Build and Review teams have a shell. ' +
        'Write the task brief under .cat-prompt/ and dispatch it with cat_send.',
    }
  }
  if (role === 'build') {
    const needle = comparable(roots.testDir)
    const haystack = comparable(text)
    if (haystack.includes(needle) || haystack.includes(comparable(roots.testRoot))) {
      return {
        allowed: false,
        reason:
          `[cat-loop] the Build team must not touch ${roots.testDir}/ through the shell. ` +
          'Use the read tool if you need to look at a review artifact, and hand changes over with cat_send.',
      }
    }
    return { allowed: true }
  }
  if (role === 'review') {
    for (const token of commandTokens(text)) {
      if (!looksLikePath(token)) continue
      const absolute = isAbsolute(token) ? token : resolve(roots.workspace, token)
      if (contains(roots.testRoot, absolute)) continue
      if (!contains(roots.workspace, absolute)) continue
      return {
        allowed: false,
        reason:
          `[cat-loop] the Review team's shell may only name paths under ${roots.testRoot}; ${token} resolves outside it. ` +
          'Read implementation files with the read tools, and run check scripts as e.g. `bash .cat-test/run.sh`.',
      }
    }
    return { allowed: true }
  }
  return { allowed: false, reason: `[cat-loop] unknown role ${JSON.stringify(role)}; refusing the command.` }
}

/**
 * Format a containment denial error the tool layer can surface verbatim.
 * @param {string} reason - already formatted reason.
 * @returns {Error} tagged error.
 */
export function permissionError(reason) {
  const error = new Error(reason)
  error.name = 'CatLoopPermissionError'
  error.code = 'CAT_LOOP_PERMISSION_DENIED'
  return error
}

export { relative as relativePath }
