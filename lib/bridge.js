/**
 * cat-loop bridge — nested team conversations and cross-team dispatch.
 *
 * A cat-loop conversation is one normal *container* session composed from the
 * `cat-root` preset. Under it live three **subagent child conversations** —
 * plan, build and review — each composed from its own team preset. The shipped
 * subagent UI renders exactly that shape: the container header lists its child
 * conversations, and every child header carries a sibling switcher, so a team
 * conversation is reachable like any other sub-conversation instead of showing
 * up as an unnamed sibling in the workspace list.
 *
 * The container stays live on purpose: a continuable child is only editable
 * while its durable parent Agent is live, and the container Agent is also the
 * authorizing parent every cross-team message passes through. This module owns
 * that Agent, the durable child catalog, and the message hand-off:
 *
 * - children are created as ordinary Sessions with the durable
 *   `agent-preset/selected` and `subagent/descriptor` facts the subagent
 *   manager needs for a cold resume, plus a `subagent/catalog` fact on the
 *   container so the UI lists them;
 * - a cross-team message is delivered through `ctx.subagents.prompt`, which
 *   cold-resumes the receiving child from persistence and preserves the
 *   continuable-conversation semantics;
 * - `$DSH_HOME/cat-loop/state.json` remembers which children belong to which
 *   container so a restarted Harness reconnects the same conversations.
 *
 * Conversations recorded by the previous release (three root sessions) are
 * kept working through a compatibility path; they cannot be re-parented.
 *
 * @module cat-loop/bridge
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'

import { DEFAULT_PRESETS, ROLE_ORDER, ROLE_TITLES, roleForPreset } from './policy.js'

/** Current durable state format. */
const STATE_VERSION = 2

/** Purposes a cat-loop message can carry, with the guidance appended to it. */
const PURPOSES = Object.freeze({
  task: 'task',
  'code-ready': 'code-ready',
  report: 'report',
  question: 'question',
  note: 'note',
})

/** Accepted purposes (the model-facing enum). */
export const MESSAGE_PURPOSES = Object.freeze(Object.keys(PURPOSES))

/** Title of the container conversation in the sidebar. */
const CONTAINER_TITLE = 'cat-loop 三队'

/** Harness home, matching the launcher's `DSH_HOME` resolution. */
function dshHome() {
  const configured = (process.env.DSH_HOME ?? '').trim()
  return configured === '' ? join(homedir(), '.dsh') : configured
}

/** Deep-freeze a value about to enter an agent inbox. */
function freeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const child of Object.values(value)) freeze(child)
  return Object.freeze(value)
}

/** Read a JSON file, or undefined when it is absent or unreadable. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** A plain mapping, or undefined for anything else. */
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/**
 * Build the bridge service.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {{ presets: Record<string, string>, stateFile?: string }} settings - normalized row config.
 * @returns {{ roleOf: Function, send: Function, status: Function, prepare: Function, stateForSession: Function }}
 */
export function createCatLoop(ctx, settings) {
  const presets = { ...DEFAULT_PRESETS, ...settings.presets }
  const rootPreset = presets.root
  const structure = settings.structure === 'nested' ? 'nested' : 'folder'
  const stateFile = settings.stateFile ?? join(dshHome(), 'cat-loop', 'state.json')

  let state = loadState()
  let queue = Promise.resolve()

  /**
   * Load durable identities. A version-1 file (three root sessions) becomes the
   * legacy table; new conversations always use version 2.
   */
  function loadState() {
    const raw = readJson(stateFile)
    const source = plainObject(raw)
    if (source === undefined) return emptyState()
    if (source.version === STATE_VERSION) {
      return {
        version: STATE_VERSION,
        conversations: plainObject(source.conversations) ?? {},
        legacy: plainObject(source.legacy) ?? {},
        folders: plainObject(source.folders) ?? {},
      }
    }
    if (source.version === 1) {
      return { version: STATE_VERSION, conversations: {}, legacy: plainObject(source.workspaces) ?? {}, folders: {} }
    }
    return emptyState()
  }

  function emptyState() {
    return { version: STATE_VERSION, conversations: {}, legacy: {}, folders: {} }
  }

  /** Persist conversation identities atomically; a failure is reported, never thrown. */
  function saveState() {
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      const temporary = `${stateFile}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      renameSync(temporary, stateFile)
    } catch (error) {
      ctx.logger?.warn?.(`cat-loop: could not persist conversations to ${stateFile}: ${message(error)}`)
    }
  }

  /** Run one provisioning operation at a time so two callers cannot race. */
  function serial(operation) {
    const run = queue.then(operation, operation)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Workspace a session belongs to: its project directory. */
  function workspaceOfSession(session) {
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') return cwd
    const fallback = ctx.get('workingDirectory')?.defaultDirectory
    return typeof fallback === 'string' && fallback !== '' ? fallback : process.cwd()
  }

  /** Workspace a live agent belongs to. */
  function workspaceOf(agent) {
    return workspaceOfSession(agent?.session)
  }

  /** The live Session object for one id, when the store or an Agent owns it. */
  function sessionOf(sessionId) {
    return ctx.agents.get(sessionId)?.session ?? ctx.sessions.get(sessionId)
  }

  /** Preset id recorded on one live session. */
  function presetOf(session) {
    return session?.header?.agentPreset
  }

  /** Team role recorded on one live session. */
  function roleOf(agent) {
    return roleForPreset(agent?.session?.header?.agentPreset, presets)
  }

  /** Preset-binding setup for one session composition. */
  function setupFor(presetId) {
    return async (agentCtx) => {
      const registry = ctx.get('agentPresets')
      if (registry === undefined) throw new Error('cat-loop: agent presets are not composed in this profile')
      await registry.mount(agentCtx, presetId)
    }
  }

  /** Agent options for a freshly composed session. */
  function agentOptions() {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (selection === undefined || selection === null) return undefined
    return {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    }
  }

  /** Every conversation record, in stable insertion order. */
  function conversations() {
    return Object.entries(state.conversations)
  }

  /**
   * Find the conversation owning one session id.
   * @param {string} sessionId - container or child session id.
   * @returns {{ containerId: string, conversation: Record<string, string>, role: string } | undefined}
   */
  function conversationEntry(sessionId) {
    const own = plainObject(state.conversations[sessionId])
    if (own !== undefined) return { containerId: sessionId, conversation: own, role: 'root' }
    for (const [containerId, conversation] of conversations()) {
      for (const role of ROLE_ORDER) {
        if (conversation[role] === sessionId) return { containerId, conversation, role }
      }
    }
    return undefined
  }

  /** Record the legacy table for one workspace, creating it on first use. */
  function legacyRecord(workspace) {
    const existing = plainObject(state.legacy[workspace])
    if (existing !== undefined) return existing
    const created = {}
    state.legacy[workspace] = created
    return created
  }

  /** Pseudo-workspace directory that makes one conversation folder in the sidebar. */
  function folderPathFor(project) {
    return join(project, '.cat-loop')
  }

  /** Sidebar label of one conversation folder. */
  const FOLDER_TITLE = 'cat-loop'

  function folderTitle() {
    return FOLDER_TITLE
  }

  /**
   * Name the conversation folder after the Plan conversation's generated
   * title, so the sidebar tree reads like the project the user is working on.
   * Best effort and idempotent: only a folder still on its default title is
   * renamed, and only while the Plan conversation is live and already titled.
   * @param {object} record - folder record.
   */
  async function syncFolderTitle(record) {
    const registry = ctx.get('workspaceRegistry')
    const titles = ctx.get('sessionTitle')
    if (registry === undefined || titles === undefined) return
    if (typeof record.workspaceId !== 'string') return
    const entity = typeof registry.get === 'function' ? registry.get(record.workspaceId) : undefined
    if (entity === undefined || entity.title !== FOLDER_TITLE) return
    const planId = record.plan
    if (typeof planId !== 'string' || planId === '') return
    const planAgent = ctx.agents.get(planId)
    const planSession = planAgent?.session ?? ctx.get('sessions')?.get?.(planId)
    if (planSession === undefined) return
    let planTitle
    try {
      planTitle = titles.get(planSession)
    } catch {
      return
    }
    if (typeof planTitle !== 'string' || planTitle.trim() === '' || planTitle === FOLDER_TITLE) return
    try {
      await entity.setTitle(planTitle)
    } catch (error) {
      ctx.logger?.warn?.(`cat-loop: could not title the conversation folder: ${message(error)}`)
    }
  }

  /**
   * Find the folder owning one session id.
   * @param {string} sessionId - container or team session id.
   * @returns {{ folderPath: string, record: Record<string, string>, role: string } | undefined}
   */
  function folderEntryForSession(sessionId) {
    for (const [folderPath, value] of Object.entries(state.folders)) {
      const record = plainObject(value)
      if (record === undefined) continue
      if (record.container === sessionId) return { folderPath, record, role: 'root' }
      for (const role of ROLE_ORDER) {
        if (record[role] === sessionId) return { folderPath, record, role }
      }
    }
    return undefined
  }

  /**
   * Project directory one session works in. Team conversations of a folder live
   * in the folder workspace (their Session cwd), so the real project is kept in
   * the folder record and returned here for tools, guards and messages.
   * @param {object | undefined} agentOrSession - live Agent or Session.
   * @returns {string | undefined}
   */
  function projectRootOf(agentOrSession) {
    const session = agentOrSession?.session ?? agentOrSession
    const sessionId = session?.id
    if (typeof sessionId === 'string') {
      const folder = folderEntryForSession(sessionId)
      if (folder !== undefined && typeof folder.record.project === 'string') return folder.record.project
    }
    return workspaceOfSession(session)
  }

  /** Role a session plays in the current structure. */
  function roleOfSession(agentOrSession) {
    const session = agentOrSession?.session ?? agentOrSession
    const sessionId = session?.id
    if (typeof sessionId === 'string') {
      const folder = folderEntryForSession(sessionId)
      if (folder !== undefined) return folder.role === 'root' ? undefined : folder.role
      const conversation = conversationEntry(sessionId)
      if (conversation !== undefined) return conversation.role === 'root' ? undefined : conversation.role
      const legacy = legacyEntryFor(sessionId)
      if (legacy !== undefined) return legacy.role
    }
    return roleForPreset(session?.header?.agentPreset, presets)
  }

  /**
   * Create one root team conversation of a folder.
   *
   * A folder team is a real Agent Team lead: it is an ordinary root Session
   * (so the Team tools install), attached to the folder workspace for the
   * sidebar, and its working directory is the project so relative paths behave.
   * @param {'plan' | 'build' | 'review'} role - team role.
   * @param {string} folderPath - folder workspace directory (the session cwd).
   * @param {string} project - real project directory.
   * @returns {Promise<string>} the session id.
   */
  async function createFolderTeamSession(role, folderPath, project) {
    const presetId = presets[role]
    if (typeof presetId !== 'string' || presetId === '') {
      throw new Error(`cat-loop: no preset configured for the ${role} team`)
    }
    const sessionId = `session-${randomUUID()}`
    // The session is composed once to persist its preset, intro and working
    // directory, then released: a stored (not live) root conversation resumes
    // through the session controller when the user or a peer opens it, which
    // also supplies the model selection. Keeping this agent live with a host
    // default would make its first turn fail with "no provider/model".
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: folderPath, agentPreset: presetId },
      ...(agentOptions() === undefined ? {} : { agentOptions: agentOptions() }),
      setup: async (agentCtx) => {
        const registry = ctx.get('agentPresets')
        if (registry === undefined) throw new Error('cat-loop: agent presets are not composed in this profile')
        await registry.mount(agentCtx, presetId)
      },
    })
    const session = handle.agent.session
    // Post-publication appends: the turn must reach session observers (and the
    // persisted projection) so a later resume continues at turn 2 instead of
    // reusing turn 1 and corrupting the log.
    session.append('turn/start', { turn: 1 })
    session.append('agent-preset/selected', { agentPreset: presetId })
    appendSeedSurface(session, role)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const titles = ctx.get('sessionTitle')
    if (titles !== undefined) {
      try {
        if (titles.get(session) === undefined) titles.rename(session, role)
      } catch (error) {
        ctx.logger?.warn?.(`cat-loop: could not title the ${role} conversation: ${message(error)}`)
      }
    }
    await flushSession(session)
    await handle.dispose()
    return { sessionId, project }
  }

  /**
   * Register (or repair) the folder workspace of one conversation and attach
   * its three team conversations. Runs on every prepare, so a folder whose
   * workspace registration was lost is repaired on the next open.
   * @param {object} record - folder record.
   * @param {string} folderPath - folder directory.
   * @returns {Promise<object | undefined>} the workspace entity when available.
   */
  async function ensureFolderWorkspace(record, folderPath) {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return undefined
    const project = typeof record.project === 'string' ? record.project : ''
    if (project !== '') {
      try {
        await registry.create(project, basename(project))
      } catch (error) {
        ctx.logger?.warn?.(`cat-loop: could not register the project workspace: ${message(error)}`)
      }
    }
    let entity
    try {
      entity = await registry.create(folderPath, folderTitle())
    } catch (error) {
      ctx.logger?.warn?.(`cat-loop: could not register the conversation folder: ${message(error)}`)
      return undefined
    }
    if (typeof record.workspaceId !== 'string' || entity.id !== record.workspaceId) {
      record.workspaceId = entity.id
    }
    for (const role of ROLE_ORDER) {
      const sessionId = record[role]
      if (typeof sessionId !== 'string' || sessionId === '') continue
      try {
        await entity.attachSession(sessionId)
      } catch (error) {
        ctx.logger?.warn?.(`cat-loop: could not list the ${role} conversation in its folder: ${message(error)}`)
      }
    }
    return entity
  }

  /**
   * Materialize (or repair) the conversation folder of one container: register
   * the folder as a workspace, create the three root team conversations, list
   * them under that workspace, and hide the now-unused container session.
   * @param {object} containerSession - live container Session (`cat-root`).
   * @returns {Promise<object>} folder snapshot.
   */
  async function ensureFolder(containerSession) {
    const project = workspaceOfSession(containerSession)
    if (typeof project !== 'string' || project === '') {
      return { ok: false, error: { code: 'no-workspace', message: 'this conversation has no workspace directory' } }
    }
    const teamsRoot = join(dshHome(), 'cat-loop', 'teams')
    // The conversation's own workspace may already be a conversation folder:
    // the shipped browser also opens a blank New Session inside it. Such an
    // entry is a shell, so it is archived away from the sidebar once it has
    // served its redirect.
    const direct = plainObject(state.folders[project])
    if (direct !== undefined && typeof direct.plan === 'string' && direct.plan !== '') {
      // The conversation itself lives inside the conversation folder (the
      // browser also opens a blank New Session there): answer with the folder.
      // The blank entry is hidden while not current and is never archived.
      return folderSnapshot(project, 'root')
    }
    const existing = plainObject(state.folders[folderPathFor(project)])
    if (existing !== undefined && typeof existing.plan === 'string' && existing.plan !== '') {
      // This cat-root conversation belongs to a project whose folder already
      // exists. Send the user back to that folder's Plan team; the snapshot
      // must be keyed by the folder directory, not the project path. The entry
      // itself is left untouched: it is blank, hence hidden, and archiving the
      // conversation the browser is still showing would clear the workspace
      // the user just picked on the New Session screen.
      await ensureFolderWorkspace(existing, folderPathFor(project))
      await syncFolderTitle(existing)
      return folderSnapshot(folderPathFor(project), 'root')
    }
    if (project === teamsRoot || project.startsWith(teamsRoot + sep)) {
      return {
        ok: false,
        error: { code: 'folder-nested', message: 'this conversation lives inside a cat-loop folder; open it from the folder instead' },
      }
    }
    const folderPath = folderPathFor(project)
    mkdirSync(folderPath, { recursive: true })
    const record = plainObject(state.folders[folderPath]) ?? {}
    state.folders[folderPath] = record
    record.project = project
    record.container = containerSession.id
    for (const role of ROLE_ORDER) {
      const known = record[role]
      if (typeof known === 'string' && known !== '') continue
      record[role] = (await createFolderTeamSession(role, folderPath, project)).sessionId
      saveState()
    }
    // Register the folder workspace and attach the three team conversations so
    // the workspace browser can show them (and repair it if it was lost).
    await ensureFolderWorkspace(record, folderPath)
    // The container stays a blank Session: it is hidden from the workspace
    // browser once it is no longer current, and archiving it while the browser
    // is redirecting away from it would race that navigation.
    await flushSession(containerSession)
    saveState()
    return folderSnapshot(folderPath, 'root')
  }

  /** Snapshot for one conversation folder. */
  function folderSnapshot(folderPath, currentRole) {
    const record = plainObject(state.folders[folderPath]) ?? {}
    return {
      ok: true,
      kind: 'folder',
      folder: folderPath,
      workspace: typeof record.project === 'string' ? record.project : '',
      container: typeof record.container === 'string' ? record.container : null,
      role: currentRole,
      currentRole,
      teams: ROLE_ORDER.map((role) => {
        const sessionId = typeof record[role] === 'string' ? record[role] : ''
        const agent = sessionId === '' ? undefined : ctx.agents.get(sessionId)
        return {
          role,
          label: ROLE_TITLES[role],
          preset: presets[role],
          sessionId,
          parentSessionId: null,
          mode: null,
          live: agent !== undefined,
          status: sessionId === '' ? 'absent' : role === currentRole ? 'current' : agent !== undefined ? agent.status ?? 'live' : 'stored',
        }
      }),
    }
  }

  /**
   * Account one conversation session in the workspace registry. Only the
   * container is a workspace-level conversation; children stay nested.
   * @param {string} workspace - project directory.
   * @param {string} sessionId - container session to account for it.
   */
  async function attachWorkspaceSession(workspace, sessionId) {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return
    try {
      let canonical = workspace
      try {
        canonical = await realpath(workspace)
      } catch {
        canonical = workspace
      }
      const entity = registry.list().find((candidate) => candidate.path === canonical)
      if (entity === undefined) return
      await entity.attachSession(sessionId)
    } catch (error) {
      ctx.logger?.warn?.(`cat-loop: could not list ${sessionId} under its workspace: ${message(error)}`)
    }
  }

  /**
   * Keep the container Agent live. A continuable child is only editable while
   * its direct parent Agent exists, and every cross-team message is authorized
   * through this exact Agent, so it is resumed once and owned by this row.
   * @param {string} containerId - container session id.
   * @returns {Promise<object>} the live container Agent.
   */
  async function ensureContainerAgent(containerId) {
    const live = ctx.agents.get(containerId)
    if (live !== undefined) return live
    const handle = await ctx.agents.resume({
      resumeSessionId: containerId,
      ...(agentOptions() === undefined ? {} : { agentOptions: agentOptions() }),
      setup: setupFor(rootPreset),
    })
    return handle.agent
  }

  /**
   * Make the container a normal, visible conversation: it must carry one closed
   * turn (blank sessions are hidden from the workspace browser and cannot be
   * opened as a conversation) and a readable title. Idempotent.
   * @param {object} session - live container Session.
   */
  function ensureContainerVisible(session) {
    const log = Array.isArray(session.log) ? session.log : []
    if (!log.some((event) => event.type === 'turn/start')) {
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }
    const titles = ctx.get('sessionTitle')
    if (titles === undefined) return
    try {
      if (titles.get(session) === undefined) titles.rename(session, CONTAINER_TITLE)
    } catch (error) {
      ctx.logger?.warn?.(`cat-loop: could not title the container: ${message(error)}`)
    }
  }

  /**
   * First visible line of one team conversation: who the lead is, what its
   * boundary is, and how to grow its own team. It is a normal user message so
   * the UI renders it, and it stays in the cold-resume context.
   * @param {'plan' | 'build' | 'review'} role - team role.
   * @returns {string} Markdown intro.
   */
  function teamIntro(role) {
    const common =
      '需要并行处理时，用 `subagent` 工具派自己的子智能体（它们是本对话的子对话，可用 send_message / list_agents 管理）；日常任务由 Plan 团队通过 `cat_send` 派发。'
    if (role === 'plan') {
      return (
        '【cat-loop】本对话是 **Plan 团队**。你是 Plan 队长：读工作区、把任务写进 `.cat-prompt/` 的 MD 文档，' +
        '再用 `cat_send` 派发给 build / review；等 Review 回报后继续下一个任务。' +
        common
      )
    }
    if (role === 'build') {
      return (
        '【cat-loop】本对话是 **Build 团队**。你是 Build 队长：实现 Plan 派发的任务，' +
        '可以执行命令、读写除 `.cat-test/` 外的文件，完成后用 `cat_send` 通知 review。' +
        common
      )
    }
    return (
      '【cat-loop】本对话是 **Review 团队**。你是 Review 队长：在 `.cat-test/` 写检查代码并执行，' +
      '再做人工审查，最后用 `cat_send(purpose: "report")` 把结论发回 plan。' +
      common
    )
  }

  /**
   * First visible line of one team conversation for the user. It is a normal
   * user message; the team guidance itself goes into the protected system head.
   * @param {'plan' | 'build' | 'review'} role - team role.
   * @returns {string} short Markdown greeting.
   */
  function teamGreeting(role) {
    if (role === 'plan') return '已就绪。把需求发到这里，Plan 团队会规划任务并派发给 Build / Review。'
    if (role === 'build') return '已就绪。Plan 团队会派发实现任务；你也可以直接把改动要求告诉我。'
    return '已就绪。Build 完成后 Plan 会派发审查；你也可以直接让我编写并运行检查代码。'
  }

  /**
   * Append the first surface pair of a seeded team conversation:
   * - a `system/message` head, because the session format requires the first
   *   surface event to be a protected system head before any later system
   *   message may be appended (the agent loop appends one on its first run);
   * - the visible greeting as a normal user message.
   * @param {object} session - live seeded Session.
   * @param {'plan' | 'build' | 'review'} role - team role.
   * @returns {void}
   */
  function appendSeedSurface(session, role) {
    session.append('step/start', { turn: 1, step: 1 })
    session.append(
      'system/message',
      {
        turn: 1,
        step: 1,
        message: {
          id: randomUUID(),
          role: 'system',
          content: [{ type: 'text', text: teamIntro(role) }],
          source: { kind: 'cat-loop', role },
        },
      },
      { surfaceOp: 'append' },
    )
    session.append(
      'user/message',
      {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: teamGreeting(role) }],
        source: { kind: 'cat-loop', role },
      },
      { surfaceOp: 'append' },
    )
    session.append('step/end', { turn: 1, step: 1 })
  }

  /**
   * Create one missing team conversation (a normal root Session in the user's
   * own workspace, not a subagent child).
   * @param {Record<string, string>} conversation - conversation record to fill.
   * @param {string} workspace - project directory.
   * @param {'plan' | 'build' | 'review'} role - team role.
   * @returns {Promise<string>} the team session id.
   */
  async function createTeamSession(conversation, workspace, role) {
    const presetId = presets[role]
    if (typeof presetId !== 'string' || presetId === '') {
      throw new Error(`cat-loop: no preset configured for the ${role} team`)
    }
    const sessionId = `session-${randomUUID()}`
    const options = agentOptions()
    // A normal root Session in the user's own workspace: no new workspace, no
    // parent Session, so each team is an independent Agent Team whose lead can
    // spawn its own teammates. The handle is disposed after seeding; the
    // shipped UI resumes the stored conversation when it is opened.
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: workspace, agentPreset: presetId },
      ...(options === undefined ? {} : { agentOptions: options }),
      setup: setupFor(presetId),
    })
    const session = handle.agent.session
    session.append('turn/start', { turn: 1 })
    session.append('agent-preset/selected', { agentPreset: presetId })
    appendSeedSurface(session, role)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const titles = ctx.get('sessionTitle')
    if (titles !== undefined) {
      try {
        if (titles.get(session) === undefined) titles.rename(session, role)
      } catch (error) {
        ctx.logger?.warn?.(`cat-loop: could not title the ${role} conversation: ${message(error)}`)
      }
    }
    await flushSession(session)
    await handle.dispose()
    conversation[role] = sessionId
    // List the conversation under the user's workspace; the Client half hides
    // its native row and nests it under the cat-loop container conversation.
    await attachWorkspaceSession(workspace, sessionId)
    return sessionId
  }

  /**
   * Ensure the three child conversations exist for one container.
   * @param {object} session - live container Session.
   * @param {Record<string, string>} conversation - conversation record.
   * @param {string} workspace - project directory.
   */
  async function ensureChildren(session, conversation, workspace) {
    conversation.flavor = 'inline'
    for (const role of ROLE_ORDER) {
      const known = conversation[role]
      if (typeof known === 'string' && known !== '') continue
      await createTeamSession(conversation, workspace, role)
    }
    saveState()
  }

  /** Flush one live session's appends durably; a missing backend is fine. */
  async function flushSession(session) {
    try {
      await ctx.sessions.flush(session)
    } catch (error) {
      ctx.logger?.warn?.(`cat-loop: could not flush ${session.id}: ${message(error)}`)
    }
  }

  /** One team row of the Web snapshot. */
  function teamRow(conversation, containerId, role, currentRole) {
    const sessionId = typeof conversation[role] === 'string' ? conversation[role] : ''
    const agent = sessionId === '' ? undefined : ctx.agents.get(sessionId)
    let status = 'stored'
    if (sessionId === '') status = 'absent'
    else if (role === currentRole) status = 'current'
    else if (agent !== undefined) status = agent.status ?? 'live'
    const inline = conversation.flavor === 'inline'
    return {
      role,
      label: ROLE_TITLES[role],
      preset: presets[role],
      sessionId,
      parentSessionId: inline ? null : containerId,
      mode: inline ? null : 'continuable',
      live: agent !== undefined,
      status,
    }
  }

  /**
   * Snapshot for one container (or one of its children).
   * @param {string} containerId - container session id.
   * @param {string} currentRole - role asking: `root` for the container itself.
   */
  function containerSnapshot(containerId, currentRole) {
    const conversation = plainObject(state.conversations[containerId]) ?? {}
    const inline = conversation.flavor === 'inline'
    return {
      ok: true,
      kind: inline ? 'inline' : currentRole === 'root' ? 'container' : 'nested',
      workspace: typeof conversation.workspace === 'string' ? conversation.workspace : '',
      container: containerId,
      role: currentRole,
      currentRole,
      teams: ROLE_ORDER.map((role) => teamRow(conversation, containerId, role, currentRole)),
    }
  }

  /**
   * Read-only snapshot for one conversation. Unlike {@link prepare}, it never
   * materializes children, resumes Agents, or touches the disk: the sidebar
   * seat calls it for every rendered Session row.
   * @param {string} sessionId - any cat-loop session id.
   * @returns {object} snapshot or a structured failure.
   */
  function peek(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { ok: false, error: { code: 'session-unavailable', message: 'no session was named' } }
    }
    const folder = folderEntryForSession(sessionId)
    if (folder !== undefined) return folderSnapshot(folder.folderPath, folder.role)
    const entry = conversationEntry(sessionId)
    if (entry !== undefined) return containerSnapshot(entry.containerId, entry.role)
    const legacy = legacyEntryFor(sessionId)
    if (legacy !== undefined) return legacySnapshot(legacy.workspace, legacy.role)
    return { ok: false, error: { code: 'not-cat-loop', message: 'this conversation is not a cat-loop team' } }
  }

  /** Snapshot for a pre-v2 root-session conversation. */
  function legacySnapshot(workspace, currentRole) {
    const record = plainObject(state.legacy[workspace]) ?? {}
    return {
      ok: true,
      kind: 'legacy',
      workspace,
      container: null,
      role: currentRole,
      currentRole,
      teams: ROLE_ORDER.map((role) => {
        const sessionId = typeof record[role] === 'string' ? record[role] : ''
        const agent = sessionId === '' ? undefined : ctx.agents.get(sessionId)
        return {
          role,
          label: ROLE_TITLES[role],
          preset: presets[role],
          sessionId,
          parentSessionId: null,
          mode: null,
          live: agent !== undefined,
          status: sessionId === '' ? 'absent' : role === currentRole ? 'current' : agent !== undefined ? agent.status ?? 'live' : 'stored',
        }
      }),
    }
  }

  /**
   * Prepare one conversation before the browser opens it: materialize the
   * container's children, keep the container Agent live, and report the nested
   * shape the client needs for a redirect.
   * @param {string} sessionId - any cat-loop session id (container, team or legacy).
   * @returns {Promise<object>} snapshot or a structured failure.
   */
  /** Resolve a pre-2.0 root session from the legacy table. */
  function legacyEntryFor(sessionId) {
    for (const [workspace, record] of Object.entries(state.legacy)) {
      const table = plainObject(record)
      if (table === undefined) continue
      for (const role of ROLE_ORDER) {
        if (table[role] === sessionId) return { workspace, role }
      }
    }
    return undefined
  }

  /**
   * Prepare one conversation before the browser opens it.
   *
   * Nesting is durable: a stored child conversation is not live in the Session
   * store until the subagent manager cold-resumes it, so the state file — not
   * the live store — is the identity source. The container Agent is kept live
   * here because the shipped UI marks a continuable child editable only while
   * its direct parent Agent exists, and every hand-off is authorized through it.
   * @param {string} sessionId - any cat-loop session id (container, team or legacy).
   * @returns {Promise<object>} snapshot or a structured failure.
   */
  async function prepare(sessionId) {
    return serial(async () => {
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { ok: false, error: { code: 'session-unavailable', message: 'no session was named' } }
      }
      const folder = folderEntryForSession(sessionId)
      if (folder !== undefined) {
        if (folder.role === 'root') {
          const containerSession = sessionOf(sessionId)
          return containerSession === undefined ? folderSnapshot(folder.folderPath, 'root') : await ensureFolder(containerSession)
        }
        await syncFolderTitle(folder.record)
        return folderSnapshot(folder.folderPath, folder.role)
      }
      const entry = conversationEntry(sessionId)
      if (entry !== undefined) {
        const inline = entry.conversation.flavor === 'inline'
        const containerSession = inline ? sessionOf(entry.containerId) : sessionOf(entry.containerId) ?? (await ensureContainerAgent(entry.containerId)).session
        const workspace =
          typeof entry.conversation.workspace === 'string' && entry.conversation.workspace !== ''
            ? entry.conversation.workspace
            : containerSession?.header?.cwd
        if (typeof workspace !== 'string' || workspace === '') {
          return { ok: false, error: { code: 'no-workspace', message: 'this conversation has no workspace directory' } }
        }
        if (inline) {
          // Independent team conversations: repair any missing one and keep the
          // container listed so the Client half can nest the teams under it.
          if (containerSession !== undefined) {
            ensureContainerVisible(containerSession)
            await flushSession(containerSession)
          }
          saveState()
          return containerSnapshot(entry.containerId, entry.role)
        }
        await ensureContainerAgent(entry.containerId)
        ensureContainerVisible(containerSession)
        await ensureChildren(containerSession, entry.conversation, workspace)
        await flushSession(containerSession)
        if (entry.role === 'root') await attachWorkspaceSession(workspace, entry.containerId)
        saveState()
        return containerSnapshot(entry.containerId, entry.role)
      }

      const session = sessionOf(sessionId)
      if (session === undefined) {
        return { ok: false, error: { code: 'session-unavailable', message: 'the session is not live in this Host' } }
      }
      const preset = presetOf(session)
      if (preset === rootPreset && structure === 'folder') {
        return await ensureFolder(session)
      }
      if (preset === presets.plan && structure !== 'folder' && legacyEntryFor(session.id) === undefined) {
        // The conversation the user starts IS the Plan team: no container shell
        // and no redirect. Its Build and Review peers are independent root Team
        // conversations in the same workspace, nested under this one in the
        // sidebar by the Client half.
        const workspace = session.header?.cwd
        if (typeof workspace !== 'string' || workspace === '') {
          return { ok: false, error: { code: 'no-workspace', message: 'this conversation has no workspace directory yet' } }
        }
        const record = plainObject(state.conversations[session.id]) ?? {}
        state.conversations[session.id] = record
        record.workspace = workspace
        record.flavor = 'inline'
        record.plan = session.id
        await attachWorkspaceSession(workspace, session.id)
        for (const role of ['build', 'review']) {
          const known = record[role]
          if (typeof known === 'string' && known !== '') continue
          await createTeamSession(record, workspace, role)
          saveState()
        }
        saveState()
        return containerSnapshot(session.id, 'plan')
      }
      if (preset === rootPreset) {
        const workspace = session.header?.cwd
        if (typeof workspace !== 'string' || workspace === '') {
          return {
            ok: false,
            error: {
              code: 'no-workspace',
              message: 'this conversation has no workspace directory yet; choose a workspace first',
            },
          }
        }
        const conversation = plainObject(state.conversations[session.id])
        if (conversation === undefined) {
          state.conversations[session.id] = { workspace, plan: '', build: '', review: '' }
        }
        const record = state.conversations[session.id]
        if (typeof record.workspace !== 'string' || record.workspace === '') record.workspace = workspace
        // The container is a normal conversation in the user's own workspace;
        // its three teams are independent root conversations in that same
        // workspace (no extra workspace is registered).
        ensureContainerVisible(session)
        await attachWorkspaceSession(workspace, session.id)
        await ensureChildren(session, record, workspace)
        await flushSession(session)
        saveState()
        return containerSnapshot(session.id, 'root')
      }
      const role = roleForPreset(preset, presets)
      if (role === undefined) {
        return { ok: false, error: { code: 'not-cat-loop', message: 'this conversation is not a cat-loop team' } }
      }
      if (typeof session.header?.cwd !== 'string' || session.header.cwd === '') {
        return { ok: false, error: { code: 'no-workspace', message: 'this conversation has no workspace directory' } }
      }
      const workspace = workspaceOfSession(session)
      if (plainObject(state.legacy[workspace]) === undefined) {
        return { ok: false, error: { code: 'not-cat-loop', message: 'this conversation is not a cat-loop team' } }
      }
      legacyRecord(workspace)[role] = session.id
      saveState()
      return legacySnapshot(workspace, role)
    })
  }

  /** Format the model-facing body of one cross-team message. */
  function formatMessage(from, to, purpose, body, workspace) {
    const payload = typeof body === 'string' ? body.trim() : ''
    const lines = [
      `cat-loop · ${ROLE_TITLES[from]} team → ${ROLE_TITLES[to]} team`,
      `purpose: ${purpose}`,
      '',
      payload,
    ]
    if (purpose === 'task') {
      lines.push(
        '',
        `Task briefs for this workspace live under \`.cat-prompt/\`; the Review team owns \`.cat-test/\`. Workspace: ${workspace}`,
      )
    } else if (purpose === 'code-ready') {
      lines.push('', 'The Build team reports the code is ready — run the check code under `.cat-test/`, then review the implementation.')
    } else if (purpose === 'report') {
      lines.push('', 'Close the cycle: mark the task done and dispatch the next brief, or write a fix brief and dispatch again.')
    }
    return lines.join('\n')
  }

  /** Deliver one message into a root peer's inbox (legacy conversations only). */
  function deliver(agent, text, senderSessionId) {
    const content = [{ type: 'text', text }]
    const message = freeze({
      id: randomUUID(),
      role: 'user',
      content,
      source: { kind: 'agent-message', form: 'relay', senderSessionId },
    })
    agent.steer(message)
    return message.id
  }

  /**
   * Return a live legacy peer, resuming or creating its root session.
   * @param {'plan' | 'build' | 'review'} role - destination team.
   * @param {string} workspace - project directory shared by the three teams.
   * @param {Record<string, string>} record - legacy table for that workspace.
   */
  async function ensureLegacyPeer(role, workspace, record) {
    const presetId = presets[role]
    const known = record[role]
    if (typeof known === 'string' && known !== '') {
      const live = ctx.agents.get(known)
      if (live !== undefined) return { agent: live, sessionId: known, provisioned: false }
      try {
        const handle = await ctx.agents.resume({
          resumeSessionId: known,
          ...(agentOptions() === undefined ? {} : { agentOptions: agentOptions() }),
          setup: setupFor(presetId),
        })
        return { agent: handle.agent, sessionId: known, provisioned: false }
      } catch (error) {
        ctx.logger?.warn?.(`cat-loop: ${role} session ${known} could not be resumed: ${message(error)}`)
      }
    }
    const sessionId = `session-${randomUUID()}`
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: workspace, agentPreset: presetId },
      ...(agentOptions() === undefined ? {} : { agentOptions: agentOptions() }),
      setup: setupFor(presetId),
    })
    record[role] = sessionId
    saveState()
    return { agent: handle.agent, sessionId, provisioned: true }
  }

  /**
   * Send one message to another team's conversation.
   * @param {object} caller - exact live calling agent.
   * @param {{ to: string, purpose: string, body: string, signal?: AbortSignal }} request - destination and content.
   * @returns {Promise<{ to: string, session_id: string, message_id: string, provisioned: boolean }>}
   */
  async function send(caller, request) {
    return serial(async () => {
      const from = roleOf(caller)
      if (from === undefined) {
        throw new Error(
          '[cat-loop] this session is not one of the cat-loop teams; cat_send is only available inside the cat-plan, cat-build, and cat-review presets.',
        )
      }
      const to = request?.to
      if (!ROLE_ORDER.includes(to)) throw new Error(`[cat-loop] cat_send expects to to be one of ${ROLE_ORDER.join(', ')}`)
      if (to === from) throw new Error(`[cat-loop] the ${ROLE_TITLES[from]} team cannot send to itself`)
      const purpose = MESSAGE_PURPOSES.includes(request?.purpose) ? request.purpose : 'note'
      const body = typeof request?.body === 'string' ? request.body : ''
      if (body.trim() === '') throw new Error('[cat-loop] cat_send requires a non-empty body')
      const workspace = projectRootOf(caller) ?? workspaceOf(caller)
      const text = formatMessage(from, to, purpose, body, workspace)
      const signal = request?.signal instanceof AbortSignal ? request.signal : new AbortController().signal

      const folder = folderEntryForSession(caller.session.id)
      if (folder !== undefined) {
        const targetId = folder.record[to]
        if (typeof targetId !== 'string' || targetId === '') {
          throw new Error(`[cat-loop] the ${ROLE_TITLES[to]} team is not provisioned yet`)
        }
        let peer = ctx.agents.get(targetId)
        if (peer === undefined) {
          try {
            const handle = await ctx.agents.resume({
              resumeSessionId: targetId,
              ...(agentOptions() === undefined ? {} : { agentOptions: agentOptions() }),
            })
            peer = handle.agent
          } catch (error) {
            throw new Error(`[cat-loop] could not wake the ${ROLE_TITLES[to]} team: ${message(error)}`)
          }
        }
        folder.record[from] = caller.session.id
        const messageId = deliver(peer, text, caller.session.id)
        saveState()
        return { to, session_id: targetId, message_id: messageId, provisioned: false }
      }

      const entry = conversationEntry(caller.session.id)
      const targetId = entry === undefined ? '' : entry.conversation[to]

      if (entry !== undefined && typeof targetId === 'string' && targetId !== '') {
        // Each team is a normal root conversation in the user's workspace, so
        // wake its Agent with the current model and steer the message in.
        entry.conversation[from] = caller.session.id
        let peer
        try {
          peer = await ensureLegacyPeer(to, workspace, entry.conversation)
        } catch (error) {
          throw new Error(`[cat-loop] could not wake the ${ROLE_TITLES[to]} team: ${message(error)}`)
        }
        const messageId = deliver(peer.agent, text, caller.session.id)
        saveState()
        return { to, session_id: peer.sessionId, message_id: messageId, provisioned: peer.provisioned }
      }

      // Legacy conversation recorded as three root sessions.
      const record = legacyRecord(workspace)
      record[from] = caller.session.id
      const peer = await ensureLegacyPeer(to, workspace, record)
      const messageId = deliver(peer.agent, text, caller.session.id)
      saveState()
      return {
        to,
        session_id: peer.sessionId,
        message_id: messageId,
        provisioned: peer.provisioned,
      }
    })
  }

  /**
   * Report the three teams for the caller's workspace.
   * @param {object} caller - exact live calling agent.
   * @returns {{ workspace: string, teams: Array<{ role: string, preset: string, session_id: string, live: boolean, status: string }> }}
   */
  function status(caller) {
    const folder = folderEntryForSession(caller.session.id)
    if (folder !== undefined) {
      const snapshot = folderSnapshot(folder.folderPath, folder.role === 'root' ? 'root' : folder.role)
      return {
        workspace: snapshot.workspace,
        teams: snapshot.teams.map((team) => ({
          role: team.role,
          preset: team.preset,
          session_id: team.sessionId,
          live: team.live,
          status: team.status,
        })),
      }
    }
    const workspace = workspaceOf(caller)
    const entry = conversationEntry(caller.session.id)
    if (entry !== undefined) {
      const snapshot = containerSnapshot(entry.containerId, entry.role)
      return {
        workspace: snapshot.workspace,
        teams: snapshot.teams.map((team) => ({
          role: team.role,
          preset: team.preset,
          session_id: team.sessionId,
          live: team.live,
          status: team.status,
        })),
      }
    }
    const record = plainObject(state.legacy[workspace]) ?? {}
    return {
      workspace,
      teams: ROLE_ORDER.map((role) => {
        const sessionId = typeof record[role] === 'string' ? record[role] : ''
        const agent = sessionId === '' ? undefined : ctx.agents.get(sessionId)
        return {
          role,
          preset: presets[role],
          session_id: sessionId,
          live: agent !== undefined,
          status: agent?.status ?? (sessionId === '' ? 'absent' : 'stored'),
        }
      }),
    }
  }

  return {
    roleOf,
    roleOfSession,
    projectRootOf,
    send,
    status,
    prepare,
    peek,
    stateForSession: prepare,
  }
}

/** Error message without assuming an Error instance. */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}
