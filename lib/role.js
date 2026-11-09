/**
 * cat-loop role tools — the model-facing seam mounted inside each team preset.
 *
 * Every lead gets the same two tools so the loop stays symmetric:
 *
 * - `cat_send` moves a message between the three team leads (task dispatch,
 *   code-ready handoff, review report, or a plain question).
 * - `cat_status` reports the three teams' sessions for this workspace.
 *
 * Team-internal work uses the shipped Agent Teams tools (`spawn_teammate`,
 * `send_message`, `list_agents`, `team_task_*`); this row only adds the
 * cross-team edge that a per-session roster cannot express.
 *
 * @module cat-loop/role
 */

import { MESSAGE_PURPOSES } from './bridge.js'
import { ROLE_ORDER, ROLE_TITLES } from './policy.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'cat-role'

/** Services required by the role tool row. */
export const inject = ['tools']

const PURPOSE_HELP = {
  task: 'a new or revised task for the receiver (normally sent by the Plan team)',
  'code-ready': 'the Build team reports the implementation is ready to check',
  report: 'the Review team reports its verdict and findings back to the Plan team',
  question: 'a question the receiver should answer in its own session',
  note: 'additional context for the receiver',
}

/**
 * Register the role's tools in the calling preset scope.
 * @param {import('@deepseek-ai/cordis').Context} ctx - preset-scoped context.
 * @param {{ role: 'plan' | 'build' | 'review' }} config - this preset's role.
 * @returns {void}
 */
export function apply(ctx, config) {
  const role = config?.role
  if (ROLE_TITLES[role] === undefined) {
    throw new Error(`cat-loop/role: config.role must be one of ${ROLE_ORDER.join(', ')} (received ${JSON.stringify(role)})`)
  }

  ctx.effect(() => ctx.tools.register(sendTool(ctx, role)), 'cat-role.send()')
  ctx.effect(() => ctx.tools.register(statusTool(ctx, role)), 'cat-role.status()')
}

/** Define the cross-team message tool. */
function sendTool(ctx, role) {
  return {
    name: 'cat_send',
    description:
      `Send a message to another cat-loop team's lead. This session leads the ${ROLE_TITLES[role]} team; ` +
      'the three teams (plan, build, review) work in the same workspace and hand work to each other with this tool. ' +
      'Delivery is asynchronous: the receiver wakes in its own session and any answer arrives later as a message here. ' +
      `Typical flows: the Plan lead dispatches with purpose "task" to build and review; the Build lead sends "code-ready" to review; ` +
      'the Review lead sends "report" to plan. Use "question" or "note" for anything else.',
    parameters: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          enum: [...ROLE_ORDER],
          description: 'Destination team lead: "plan", "build", or "review".',
        },
        purpose: {
          type: 'string',
          enum: [...MESSAGE_PURPOSES],
          description: Object.entries(PURPOSE_HELP)
            .map(([key, text]) => `"${key}": ${text}`)
            .join('; '),
        },
        body: {
          type: 'string',
          description:
            'The message body: the task brief excerpt and acceptance criteria, the handoff summary, or the review findings. Markdown is fine.',
        },
      },
      required: ['to', 'purpose', 'body'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          session_id: { type: 'string' },
          message_id: { type: 'string' },
          provisioned: { type: 'boolean' },
        },
        required: ['to', 'session_id', 'message_id', 'provisioned'],
        additionalProperties: false,
      },
      render(_args, value) {
        const started = value.provisioned === true ? '; the destination team was started for this handoff' : ''
        return [
          {
            type: 'text',
            text: `cat-loop: message accepted by the ${value.to} team lead (session ${value.session_id})${started}.`,
          },
        ]
      },
    },
    async execute(args, exec) {
      validateSend(args)
      const delivered = await bridgeOf(ctx).send(exec.agent, { ...args, signal: exec.signal })
      return delivered
    },
  }
}

/** Define the three-team status tool. */
function statusTool(ctx, role) {
  return {
    name: 'cat_status',
    description:
      `Report the three cat-loop teams for this workspace: each team's role, preset, session id, whether it is live, ` +
      'and its activity status. The cat-loop teams are materialized on first dispatch, so a stored-but-not-live team ' +
      'wakes when the next message reaches it.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          workspace: { type: 'string' },
          teams: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string' },
                preset: { type: 'string' },
                session_id: { type: 'string' },
                live: { type: 'boolean' },
                status: { type: 'string' },
              },
              required: ['role', 'preset', 'session_id', 'live', 'status'],
              additionalProperties: false,
            },
          },
        },
        required: ['workspace', 'teams'],
        additionalProperties: false,
      },
      render(_args, value) {
        const rows = value.teams.map(
          (team) =>
            `- ${team.role} (${team.preset}): ${team.session_id === '' ? 'not started yet' : `${team.session_id} · ${team.status}`}`,
        )
        return [{ type: 'text', text: `cat-loop teams in ${value.workspace}\n${rows.join('\n')}` }]
      },
    },
    async execute(_args, exec) {
      return bridgeOf(ctx).status(exec.agent)
    },
  }
}

/**
 * Resolve the cross-team bridge at call time. The host row normally activates
 * before any session exists; resolving lazily keeps this preset mountable even
 * when it does not, and reports the missing capability on the offending call
 * instead of leaving the whole preset unusable.
 */
function bridgeOf(ctx) {
  const service = ctx.get('catLoop')
  if (service === undefined) {
    throw new Error(
      '[cat-loop] the cat-loop host service is not composed in this profile; cross-team dispatch is unavailable.',
    )
  }
  return service
}

/** Validate `cat_send` arguments that the JSON Schema cannot express. */
function validateSend(args) {
  if (args === null || typeof args !== 'object') throw new Error('cat_send: arguments must be an object')
  if (!ROLE_ORDER.includes(args.to)) {
    throw new Error(`cat_send: "to" must be one of ${ROLE_ORDER.join(', ')}`)
  }
  if (!MESSAGE_PURPOSES.includes(args.purpose)) {
    throw new Error(`cat_send: "purpose" must be one of ${MESSAGE_PURPOSES.join(', ')}`)
  }
  if (typeof args.body !== 'string' || args.body.trim() === '') {
    throw new Error('cat_send: "body" must be a non-empty string')
  }
}
