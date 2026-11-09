/**
 * cat-loop Web face — the conversation snapshot the browser panel and the
 * container redirect read.
 *
 * The conversations live in Host services, so the Client half cannot read them
 * directly. Two exact loopback routes expose one read-through snapshot:
 * `/api/cat-loop/state` is the current route (it also materializes the three
 * child conversations the first time a container is opened) and
 * `/api/cat-loop/teams` stays as an alias for older pages. Both are read-only
 * from the browser's point of view and carry no credentials.
 *
 * @module cat-loop/http
 */

/** Current absolute route serving the conversation snapshot. */
const STATE_PATH = '/api/cat-loop/state'

/** Pre-2.0 route, kept so an older cached page still renders. */
const LEGACY_STATE_PATH = '/api/cat-loop/teams'

/**
 * Read-only route for the sidebar seat: it answers from durable state and
 * never materializes children, so the browser may call it for every row.
 */
const PEEK_PATH = '/api/cat-loop/peek'

/** Only same-machine pages may read the snapshot. */
const LOOPBACK_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/

/** Host header spelling of a same-machine request. */
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - response owner.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON body.
 * @returns {void}
 */
function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * Install the Client half's two snapshot routes on the profile Web server.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {{ stateForSession: (sessionId: string) => unknown }} service - the cat-loop bridge.
 * @returns {void}
 */
export function installTeamsRoute(ctx, service) {
  const handler = async (req, res) => {
    const origin = req.headers.origin
    const host = req.headers.host ?? ''
    if ((origin !== undefined && !LOOPBACK_ORIGIN.test(origin)) || !LOOPBACK_HOST.test(host)) {
      sendJson(res, 403, {
        ok: false,
        error: { code: 'forbidden-origin', message: 'only same-machine requests are accepted' },
      })
      return
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, {
        ok: false,
        error: { code: 'method-not-allowed', message: 'the conversation snapshot is read-only' },
      })
      return
    }
    const url = new URL(req.url ?? STATE_PATH, 'http://localhost')
    const sessionId = url.searchParams.get('session') ?? ''
    try {
      const snapshot =
        url.pathname === PEEK_PATH ? await service.peek(sessionId) : await service.stateForSession(sessionId)
      sendJson(res, 200, snapshot)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`cat-loop: conversation snapshot failed: ${detail}`)
      sendJson(res, 500, {
        ok: false,
        error: { code: 'snapshot-failed', message: 'could not read the conversation snapshot', detail },
      })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: PEEK_PATH, handler }), 'cat-loop.peek-route()')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: STATE_PATH, handler }), 'cat-loop.state-route()')
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: LEGACY_STATE_PATH, handler }),
    'cat-loop.teams-route()',
  )
}
