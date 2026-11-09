/**
 * cat-loop permission guard — the enforcement half of `policy.js`.
 *
 * Two layers, because the Harness exposes two different seams:
 *
 * 1. `fs/write-intent` and `fs/edit-intent` (waterfall, single-slot) are the
 *    decision points every `ctx.fs` mutation passes through, so the file-tool
 *    boundary is enforced on the resolved target rather than on a model-supplied
 *    path string. The listener is registered with `prepend: true` so it runs
 *    before the shipped observation policy, then delegates with `next()` to keep
 *    that policy's stale-version and read-before-write behavior intact.
 * 2. `ctx.tools.guard()` is a monotonic tool guard: it only ever denies, is
 *    synchronous, and cannot be re-allowed by listener ordering. It carries the
 *    shell command policy (the Plan team has no shell; Build may not name
 *    `.cat-test`; Review may only name `.cat-test` paths) and pre-screens
 *    `write`/`edit` arguments so the model gets a precise message.
 *
 * Both layers resolve the role from the calling session's durable preset id, so
 * a teammate created inside a team inherits its lead's boundary.
 *
 * @module cat-loop/guard
 */

import { resolve } from 'node:path'

import {
  decideShell,
  decideWrite,
  isShellTool,
  permissionError,
  roleForPreset,
  rootsFor,
} from './policy.js'

/** Tools whose `path` argument writes a file. */
const WRITE_TOOLS = new Set(['write', 'edit'])

/**
 * Install the two enforcement layers.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {{ promptDir: string, testDir: string, presets: Record<string, string> }} settings - normalized row config.
 * @returns {void}
 */
export function installGuard(ctx, settings) {
  const dirs = { promptDir: settings.promptDir, testDir: settings.testDir }

  /** Effective directory used to resolve model-supplied relative paths. */
  const workingDirectoryOf = (session) => {
    const service = ctx.get('workingDirectory')
    try {
      if (service !== undefined && session !== undefined) return service.get(session)
    } catch {
      // A detached session may no longer resolve; fall back to the project root.
    }
    return workspaceOf(ctx, session)
  }

  /**
   * Project directory a session's boundaries are anchored to. Folder team
   * Sessions have their Session cwd inside the conversation folder, so the
   * bridge answers with the real project; everything else uses the header cwd.
   */
  const workspaceOf = (session) => {
    const bridge = ctx.get('catLoop')
    if (bridge !== undefined && typeof bridge.projectRootOf === 'function') {
      const project = bridge.projectRootOf(session)
      if (typeof project === 'string' && project !== '') return project
    }
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') return cwd
    const service = ctx.get('workingDirectory')
    const fallback = service?.defaultDirectory
    return typeof fallback === 'string' && fallback !== '' ? fallback : process.cwd()
  }

  /** Role of the session behind one actor, or undefined outside cat-loop. */
  const roleOfSession = (session) => roleForPreset(session?.header?.agentPreset, settings.presets)

  /**
   * Reject one resolved write/edit target.
   * @param {string} toolName - `write` or `edit`, for the message.
   * @param {unknown} target - the `FsTarget` the tool is about to mutate.
   * @param {unknown} actor - opaque tool-execution context.
   */
  const checkIntent = (toolName, target, actor) => {
    const session = actor?.agent?.session
    const role = roleOfSession(session)
    if (role === undefined) return
    let absolute
    try {
      absolute = ctx.fs.processPath(target)
    } catch {
      // A target this provider cannot map is not a cat-loop file; leave it to
      // the shipped policy rather than inventing a path.
      return
    }
    const decision = decideWrite(role, absolute, rootsFor(workspaceOf(session), dirs))
    if (!decision.allowed) throw permissionError(`${decision.reason} (${toolName})`)
  }

  ctx.effect(
    () =>
      ctx.on(
        'fs/write-intent',
        (target, actor, next) => {
          checkIntent('write', target, actor)
          return next()
        },
        { prepend: true },
      ),
    'cat-loop.write-intent()',
  )

  ctx.effect(
    () =>
      ctx.on(
        'fs/edit-intent',
        (target, actor, next) => {
          checkIntent('edit', target, actor)
          return next()
        },
        { prepend: true },
      ),
    'cat-loop.edit-intent()',
  )

  ctx.effect(
    () =>
      ctx.tools.guard((exec) => {
        const session = exec.agent?.session
        const role = roleOfSession(session)
        if (role === undefined) return undefined

        const args = exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments : {}
        const roots = rootsFor(workspaceOf(session), dirs)

        if (isShellTool(exec.name)) {
          if (role === 'review' && args.sandbox_permissions !== undefined) {
            return (
              '[cat-loop] the Review team must not widen its sandbox: review commands run with the standing policy. ' +
              'Write check code under .cat-test/ and run it without sandbox_permissions.'
            )
          }
          const command = typeof args.command === 'string' ? args.command : ''
          const decision = decideShell(role, command, roots)
          return decision.allowed ? undefined : decision.reason
        }

        if (WRITE_TOOLS.has(exec.name) && typeof args.path === 'string') {
          const absolute = resolve(workingDirectoryOf(session), args.path)
          const decision = decideWrite(role, absolute, roots)
          return decision.allowed ? undefined : decision.reason
        }

        return undefined
      }),
    'cat-loop.tool-guard()',
  )
}
