/**
 * Renders the client half of the test-live panel in Node, with a hand-rolled
 * React stand-in. The bundle is a plain `window.__ModuleLoader__.load` factory
 * with no build step, so we can capture the factory, call `apply`, and render
 * the component it registers — no DOM, no browser, no bundler.
 *
 * What this locks down (the "platform log" contract):
 *   - scope defaults to "all": runs from two different conversations are listed;
 *   - "本对话" narrows the list to the injected sessionId (one run);
 *   - the conversation dropdown shows human labels (or a short-id fallback);
 *   - `props` may be undefined, `sessions` may be empty, fetch may fail.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

// ---------------------------------------------------------------------------
// Fixtures: three runs across two conversations.
// ---------------------------------------------------------------------------

const RUN_A1 = {
  id: 'run_a1',
  status: 'passed',
  kind: 'test',
  command: 'go',
  args: ['test', './...'],
  cwd: '/home/chenyang/opt/dsh-test-live',
  sessionId: 'ses_aaaa1111',
  sessionLabel: '重构 runner',
  durationMs: 1234,
  lastSeq: 42,
  truncated: false,
  summary: {
    packages: { ok: ['pkg/a', 'pkg/b', 'pkg/c'], fail: [], noTest: [] },
    tests: { pass: 5, fail: 0, skip: 1 },
    buildErrors: [],
  },
}

const RUN_B1 = {
  id: 'run_b1',
  status: 'failed',
  kind: 'test',
  command: 'go',
  args: ['test', './...'],
  cwd: '/tmp/other-proj',
  sessionId: 'ses_bbbb2222',
  sessionLabel: null,
  durationMs: 2400,
  lastSeq: 11,
  truncated: false,
  summary: {
    packages: { ok: ['pkg/x', 'pkg/y'], fail: ['pkg/z'], noTest: [] },
    tests: { pass: 3, fail: 2, skip: 0 },
    buildErrors: [],
  },
}

const RUN_B2 = {
  id: 'run_b2',
  status: 'canceled',
  kind: 'test',
  command: 'go',
  args: ['test', './...'],
  cwd: '/tmp/other-proj',
  sessionId: 'ses_bbbb2222',
  sessionLabel: null,
  archived: true,
  durationMs: 800,
  lastSeq: 4,
  truncated: false,
  summary: {
    packages: { ok: ['pkg/x', 'pkg/y'], fail: [], noTest: [] },
    tests: { pass: 0, fail: 0, skip: 0 },
    buildErrors: [],
  },
}

const ALL_RUNS = [RUN_A1, RUN_B1, RUN_B2]

const SESSIONS = [
  { id: 'ses_aaaa1111', label: '重构 runner', cwd: '/home/chenyang/opt/dsh-test-live', count: 1 },
  { id: 'ses_bbbb2222', label: '', cwd: '/tmp/other-proj', count: 2 },
]

const INJECTED_SESSION = 'ses_aaaa1111'

// ---------------------------------------------------------------------------
// Minimal React: createElement + the four hooks the panel uses.
// ---------------------------------------------------------------------------

/** Structural equality, as React compares hook dependency lists. */
function sameDeps(a, b) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false
  return true
}

/** `React.createElement`, flattened the way the panel builds trees. */
function createElement(type, props, ...children) {
  const next = { ...(props || {}) }
  if (children.length === 1) next.children = children[0]
  else if (children.length > 1) next.children = children
  return { type, props: next }
}

/**
 * Build the fake React surface bound to one hook store.
 * @param store - { slots, cursor, effects, dirty }
 */
function createReact(store) {
  return {
    createElement,
    useState(initial) {
      const index = store.cursor++
      if (!store.slots[index]) {
        store.slots[index] = {
          kind: 'state',
          value: typeof initial === 'function' ? initial() : initial,
        }
      }
      const slot = store.slots[index]
      const setValue = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return // React bails out on an equal state
        slot.value = value
        store.dirty = true
      }
      return [slot.value, setValue]
    },
    useRef(initial) {
      const index = store.cursor++
      if (!store.slots[index]) store.slots[index] = { kind: 'ref', value: { current: initial } }
      return store.slots[index].value
    },
    useCallback(fn, deps) {
      const index = store.cursor++
      const slot = store.slots[index]
      if (!slot) {
        store.slots[index] = { kind: 'callback', fn, deps }
        return fn
      }
      if (!sameDeps(slot.deps, deps)) {
        slot.fn = fn
        slot.deps = deps
      }
      return slot.fn
    },
    useMemo(fn, deps) {
      const index = store.cursor++
      const slot = store.slots[index]
      if (!slot || !sameDeps(slot.deps, deps)) {
        const value = fn()
        store.slots[index] = { kind: 'memo', value, deps }
        return value
      }
      return slot.value
    },
    useEffect(fn, deps) {
      const index = store.cursor++
      const slot = store.slots[index]
      const shouldRun = !slot || deps === undefined || !sameDeps(slot.deps, deps)
      if (!slot) store.slots[index] = { kind: 'effect', fn, deps: deps || null, cleanup: null }
      else {
        slot.fn = fn
        slot.deps = deps === undefined ? null : deps
      }
      if (shouldRun) store.effects.push(store.slots[index])
    },
  }
}

// ---------------------------------------------------------------------------
// Tree helpers.
// ---------------------------------------------------------------------------

/** Resolve function components into a plain host-node tree. */
function expand(node) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string') return { type: '#text', text: node }
  if (typeof node === 'number') return { type: '#text', text: String(node) }
  if (Array.isArray(node)) return node.map(expand).flat(Infinity).filter((child) => child !== null)
  if (typeof node.type === 'function') return expand(node.type(node.props))
  const children = node.props && node.props.children !== undefined ? expand(node.props.children) : null
  return {
    type: node.type,
    props: node.props || {},
    children: children === null ? [] : Array.isArray(children) ? children : [children],
  }
}

/** All text below a node. */
function textOf(node) {
  if (!node) return ''
  if (node.type === '#text') return node.text
  return (node.children || []).map(textOf).join('')
}

/** Depth-first visit. */
function walk(node, visit) {
  if (!node) return
  visit(node)
  for (const child of node.children || []) walk(child, visit)
}

/** Every host node matching a predicate. */
function findAll(tree, predicate) {
  const found = []
  walk(tree, (node) => {
    if (node.type !== '#text' && predicate(node)) found.push(node)
  })
  return found
}

/** Elements carrying one CSS class. */
function byClass(tree, className) {
  return findAll(tree, (node) => String(node.props.className || '').split(/\s+/).includes(className))
}

/** The single button whose text is exactly `label`. */
function buttonByText(tree, label) {
  const matches = findAll(tree, (node) => node.type === 'button' && textOf(node).trim() === label)
  assert.equal(matches.length, 1, `expected exactly one button "${label}", got ${matches.length}`)
  return matches[0]
}

// ---------------------------------------------------------------------------
// Fake browser: window, document, localStorage, EventSource, fetch.
// ---------------------------------------------------------------------------

const storage = new Map()
const styleNodes = []
let captured = null

const fakeDocument = {
  head: {
    appendChild(node) {
      styleNodes.push(node)
    },
  },
  getElementById() {
    return null
  },
  createElement(tag) {
    return { tag, id: '', textContent: '' }
  },
  documentElement: {
    setAttribute(name, value) {
      // apply() reports a failure here; a test that trips it should see it.
      throw new Error(`client apply() failed: ${name}=${value}`)
    },
  },
}

globalThis.document = fakeDocument
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec
    },
  },
  localStorage: {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null
    },
    setItem(key, value) {
      storage.set(key, String(value))
    },
    removeItem(key) {
      storage.delete(key)
    },
  },
  console: { warn() {} },
  open() {},
}

class FakeEventSource {
  constructor(url) {
    this.url = url
    this.closed = false
    FakeEventSource.instances.push(this)
  }
  addEventListener() {}
  close() {
    this.closed = true
  }
}
FakeEventSource.instances = []
globalThis.EventSource = FakeEventSource

// The panel polls every 2.5s; the stub keeps the render deterministic (and stops
// the process from being kept alive). setTimeout stays real for the flush below.
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

/** One fake host: runs, sessions, scope filtering, POST bookkeeping. */
function createServer(options = {}) {
  const world = {
    runs: options.runs || ALL_RUNS,
    sessions: options.sessions === undefined ? SESSIONS : options.sessions,
    defaultScope: options.defaultScope || 'all',
    fail: Boolean(options.fail),
    gets: [],
    posts: [],
  }
  const ok = (body) => ({ ok: true, status: 200, json: async () => body })
  const bad = (status, error) => ({ ok: false, status, json: async () => ({ error }) })

  world.handle = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl, 'http://host.test')
    const method = (init.method || 'GET').toUpperCase()
    if (method !== 'GET') {
      const body = init.body ? JSON.parse(init.body) : null
      world.posts.push({ path: url.pathname, body })
      if (url.pathname === '/test-live/run') {
        return ok({
          ...RUN_A1,
          id: 'run_new1',
          status: 'running',
          durationMs: undefined,
          startedAt: Date.now(),
          summary: null,
          sessionId: body && body.sessionId ? body.sessionId : null,
        })
      }
      if (url.pathname === '/test-live/follow') {
        return ok({
          ...RUN_B2,
          id: 'run_file1',
          kind: 'file',
          file: '/home/chenyang/opt/dsh-test-live/fulltest.log',
          buffered: 49,
          status: 'running',
          archived: false,
          summary: null,
        })
      }
      return bad(404, `unknown route ${url.pathname}`)
    }
    world.gets.push({ path: url.pathname, query: url.search })
    if (world.fail) return bad(500, '宿主未响应')
    if (url.pathname !== '/test-live/runs') return bad(404, `unknown route ${url.pathname}`)
    const scope = url.searchParams.get('scope') === 'session' ? 'session' : 'all'
    const sessionId = url.searchParams.get('sessionId')
    const runs =
      scope === 'session' && sessionId
        ? world.runs.filter((item) => item.sessionId === sessionId)
        : world.runs.slice()
    const sessions = world.sessions.map((item) => ({ ...item }))
    return ok({ runs, sessions, scope, defaultScope: world.defaultScope })
  }
  return world
}

/** Install a fetch bound to one fake host, resetting the call log. */
function useServer(world) {
  globalThis.fetch = (url, init) => world.handle(url, init)
  return world
}

// ---------------------------------------------------------------------------
// Capture the module factory once; each test builds its own component from it.
// ---------------------------------------------------------------------------

await import(new URL('../src/client/index.js', import.meta.url).href)
assert.ok(captured && typeof captured.factory === 'function', 'window.__ModuleLoader__.load must receive a factory')
assert.equal(captured.id, 'dsh-test-live')

/**
 * Create one panel instance: fresh module exports, fresh hooks, own tree.
 * @param props - the slot props (may be undefined, as the host sometimes sends).
 */
function createPanel(props) {
  const host = { slots: [], dirty: false, cursor: 0 }
  const React = createReact(host)
  const module = captured.factory((name) => {
    if (name === 'react') return React
    throw new Error(`client require() of an unsupported module: ${name}`)
  })
  const registered = { component: null, tabs: [] }
  module.apply({
    sidebarRightTabs: {
      register(entry) {
        registered.tabs.push(entry)
      },
    },
    slots: {
      inject(name, callback) {
        callback()
      },
      register(config, component) {
        registered.component = component
        return { dispose() {} }
      },
    },
  })
  assert.ok(typeof registered.component === 'function', 'apply() must register the panel body into sidelbar.right.pane.tab')
  assert.equal(registered.tabs[0].id, 'dsh-test-live')

  /**
   * Render, run effects, let promises land, repeat until the tree is stable.
   * Returns the resolved host-node tree.
   */
  async function settle(maxPasses = 40) {
    host.dirty = true
    let tree = null
    for (let pass = 0; pass < maxPasses; pass += 1) {
      if (!host.dirty) break
      host.dirty = false
      host.cursor = 0
      host.effects = []
      const effects = host.effects
      const raw = registered.component(props)
      tree = expand(raw)
      for (const slot of effects) {
        if (typeof slot.cleanup === 'function') slot.cleanup()
        const cleanup = slot.fn()
        slot.cleanup = typeof cleanup === 'function' ? cleanup : null
      }
      // Let fetch promises, .then chains and the state updates inside them land.
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return tree
  }

  return { settle, module }
}

/** Fresh browser storage for one test. */
function resetStorage() {
  storage.clear()
  styleNodes.length = 0
  FakeEventSource.instances.length = 0
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

test('默认 scope=all：两个对话的 3 条 run 全部列出，切「本对话」后只剩 1 条', async () => {
  resetStorage()
  const world = useServer(createServer())
  const panel = createPanel({ sessionId: INJECTED_SESSION })

  let tree = await panel.settle()

  // --- default view ------------------------------------------------------
  assert.equal(world.gets.length >= 1, true, 'the panel must load the run list on mount')
  assert.equal(world.gets[0].path, '/test-live/runs')
  assert.match(world.gets[0].query, /[?&]scope=all/)

  const chips = byClass(tree, 'dtl-run')
  assert.equal(chips.length, 3, 'scope=all must list the runs of both conversations')

  const chipText = chips.map(textOf)
  assert.ok(
    chipText.some((text) => text.includes('重构 runner · dsh-test-live')),
    'run chip must show 对话标签 · cwd 末段, saw: ' + JSON.stringify(chipText),
  )
  assert.ok(
    chipText.some((text) => text.includes('对话 bbbb2222 · other-proj')),
    'an unnamed conversation must fall back to 对话 <短id>, saw: ' + JSON.stringify(chipText),
  )
  // status / package count / duration survive the change
  assert.ok(chipText.some((text) => /通过 · 3 包 · 1\.2s/.test(text)), 'status+包数+耗时 must stay on the chip')
  // archived runs are tagged, and only those
  assert.equal(chips.filter((chip) => textOf(chip).includes('历史')).length, 1, 'only the archived run is tagged 历史')
  assert.equal(chips.find((chip) => textOf(chip).includes('历史')).props['data-archived'], 'true')

  // --- conversation dropdown --------------------------------------------
  const selects = findAll(tree, (node) => node.type === 'select')
  assert.equal(selects.length, 1, 'a session dropdown appears when the host returns more than one session')
  const options = findAll(tree, (node) => node.type === 'option').map(textOf)
  assert.deepEqual(options, ['全部对话', '重构 runner · 1 条', '对话 bbbb2222 · 2 条'])

  // both scope controls are there
  assert.ok(buttonByText(tree, '全部'))
  assert.ok(buttonByText(tree, '本对话'))

  // --- meta line ---------------------------------------------------------
  assert.ok(
    textOf(tree).includes('对话 重构 runner · /home/chenyang/opt/dsh-test-live · run_a1 · 1.2s'),
    'meta line must read 对话 <label> · <cwd> · <id> · 耗时',
  )

  // --- switch to 本对话 ---------------------------------------------------
  buttonByText(tree, '本对话').props.onClick()
  tree = await panel.settle()

  const sessionFetch = world.gets[world.gets.length - 1]
  assert.match(sessionFetch.query, /[?&]scope=session/)
  assert.match(sessionFetch.query, new RegExp('[?&]sessionId=' + INJECTED_SESSION))

  const narrowed = byClass(tree, 'dtl-run')
  assert.equal(narrowed.length, 1, '本对话 must show only this conversation, got ' + JSON.stringify(narrowed.map(textOf)))
  assert.ok(textOf(narrowed[0]).includes('重构 runner'))
  assert.equal(findAll(tree, (node) => node.type === 'select')[0].props.value, INJECTED_SESSION)
  assert.equal(JSON.parse(storage.get('dsh-test-live:scope')), 'session', 'the chosen scope is persisted')
  assert.equal(FakeEventSource.instances.length >= 2, true, 'switching views rebinds the stream')

  // and back to 全部
  buttonByText(tree, '全部').props.onClick()
  tree = await panel.settle()
  assert.equal(byClass(tree, 'dtl-run').length, 3)
  assert.equal(JSON.parse(storage.get('dsh-test-live:scope')), 'all')
})

test('下拉选某个对话：按该对话取数，第二行/落盘都跟着走', async () => {
  resetStorage()
  const world = useServer(createServer())
  const panel = createPanel({ sessionId: INJECTED_SESSION })
  let tree = await panel.settle()

  const select = findAll(tree, (node) => node.type === 'select')[0]
  select.props.onChange({ target: { value: 'ses_bbbb2222' } })
  tree = await panel.settle()

  const fetch = world.gets[world.gets.length - 1]
  assert.match(fetch.query, /[?&]scope=session/)
  assert.match(fetch.query, /[?&]sessionId=ses_bbbb2222/)
  assert.equal(byClass(tree, 'dtl-run').length, 2, 'the picked conversation has two runs')
  assert.equal(findAll(tree, (node) => node.type === 'select')[0].props.value, 'ses_bbbb2222')

  // the select empties out on 全部, which keeps the control controlled
  findAll(tree, (node) => node.type === 'select')[0].props.onChange({ target: { value: '' } })
  tree = await panel.settle()
  assert.equal(findAll(tree, (node) => node.type === 'select')[0].props.value, '')
  assert.equal(byClass(tree, 'dtl-run').length, 3)
})

test('POST /run 与 /follow 都带上本对话的 sessionId', async () => {
  resetStorage()
  const world = useServer(createServer())
  const panel = createPanel({ sessionId: INJECTED_SESSION })
  let tree = await panel.settle()

  buttonByText(tree, '运行').props.onClick()
  tree = await panel.settle()
  const runPost = world.posts.find((post) => post.path === '/test-live/run')
  assert.ok(runPost, '运行 must POST /test-live/run')
  assert.equal(runPost.body.sessionId, INJECTED_SESSION)
  assert.deepEqual(runPost.body.packages, ['./...'])

  const followInput = findAll(
    tree,
    (node) => node.type === 'input' && node.props.placeholder === '跟随日志文件（如 fulltest.log）',
  )[0]
  followInput.props.onChange({ target: { value: 'fulltest.log' } })
  tree = await panel.settle()
  buttonByText(tree, '跟随').props.onClick()
  tree = await panel.settle()

  const followPost = world.posts.find((post) => post.path === '/test-live/follow')
  assert.ok(followPost, '跟随 must POST /test-live/follow')
  assert.equal(followPost.body.sessionId, INJECTED_SESSION)
  assert.equal(followPost.body.path, 'fulltest.log')
})

test('降级一：props 为 undefined 时不崩，只列全部（没有本对话/下拉）', async () => {
  resetStorage()
  const world = useServer(createServer())
  const panel = createPanel(undefined)

  const tree = await panel.settle()

  assert.equal(byClass(tree, 'dtl-run').length, 3, 'without a sessionId the panel still lists every run')
  assert.equal(findAll(tree, (node) => node.type === 'button' && textOf(node) === '本对话').length, 0)
  assert.doesNotMatch(world.gets[0].query, /sessionId=/, 'no sessionId is invented')
  // no run bound is a non-event: the first run still opens
  assert.ok(textOf(tree).includes('run_a1'))
})

test('降级二：sessions 为空时不出下拉，列表照常', async () => {
  resetStorage()
  useServer(createServer({ sessions: [] }))
  const panel = createPanel({ sessionId: INJECTED_SESSION })

  const tree = await panel.settle()

  assert.equal(findAll(tree, (node) => node.type === 'select').length, 0, 'no dropdown with a single/absent session')
  assert.equal(byClass(tree, 'dtl-run').length, 3)
  // the chips still get a label from the run itself
  assert.ok(textOf(tree).includes('重构 runner'))
  // 本对话 is still offered: the injected sessionId is enough
  assert.ok(buttonByText(tree, '本对话'))
})

test('降级三：fetch 失败显示宿主错误、给空状态，不崩', async () => {
  resetStorage()
  useServer(createServer({ fail: true }))
  const panel = createPanel({ sessionId: INJECTED_SESSION })

  const tree = await panel.settle()

  const errors = byClass(tree, 'dtl-error').map(textOf)
  assert.deepEqual(errors, ['宿主未响应'])
  assert.equal(byClass(tree, 'dtl-run').length, 0)
  const empty = byClass(tree, 'dtl-empty').map(textOf).join('\n')
  assert.ok(empty.includes('还没有运行记录'), 'empty state still renders: ' + empty)
  assert.ok(
    empty.includes('这里汇总所有对话的测试记录：别的对话里跑完的测试也会出现在这里。'),
    'the empty state must explain that other conversations show up here',
  )
})

test('空列表：文案说明这里是跨对话汇总', async () => {
  resetStorage()
  useServer(createServer({ runs: [] }))
  const panel = createPanel({ sessionId: INJECTED_SESSION })

  const tree = await panel.settle()

  assert.equal(byClass(tree, 'dtl-run').length, 0)
  const empty = byClass(tree, 'dtl-empty').map(textOf).join('\n')
  assert.ok(empty.includes('别的对话里跑完的测试也会出现在这里'))
})

test('首屏没有存储偏好时采用响应里的 defaultScope', async () => {
  resetStorage()
  const world = useServer(createServer({ defaultScope: 'session' }))
  const panel = createPanel({ sessionId: INJECTED_SESSION })

  const tree = await panel.settle()

  const last = world.gets[world.gets.length - 1]
  assert.match(last.query, /[?&]scope=session/, 'the host default view is adopted on first screen')
  assert.match(last.query, new RegExp('sessionId=' + INJECTED_SESSION))
  assert.equal(byClass(tree, 'dtl-run').length, 1)
  assert.equal(storage.has('dsh-test-live:scope'), false, 'an adopted default is not persisted as a user choice')
})

test('已存储的 scope 优先于 defaultScope', async () => {
  resetStorage()
  storage.set('dsh-test-live:scope', JSON.stringify('all'))
  const world = useServer(createServer({ defaultScope: 'session' }))
  const panel = createPanel({ sessionId: INJECTED_SESSION })

  const tree = await panel.settle()

  assert.match(world.gets[world.gets.length - 1].query, /[?&]scope=all/)
  assert.equal(byClass(tree, 'dtl-run').length, 3)
})
