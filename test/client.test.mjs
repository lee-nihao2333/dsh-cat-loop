/**
 * cat-loop Client half — registration wiring smoke test.
 *
 * The browser artifact cannot run in Node as-is, so this test stubs the module
 * loader and React: it captures the factory, invokes `apply()` against a fake
 * Client context, and renders the registered components once with hooks reduced
 * to their initial values. That proves the module declares the services it
 * needs, registers the tab type, the header control and the hero redirect, ships
 * both dictionaries, and draws text through the translate function.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** Minimal React stand-in: elements are plain trees, hooks keep initial state. */
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useRef(value) {
    return { current: value }
  },
  useMemo(factory) {
    return factory()
  },
  useCallback(callback) {
    return callback
  },
}

/** Load the browser artifact with a capture-only module loader. */
function loadClient() {
  const captured = { options: undefined }
  const window = {
    __ModuleLoader__: {
      load(options) {
        captured.options = options
      },
    },
  }
  // eslint-disable-next-line no-new-func -- the artifact is a browser global script, not a module.
  new Function('window', source)(window)
  assert.ok(captured.options, 'client.js must register a module')
  return captured.options
}

/** Collect every string in a rendered element tree. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(textOf)
  if (typeof node === 'object' && Array.isArray(node.children)) return node.children.flatMap(textOf)
  return []
}

/** Fake Client context recording every registration. */
function fakeClient() {
  const state = { locale: undefined, tab: undefined, registrations: [], injections: [], opened: [] }
  const ctx = {
    effect(register) {
      const dispose = register()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      bind: () => (key) => key,
      register: (namespace, dicts) => {
        state.locale = { namespace, dicts }
        return () => {}
      },
    },
    sidebarRightTabs: {
      register: (definition) => {
        state.tab = definition
        return () => {}
      },
    },
    slots: {
      inject: (slot, callback) => {
        state.injections.push(slot)
        callback()
        return () => {}
      },
      register: (options, component) => {
        state.registrations.push({ options, component })
        return () => {}
      },
    },
    sidebarRight: { mounted: { getSnapshot: () => undefined }, openTab() {} },
    uiWorkspace: {
      openSession: (target) => state.opened.push(target),
    },
  }
  return { ctx, state }
}

/** The factory of the registered browser module, with React required. */
function moduleOf(options) {
  return options.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${JSON.stringify(name)})`)
  })
}

test('the client half declares the services it reads', () => {
  const options = loadClient()
  assert.equal(options.id, '@marvinlee2011/dsh-cat-loop')
  assert.deepEqual(moduleOf(options).inject, ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'uiWorkspace'])
})

test('apply registers the tab, the header control, the hero redirect and both dictionaries', () => {
  const { ctx, state } = fakeClient()
  moduleOf(loadClient()).apply(ctx)

  assert.equal(state.locale.namespace, 'catLoop')
  assert.equal(state.locale.dicts.zh['panel.title'], '子对话')
  assert.equal(state.locale.dicts.en['panel.title'], 'Sub-conversations')

  assert.equal(state.tab.id, 'cat-loop/teams')
  assert.equal(state.tab.kind, 'cat-loop-teams')
  assert.equal(state.tab.title(), 'tab.title')
  assert.deepEqual(
    state.tab.guide.map((entry) => entry.id),
    ['teams'],
  )

  assert.deepEqual(state.injections, [
    'sidebar.right.pane.tab',
    'conversation.session.header.actions',
    'conversation.hero.options',
    'sidebar.session.row.leading',
  ])
  const body = state.registrations.find((registration) => registration.options.name === 'sidebar.right.pane.tab')
  const header = state.registrations.find((registration) => registration.options.name === 'conversation.session.header.actions')
  const hero = state.registrations.find((registration) => registration.options.name === 'conversation.hero.options')
  assert.ok(body, 'the panel body registers into the right sidebar')
  assert.ok(header, 'the header control registers into the conversation header')
  assert.ok(hero, 'the hero redirect registers into the New Session row')
  assert.equal(body.options.key, 'cat-loop/teams')
  assert.equal(header.options.id, 'cat-loop-teams')
  assert.equal(hero.options.id, 'cat-loop-contains')
  assert.equal(body.options.locale, 'catLoop')

  // The body renders through the translate function and starts loading.
  const bodyText = textOf(body.component({ sessionId: 'session-a', t: (key) => key, openSession() {} }))
  assert.ok(bodyText.includes('panel.title'))
  assert.ok(bodyText.includes('panel.hint'))
  assert.ok(bodyText.includes('panel.loading'))

  // The header control offers the manual toggle while its snapshot is pending.
  const headerText = textOf(
    header.component({
      sessionId: 'session-a',
      t: (key) => key,
      openPanel() {},
      openTeam() {},
      remember() {},
    }),
  )
  assert.ok(headerText.includes('header.label'))

  // The hero redirect renders a neutral status while its snapshot is pending.
  const heroText = textOf(hero.component({ sessionId: 'session-a', openTeam() {} }))
  assert.ok(heroText.includes('…'))

  // Opening a team row goes through the durable nested address.
  const injected = body.options.inject()
  injected.openSession({ sessionId: 'session-build', parentSessionId: 'session-container', mode: 'continuable' })
  assert.deepEqual(state.opened, [
    { parentSessionId: 'session-container', childSessionId: 'session-build', mode: 'continuable' },
  ])
})
