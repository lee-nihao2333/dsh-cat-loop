/**
 * cat-loop Client half — the container redirect and the nested-team panel.
 *
 * The teams are subagent child conversations of one container conversation, so
 * the shipped UI already renders the nesting: the container header lists the
 * three child conversations and every child header carries a sibling switcher.
 * This module adds the two behaviors that shape is not enough for:
 *
 * - opening the container conversation lands directly in its Plan child, and
 *   the same redirect fires for a freshly created `cat-root` conversation
 *   before the user types (the hero row);
 * - a right-sidebar "子对话" panel lists the three team conversations with
 *   live status, so switching between them never needs the container.
 *
 * The Host exposes one loopback snapshot route (`/api/cat-loop/state`) that also
 * materializes the children the first time a container is opened.
 */
window.__ModuleLoader__.load({
  id: '@marvinlee2011/dsh-cat-loop',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** This module's copy namespace. */
    const NS = 'catLoop'
    /** Stage-one identity of the tab type; also the body/title registration key. */
    const TAB_ID = 'cat-loop/teams'
    /** Page kind users name when opening the tab. */
    const TAB_KIND = 'cat-loop-teams'
    /** Dots mark the team; artwork may keep its own colors. */
    const ROLE_DOT = { plan: '#8ab4ff', build: '#56d364', review: '#f2cc60' }
    /** Visible copy, both shipped locales. */
    const zh = {
      'tab.title': '子对话',
      'guide.title': 'cat-loop 子对话',
      'guide.description': '查看并切换 Plan / Build / Review 三个子对话',
      'header.label': '子对话',
      'header.hint': '查看 cat-loop 子对话并切换团队',
      'panel.title': '子对话',
      'panel.refresh': '刷新',
      'panel.workspace': '工作区',
      'panel.loading': '正在读取…',
      'panel.notTeam': '当前会话不是 cat-loop 会话，暂无子对话。',
      'panel.current': '当前',
      'panel.absent': '未创建',
      'panel.stored': '已保存',
      'panel.live': '在线',
      'panel.busy': '处理中',
      'panel.hint': '点击某个子对话即可切换；三个团队同时工作，Plan 负责规划和派发。',
      'nest.expand': '展开子对话',
      'nest.collapse': '收起子对话',
      'nest.lead': '主对话',
      'role.plan': 'Plan',
      'role.build': 'Build',
      'role.review': 'Review',
    }
    const en = {
      'tab.title': 'Sub-conversations',
      'guide.title': 'cat-loop sub-conversations',
      'guide.description': 'See and switch between the Plan, Build and Review sub-conversations',
      'header.label': 'Sub-conversations',
      'header.hint': 'See the cat-loop sub-conversations and switch teams',
      'panel.title': 'Sub-conversations',
      'panel.refresh': 'Refresh',
      'panel.workspace': 'Workspace',
      'panel.loading': 'Reading…',
      'panel.notTeam': 'This conversation is not a cat-loop conversation.',
      'panel.current': 'current',
      'panel.absent': 'not created',
      'panel.stored': 'saved',
      'panel.live': 'online',
      'panel.busy': 'working',
      'panel.hint': 'Click a sub-conversation to switch. The three teams work together; the Plan team plans and dispatches.',
      'nest.expand': 'Expand sub-conversations',
      'nest.collapse': 'Collapse sub-conversations',
      'nest.lead': 'Main conversation',
      'role.plan': 'Plan',
      'role.build': 'Build',
      'role.review': 'Review',
    }

    /**
     * Read the Host's conversation snapshot for one session.
     * @param {string} sessionId - container, team or legacy session id.
     * @returns {Promise<{ ok: boolean, [key: string]: unknown }>} snapshot or failure.
     */
    async function fetchState(sessionId) {
      try {
        const response = await fetch(`/api/cat-loop/state?session=${encodeURIComponent(sessionId)}`, {
          credentials: 'omit',
        })
        const body = await response.json()
        if (body === null || typeof body !== 'object') {
          return { ok: false, error: { code: 'bad-response', message: 'unexpected conversation snapshot' } }
        }
        return body
      } catch (error) {
        return { ok: false, error: { code: 'network', message: String((error && error.message) || error) } }
      }
    }

    /** Short-lived cache of read-only conversation snapshots, one per row. */
    const peekCache = new Map()
    /** How long one sidebar row reuses a peeked snapshot, in milliseconds. */
    const PEEK_TTL = 10_000

    /**
     * Read one conversation's read-only snapshot (never materializes children).
     * @param {string} sessionId - any session id shown in the sidebar.
     * @returns {Promise<{ ok: boolean, [key: string]: unknown }>} snapshot or failure.
     */
    async function fetchPeek(sessionId) {
      const cached = peekCache.get(sessionId)
      if (cached !== undefined && Date.now() - cached.at < PEEK_TTL) return cached.data
      let data
      try {
        const response = await fetch(`/api/cat-loop/peek?session=${encodeURIComponent(sessionId)}`, {
          credentials: 'omit',
        })
        const body = await response.json()
        data = body !== null && typeof body === 'object' ? body : { ok: false }
      } catch (error) {
        data = { ok: false, error: { code: 'network', message: String((error && error.message) || error) } }
      }
      peekCache.set(sessionId, { at: Date.now(), data })
      return data
    }

    /** Team conversations whose native sidebar row is replaced by our nesting. */
    const nestedTeamSessions = new Set()
    /** Injected stylesheet that hides those native rows. */
    let nestedTeamStyle = null

    /**
     * Hide the native Session row of every peer team conversation: the team rows
     * are rendered by the sidebar nesting seat under their parent conversation
     * instead, so the tree reads as conversation → sub-conversations. The
     * snapshot's own container Session stays visible.
     * @param {{ container?: string, teams?: object[] }} snapshot - conversation snapshot.
     * @returns {void}
     */
    function hideNestedTeamRows(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object' || typeof document === 'undefined') return
      const parent = typeof snapshot.container === 'string' ? snapshot.container : ''
      const teams = Array.isArray(snapshot.teams) ? snapshot.teams : []
      let changed = false
      for (const team of teams) {
        const sessionId = team === null || typeof team !== 'object' ? '' : team.sessionId
        if (typeof sessionId !== 'string' || sessionId === '' || sessionId === parent) continue
        if (nestedTeamSessions.has(sessionId)) continue
        nestedTeamSessions.add(sessionId)
        changed = true
      }
      if (!changed && nestedTeamStyle !== null) return
      if (nestedTeamStyle === null) {
        nestedTeamStyle = document.createElement('style')
        nestedTeamStyle.id = 'cat-loop-nested-teams'
        document.head.appendChild(nestedTeamStyle)
      }
      nestedTeamStyle.textContent = [...nestedTeamSessions]
        .map((sessionId) => `[data-row-key="session:${sessionId}"]{display:none!important}`)
        .join('\n')
    }

    /** Short stable form of a session id for the row subtitle. */
    function shortSession(sessionId) {
      return sessionId.startsWith('session-') ? sessionId.slice(8, 16) : sessionId.slice(0, 8)
    }

    /** One line describing a team's state. */
    function statusText(team, t) {
      if (team.status === 'absent') return t('panel.absent')
      if (team.status === 'stored') return t('panel.stored')
      if (team.status === 'current') return t('panel.current')
      if (team.status === 'running' || team.status === 'busy') return t('panel.busy')
      return t('panel.live')
    }

    /** The Plan child of one snapshot, when the snapshot has one. */
    function planTeam(snapshot) {
      return Array.isArray(snapshot.teams) ? snapshot.teams.find((team) => team.role === 'plan') : undefined
    }

    /**
     * Open one team conversation. Nested children carry their durable parent
     * address; legacy root sessions open by id.
     * @param {object} ctx - Client Context with `uiWorkspace`.
     * @param {{ sessionId: string, parentSessionId?: string | null, mode?: string | null }} team - team row.
     * @returns {boolean} whether the navigation was issued.
     */
    function openTeamConversation(ctx, team) {
      if (team === undefined || typeof team.sessionId !== 'string' || team.sessionId === '') return false
      try {
        if (typeof team.parentSessionId === 'string' && team.parentSessionId !== '' && team.mode === 'continuable') {
          ctx.uiWorkspace.openSession({
            parentSessionId: team.parentSessionId,
            childSessionId: team.sessionId,
            mode: 'continuable',
          })
        } else {
          ctx.uiWorkspace.openSession(team.sessionId)
        }
        return true
      } catch (error) {
        console.warn('cat-loop: could not open a team conversation', error)
        return false
      }
    }

    /**
     * Read, and optionally poll, the conversation snapshot.
     * @param {string} sessionId - session to read.
     * @param {boolean} poll - whether to refresh every few seconds.
     * @returns {[object, () => void]} latest state and a manual refresh.
     */
    function useCatState(sessionId, poll) {
      const [state, setState] = React.useState({ phase: 'loading', data: null, updatedAt: 0 })
      const [version, setVersion] = React.useState(0)
      React.useEffect(() => {
        let disposed = false
        const load = async () => {
          const data = await fetchState(sessionId)
          if (disposed) return
          if (data.ok === true) hideNestedTeamRows(data)
          if (data.ok === true) setState({ phase: 'ready', data, updatedAt: Date.now() })
          else setState({ phase: 'error', data, updatedAt: Date.now() })
        }
        load().catch(() => {})
        if (poll !== true) {
          return () => {
            disposed = true
          }
        }
        const timer = setInterval(() => {
          load().catch(() => {})
        }, 3000)
        return () => {
          disposed = true
          clearInterval(timer)
        }
      }, [sessionId, version, poll])
      return [state, () => setVersion((value) => value + 1)]
    }

    /** The panel body: the three sub-conversations, the current one marked. */
    function TeamsBody({ sessionId, t, openSession }) {
      const [state, refresh] = useCatState(sessionId, true)
      const data = state.data
      const ready = data !== null && data.ok === true
      const rows = (ready && Array.isArray(data.teams) ? data.teams : []).map((team) => {
        const current = ready && data.currentRole === team.role
        const clickable = team.sessionId !== '' && !current
        return h(
          'button',
          {
            key: team.role,
            type: 'button',
            title: clickable ? t('header.hint') : team.sessionId === '' ? t('panel.absent') : t('panel.current'),
            onClick: clickable ? () => openSession(team) : undefined,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              padding: '8px 10px',
              borderRadius: '8px',
              border: current
                ? '1px solid var(--dsw-alias-border-primary, rgba(127,127,127,0.35))'
                : '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.18))',
              background: 'var(--dsw-alias-bg-secondary, rgba(127,127,127,0.06))',
              color: 'var(--dsw-alias-label-primary, inherit)',
              font: 'inherit',
              textAlign: 'left',
              cursor: clickable ? 'pointer' : 'default',
              opacity: clickable || current ? 1 : 0.6,
              flex: '0 0 auto',
            },
          },
          h('span', {
            style: {
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: ROLE_DOT[team.role] || '#888',
              flex: '0 0 auto',
            },
          }),
          h(
            'span',
            { style: { flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
            h('span', { style: { fontSize: '12px', fontWeight: 600, lineHeight: '16px' } }, t(`role.${team.role}`)),
            h(
              'span',
              {
                style: {
                  fontSize: '11px',
                  lineHeight: '14px',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  color: 'var(--dsw-alias-label-tertiary, inherit)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              team.sessionId === '' ? '—' : shortSession(team.sessionId),
            ),
          ),
          h(
            'span',
            {
              style: {
                fontSize: '11px',
                lineHeight: '14px',
                color: current ? 'var(--dsw-alias-label-secondary, inherit)' : 'var(--dsw-alias-label-tertiary, inherit)',
                flex: '0 0 auto',
              },
            },
            statusText(team, t),
          ),
        )
      })
      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            padding: '12px',
            boxSizing: 'border-box',
            height: '100%',
            overflow: 'auto',
            color: 'var(--dsw-alias-label-primary, inherit)',
            fontSize: '12px',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
          h('strong', { style: { fontSize: '13px' } }, t('panel.title')),
          h(
            'button',
            {
              type: 'button',
              onClick: refresh,
              style: {
                font: 'inherit',
                fontSize: '11px',
                padding: '3px 8px',
                borderRadius: '6px',
                border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.25))',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary, inherit)',
                cursor: 'pointer',
              },
            },
            t('panel.refresh'),
          ),
        ),
        ready
          ? h(
              'div',
              {
                style: {
                  fontSize: '11px',
                  lineHeight: '15px',
                  color: 'var(--dsw-alias-label-tertiary, inherit)',
                  wordBreak: 'break-all',
                },
              },
              `${t('panel.workspace')}: ${data.workspace}`,
            )
          : null,
        state.phase === 'loading'
          ? h('div', { style: { color: 'var(--dsw-alias-label-tertiary, inherit)' } }, t('panel.loading'))
          : null,
        state.phase === 'error'
          ? h('div', { style: { color: 'var(--dsw-alias-label-tertiary, inherit)' } }, t('panel.notTeam'))
          : null,
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, rows),
        h(
          'div',
          {
            style: {
              marginTop: 'auto',
              paddingTop: '8px',
              fontSize: '11px',
              lineHeight: '16px',
              color: 'var(--dsw-alias-label-tertiary, inherit)',
            },
          },
          t('panel.hint'),
        ),
      )
    }

    /**
     * The sidebar nesting seat: a conversation that owns team children gets a
     * small disclosure chevron in its Session-row leading cell. Expanding it
     * shows the child conversations inline (a fixed panel anchored to the row)
     * and clicking one opens it, so team switching never leaves the sidebar.
     * @param {{ sessionId: string, t: Function, openTeam: Function }} props - owner props.
     */
    function NestSeat({ sessionId, t, openTeam }) {
      const [data, setData] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      const buttonRef = React.useRef(null)
      const panelRef = React.useRef(null)

      React.useEffect(() => {
        let cancelled = false
        const load = () => {
          fetchPeek(sessionId).then((next) => {
            if (!cancelled) setData(next)
          })
        }
        load()
        const timer = setInterval(load, PEEK_TTL)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [sessionId])

      const root =
        data !== null &&
        data.ok === true &&
        (data.kind === 'container' ||
          (data.kind === 'inline' && data.container === sessionId) ||
          (data.kind === 'folder' && (data.currentRole === 'root' || data.currentRole === undefined)))
      const teams =
        root && Array.isArray(data.teams)
          ? data.teams.filter((team) => typeof team.sessionId === 'string' && team.sessionId !== '')
          : []

      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          const panel = panelRef.current
          const button = buttonRef.current
          if (panel !== null && panel.contains(event.target)) return
          if (button !== null && button.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onScroll = () => setOpen(false)
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        window.addEventListener('scroll', onScroll, true)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
          window.removeEventListener('scroll', onScroll, true)
        }
      }, [open])

      if (!root || teams.length === 0) return null

      const toggle = () => {
        if (open) {
          setOpen(false)
          return
        }
        const rect = buttonRef.current === null ? null : buttonRef.current.getBoundingClientRect()
        if (rect !== null) setAnchor({ top: rect.bottom + 4, left: Math.max(8, rect.left - 8) })
        fetchPeek(sessionId).then((next) => setData(next))
        setOpen(true)
      }

      const rows = teams.map((team) =>
        h(
          'button',
          {
            key: team.role,
            type: 'button',
            title: t(`role.${team.role}`),
            onClick: () => {
              openTeam(team)
              setOpen(false)
            },
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              minHeight: '30px',
              padding: '4px 8px',
              border: 'none',
              borderRadius: '6px',
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary, inherit)',
              fontSize: '13px',
              lineHeight: '18px',
              textAlign: 'left',
              cursor: 'pointer',
              fontWeight: team.status === 'current' ? 600 : 400,
            },
          },
          h('span', {
            style: {
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: ROLE_DOT[team.role] ?? 'currentColor',
              flex: '0 0 auto',
            },
          }),
          h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t(`role.${team.role}`)),
          h(
            'span',
            {
              style: {
                flex: '0 0 auto',
                fontSize: '11px',
                color: 'var(--dsw-alias-label-tertiary, inherit)',
              },
            },
            statusText(team, t),
          ),
        ),
      )

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            ref: buttonRef,
            type: 'button',
            title: t(open ? 'nest.collapse' : 'nest.expand'),
            'aria-expanded': open,
            onClick: toggle,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '16px',
              height: '16px',
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: 'var(--dsw-alias-label-tertiary, inherit)',
              cursor: 'pointer',
              flex: '0 0 auto',
            },
          },
          h(
            'svg',
            {
              width: 12,
              height: 12,
              viewBox: '0 0 12 12',
              style: { transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' },
            },
            h('path', {
              d: 'M4 2 L8 6 L4 10',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.5,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            }),
          ),
        ),
        open && anchor !== null
          ? h(
              'div',
              {
                ref: panelRef,
                role: 'tree',
                style: {
                  position: 'fixed',
                  top: `${anchor.top}px`,
                  left: `${anchor.left}px`,
                  width: '216px',
                  zIndex: 1000,
                  padding: '4px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '2px',
                  background: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #1e1e1e))',
                  border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.25))',
                  borderRadius: '10px',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.32)',
                },
              },
              h(
                'div',
                {
                  style: {
                    padding: '4px 8px 2px',
                    fontSize: '11px',
                    lineHeight: '16px',
                    color: 'var(--dsw-alias-label-tertiary, inherit)',
                  },
                },
                t('nest.expand'),
              ),
              rows,
            )
          : null,
      )
    }

    /**
     * The conversation-header control. A container redirects into its Plan
     * child; a team conversation opens the sub-conversation panel once and
     * offers the always-available toggle.
     */
    function HeaderControl({ sessionId, t, openPanel, openTeam, remember }) {
      const [state] = useCatState(sessionId, false)
      const data = state.data
      React.useEffect(() => {
        if (data === null || data.ok !== true) return
        if (
          data.kind === 'container' ||
          (data.kind === 'inline' && data.currentRole === 'root') ||
          (data.kind === 'folder' && data.currentRole === 'root')
        ) {
          const plan = planTeam(data)
          if (plan !== undefined) openTeam(plan)
          return
        }
        remember(sessionId)
      }, [data, sessionId])
      if (
        data !== null &&
        data.ok === true &&
        (data.kind === 'container' ||
          (data.kind === 'inline' && data.currentRole === 'root') ||
          (data.kind === 'folder' && data.currentRole === 'root'))
      ) {
        return null
      }
      return h(
        'button',
        {
          type: 'button',
          title: t('header.hint'),
          onClick: () => openPanel(),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            height: '24px',
            padding: '0 8px',
            borderRadius: '6px',
            border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.25))',
            background: 'transparent',
            color: 'var(--dsw-alias-label-secondary, inherit)',
            fontSize: '12px',
            lineHeight: '16px',
            cursor: 'pointer',
            flex: '0 0 auto',
          },
        },
        t('header.label'),
      )
    }

    /**
     * The hero-row redirect: a fresh `cat-root` conversation has no rendered
     * header yet, so the New Session row carries the redirect instead.
     */
    function HeroRedirect({ sessionId, openTeam }) {
      const [state] = useCatState(sessionId, false)
      const data = state.data
      React.useEffect(() => {
        if (data === null || data.ok !== true) return
        if (data.kind !== 'container' && data.kind !== 'inline' && data.kind !== 'folder') return
        if (data.kind !== 'container' && data.currentRole !== 'root') return
        const plan = planTeam(data)
        if (plan !== undefined) openTeam(plan)
      }, [data, sessionId])
      if (data !== null && data.ok !== true) return null
      return h(
        'span',
        {
          role: 'status',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            height: '24px',
            padding: '0 8px',
            fontSize: '12px',
            lineHeight: '16px',
            color: 'var(--dsw-alias-label-tertiary, inherit)',
            whiteSpace: 'nowrap',
          },
        },
        state.phase === 'loading' ? '…' : 'cat-loop',
      )
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'uiWorkspace'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'cat-loop: dictionaries')
        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              title: () => t('tab.title'),
              guide: [
                {
                  id: 'teams',
                  order: 30,
                  title: () => t('guide.title'),
                  description: () => t('guide.description'),
                },
              ],
            }),
          'cat-loop: teams tab type',
        )

        /** Reveal the sub-conversation panel in the right column. */
        const openPanel = () => {
          try {
            ctx.sidebarRight.openTab(TAB_KIND)
          } catch (error) {
            console.warn('cat-loop: could not open the sub-conversation panel', error)
          }
        }
        /** Open one team conversation through its durable nested address. */
        const openTeam = (team) => openTeamConversation(ctx, team)

        /** Sessions whose panel was already opened once; a manual close stays closed. */
        const autoOpened = new Set()
        /** Open the panel once per team conversation, retrying until it is mounted. */
        const remember = (sessionId) => {
          if (autoOpened.has(sessionId)) return
          autoOpened.add(sessionId)
          let attempts = 0
          const attempt = () => {
            attempts += 1
            try {
              if (ctx.sidebarRight.mounted.getSnapshot() === sessionId) {
                ctx.sidebarRight.openTab(TAB_KIND)
                return
              }
            } catch (error) {
              console.warn('cat-loop: right column not ready', error)
            }
            if (attempts < 8) setTimeout(attempt, 250)
          }
          setTimeout(attempt, 200)
        }

        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: TAB_ID,
                  locale: NS,
                  inject: () => ({ openSession: openTeam }),
                },
                TeamsBody,
              ),
            ),
          'cat-loop: teams tab body',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('conversation.session.header.actions', () =>
              ctx.slots.register(
                {
                  name: 'conversation.session.header.actions',
                  id: 'cat-loop-teams',
                  order: 20,
                  locale: NS,
                  inject: () => ({ openPanel, openTeam, remember }),
                },
                HeaderControl,
              ),
            ),
          'cat-loop: conversation header control',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('conversation.hero.options', () =>
              ctx.slots.register(
                {
                  name: 'conversation.hero.options',
                  id: 'cat-loop-contains',
                  order: 20,
                  locale: NS,
                  inject: () => ({ openTeam }),
                },
                HeroRedirect,
              ),
            ),
          'cat-loop: hero redirect',
        )

        // Sidebar nesting: a conversation that owns team sub-conversations gets
        // a disclosure chevron in its Session row and expands them inline.
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.session.row.leading', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.session.row.leading',
                  id: 'cat-loop-nest',
                  order: 20,
                  locale: NS,
                  inject: () => ({ openTeam }),
                },
                NestSeat,
              ),
            ),
          'cat-loop: sidebar nesting seat',
        )
      },
    }
  },
})
