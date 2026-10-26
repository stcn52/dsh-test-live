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

/** The <option> children of one <select>. */
function optionsOf(select) {
  return (select.children || []).filter((node) => node.type === 'option')
}

/** The one node carrying `data-role`, or undefined. */
function byRole(tree, role) {
  return findAll(tree, (node) => node.props['data-role'] === role)[0]
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
    // null = the pre-runner host: GET /runners is not a route at all (404).
    runners: options.runners === undefined ? null : options.runners,
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
        // Echo what the host would resolve: `auto` becomes a concrete runner,
        // and `detectReason` is the marker a run was detected, not picked.
        const asked = body && body.runner ? body.runner : null
        const resolved = asked === 'auto' ? 'go' : asked
        return ok({
          ...RUN_A1,
          id: 'run_new1',
          status: 'running',
          durationMs: undefined,
          startedAt: Date.now(),
          summary: null,
          runner: resolved || undefined,
          runnerLabel: resolved ? 'Go 测试' : undefined,
          detectReason: resolved && asked === 'auto' ? 'go.mod' : undefined,
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
    if (url.pathname === '/test-live/runners') {
      if (world.runners === null) return bad(404, 'unknown route /test-live/runners')
      return ok(world.runners)
    }
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

/**
 * The newest GET of one path. The panel probes /runners besides the run list,
 * so "the last request" is not the same thing as "the last run-list request".
 */
function lastGet(world, path = '/test-live/runs') {
  const hits = world.gets.filter((entry) => entry.path === path)
  return hits[hits.length - 1]
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

  const sessionFetch = lastGet(world)
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

  const fetch = lastGet(world)
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

  const last = lastGet(world)
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

  assert.match(lastGet(world).query, /[?&]scope=all/)
  assert.equal(byClass(tree, 'dtl-run').length, 3)
})

// ---------------------------------------------------------------------------
// Runner descriptors.
//
// The fixtures mirror what host-api2 serves from runnerCatalog(): a deliberately
// small projection (id, label, language, selectionPlaceholder, flags, labels,
// available, reason). `selection.mode` and `separator` are optional extras, so
// both spellings are exercised below.
// ---------------------------------------------------------------------------

/** A vitest run: new `suites` bucket, its own runner, file-oriented labels. */
const RUN_V1 = {
  id: 'run_v1',
  status: 'passed',
  kind: 'test',
  command: 'pnpm',
  args: ['exec', 'vitest', 'run', 'tests/'],
  cwd: '/home/chenyang/opt/dsh-test-live',
  sessionId: 'ses_aaaa1111',
  sessionLabel: '重构 runner',
  durationMs: 900,
  lastSeq: 7,
  truncated: false,
  runner: 'vitest',
  runnerLabel: 'Vitest',
  summary: {
    suites: { ok: ['tests/a.test.js', 'tests/b.test.js'], fail: [], noTest: [] },
    tests: { pass: 4, fail: 0, skip: 0 },
    buildErrors: [],
  },
}

const RUNNERS = {
  defaultRunner: 'auto',
  allowScriptRunners: false,
  runners: [
    {
      id: 'go',
      label: 'Go 测试',
      language: 'go',
      selectionPlaceholder: './...',
      flags: [
        { id: 'verbose', label: '-v', argv: ['-v'], default: true },
        { id: 'race', label: '-race', argv: ['-race'] },
        { id: 'count', label: '-count=1', argv: ['-count=1'] },
      ],
      labels: { suite: '包' },
      available: true,
    },
    {
      id: 'vitest',
      label: 'Vitest',
      language: 'javascript',
      selectionPlaceholder: 'tests/',
      hint: '逗号分隔，写 tests/ 下的文件路径',
      flags: [{ id: 'verbose', label: '--reporter=verbose', argv: ['--reporter=verbose'], default: true }],
      labels: { suite: '文件' },
      available: true,
    },
    {
      id: 'pytest',
      label: 'pytest',
      language: 'python',
      selectionPlaceholder: 'tests/',
      hint: '支持 path::test 与 -k 模式',
      flags: [{ id: 'verbose', label: '-v', argv: ['-v'], default: true }],
      labels: { suite: '用例' },
      available: false,
      reason: 'python3 不在 PATH',
    },
    {
      id: 'script',
      label: 'npm script',
      language: 'javascript',
      // No target syntax at all: the panel must hide the whole target row.
      selectionMode: 'none',
      selectionPlaceholder: null,
      flags: [],
      labels: { suite: '用例' },
      available: false,
      reason: '未开启 allowScriptRunners',
    },
  ],
}

/** The same catalogue with the script runner allowed and used as the default. */
const SCRIPT_RUNNERS = {
  defaultRunner: 'script',
  allowScriptRunners: true,
  runners: [
    {
      id: 'script',
      label: 'npm script',
      language: 'javascript',
      selection: { mode: 'none' },
      flags: [],
      labels: { suite: '用例' },
      available: true,
    },
  ],
}

/** A runner whose descriptor forgot `labels`: the pre-runner wording must survive. */
const NO_LABELS_RUNNERS = {
  defaultRunner: 'vitest',
  runners: [
    {
      id: 'vitest',
      label: 'Vitest',
      language: 'javascript',
      selectionPlaceholder: 'tests/',
      flags: [],
      available: true,
    },
  ],
}

/** defaultRunner is a concrete runner, and its separator is a semicolon. */
const GO_SEMI_RUNNERS = {
  defaultRunner: 'go',
  runners: [
    {
      id: 'go',
      label: 'Go 测试',
      language: 'go',
      selectionPlaceholder: './...',
      separator: ';',
      flags: [{ id: 'verbose', label: '-v', argv: ['-v'], default: true }],
      labels: { suite: '包' },
      available: true,
    },
  ],
}

test('降级一：旧宿主没有 /runners，面板保持旧布局，POST 仍只发旧字段', async () => {
  resetStorage()
  // No `runners` option: GET /runners is a 404, exactly like today's host.
  const world = useServer(createServer())
  const panel = createPanel({ sessionId: INJECTED_SESSION })
  let tree = await panel.settle()

  assert.ok(world.gets.some((entry) => entry.path === '/test-live/runners'), 'the panel probes /runners')
  assert.equal(byRole(tree, 'runner'), undefined, 'no runner dropdown without a catalogue')
  assert.equal(findAll(tree, (node) => node.props['data-flag']).length, 0, 'no descriptor flags without a catalogue')
  // the pre-runner controls are all still there
  assert.equal(byRole(tree, 'targets').props.placeholder, './...')
  assert.ok(textOf(tree).includes('-v'), 'the hardcoded -v checkbox survives')
  assert.equal(byClass(tree, 'dtl-error').length, 0, 'a missing /runners is not an error for the user')
  assert.equal(byClass(tree, 'dtl-run').length, 3, 'the run list still loads')

  buttonByText(tree, '运行').props.onClick()
  tree = await panel.settle()
  const post = world.posts.find((entry) => entry.path === '/test-live/run')
  // Byte-for-byte the old body: no runner, no flags, no targets.
  assert.deepEqual(post.body, { packages: ['./...'], verbose: true, sessionId: INJECTED_SESSION })
})

test('降级一之二：runners 为空数组时同样退回旧布局', async () => {
  resetStorage()
  const world = useServer(createServer({ runners: [] }))
  const panel = createPanel({ sessionId: INJECTED_SESSION })
  const tree = await panel.settle()

  assert.ok(world.gets.some((entry) => entry.path === '/test-live/runners'))
  assert.equal(byRole(tree, 'runner'), undefined, 'an empty catalogue is the same non-event as a 404')
  assert.equal(byRole(tree, 'targets').props.placeholder, './...')
  assert.equal(findAll(tree, (node) => node.type === 'select').length, 1, 'only the conversation dropdown remains')
})

test('runner 下拉：自动识别默认选中，available:false 置灰带原因，选择落 localStorage', async () => {
  resetStorage()
  useServer(createServer({ runners: RUNNERS }))
  const panel = createPanel({ sessionId: INJECTED_SESSION })
  let tree = await panel.settle()

  const select = byRole(tree, 'runner')
  assert.ok(select, 'the dropdown renders once the host serves /runners')
  assert.equal(select.props.value, 'auto', 'defaultRunner=auto selects 自动识别')
  assert.deepEqual(optionsOf(select).map(textOf), ['自动识别', 'Go 测试', 'Vitest', 'pytest', 'npm script'])

  const options = optionsOf(select)
  assert.equal(options[1].props.disabled, false, 'an available runner is not disabled')
  const pytest = options.find((option) => option.props.value === 'pytest')
  assert.equal(pytest.props.disabled, true, 'available:false is greyed out')
  assert.equal(pytest.props.title, 'python3 不在 PATH', 'the reason goes into the title')
  const script = options.find((option) => option.props.value === 'script')
  assert.equal(script.props.disabled, true)
  assert.equal(script.props.title, '未开启 allowScriptRunners')

  // the conversation dropdown coexists with the runner one
  assert.equal(findAll(tree, (node) => node.type === 'select').length, 2)

  // picking a runner persists it
  select.props.onChange({ target: { value: 'vitest' } })
  tree = await panel.settle()
  assert.equal(byRole(tree, 'runner').props.value, 'vitest')
  assert.equal(JSON.parse(storage.get('dsh-test-live:runner')), 'vitest', 'the choice survives a reload')

  // a stored choice the host now marks unavailable falls back instead of wedging
  storage.set('dsh-test-live:runner', JSON.stringify('pytest'))
  const panel2 = createPanel({ sessionId: INJECTED_SESSION })
  const tree2 = await panel2.settle()
  assert.equal(byRole(tree2, 'runner').props.value, 'auto', 'an unavailable stored runner falls back to 自动识别')
})

test('切到 vitest：placeholder/hint、描述符 flags、labels 文案与 POST body 全跟着换', async () => {
  resetStorage()
  const world = useServer(createServer({ runners: RUNNERS, runs: [RUN_V1, ...ALL_RUNS] }))
  const panel = createPanel({ sessionId: INJECTED_SESSION })
  let tree = await panel.settle()

  // --- per-run labels: the vitest run counts 文件, the legacy runs still count 包
  const chips = byClass(tree, 'dtl-run').map(textOf)
  assert.ok(chips.some((text) => /通过 · 2 文件/.test(text)), 'the vitest chip speaks 文件, saw: ' + JSON.stringify(chips))
  assert.ok(chips.some((text) => /通过 · 3 包/.test(text)), 'runs without a runner keep the 包 wording')
  // the open run is the newest one: its footnote and meta follow its own runner
  assert.ok(textOf(tree).includes('文件：2 通过'), 'the footnote is labelled 文件')
  assert.ok(textOf(tree).includes('runner：Vitest'))

  // --- switch to vitest
  byRole(tree, 'runner').props.onChange({ target: { value: 'vitest' } })
  tree = await panel.settle()

  const input = byRole(tree, 'targets')
  assert.equal(input.props.placeholder, 'tests/', 'placeholder comes from the descriptor')
  assert.equal(input.props.title, '逗号分隔，写 tests/ 下的文件路径', 'the hint becomes the input title')
  assert.ok(textOf(tree).includes('逗号分隔，写 tests/ 下的文件路径'), 'the hint is visible, not just a tooltip')

  const boxes = findAll(tree, (node) => node.props['data-flag'])
  assert.deepEqual(boxes.map((box) => box.props['data-flag']), ['verbose'], 'flags come from the descriptor')
  assert.equal(boxes[0].props.checked, true, 'the default comes from flag.default')
  assert.equal(textOf(tree).includes('-race'), false, "another runner's flags do not leak in")

  // --- POST body
  input.props.onChange({ target: { value: 'tests/a.test.js, tests/b.test.js' } })
  tree = await panel.settle()
  buttonByText(tree, '运行').props.onClick()
  tree = await panel.settle()

  const post = world.posts.find((entry) => entry.path === '/test-live/run')
  assert.deepEqual(post.body, {
    runner: 'vitest',
    flags: { verbose: true },
    verbose: true,
    sessionId: INJECTED_SESSION,
    targets: ['tests/a.test.js', 'tests/b.test.js'],
  }, 'the descriptor shape, with the legacy verbose boolean kept')
  assert.equal(post.body.packages, undefined, 'the old packages field is not sent in runner mode')
})

test('selection.mode=none：整行目标输入隐藏，follow 行保留，提交照样带 runner', async () => {
  resetStorage()
  const world = useServer(createServer({ runners: SCRIPT_RUNNERS, runs: [] }))
  const panel = createPanel({ sessionId: INJECTED_SESSION })
  let tree = await panel.settle()

  assert.equal(byRole(tree, 'runner').props.value, 'script', 'defaultRunner names a concrete runner')
  assert.equal(byRole(tree, 'targets'), undefined, 'a runner without target syntax has no target input')
  assert.equal(byRole(tree, 'targets-row'), undefined, 'the whole row is gone')
  // ...but the follow row is not
  assert.ok(byRole(tree, 'follow-row'), 'the follow row survives')
  assert.ok(byRole(tree, 'follow'), 'the follow input survives')

  // the empty state suggests this runner's command, without a placeholder target
  const empty = byClass(tree, 'dtl-empty').map(textOf).join('\n')
  assert.ok(empty.includes('pnpm test'), 'the example command follows the runner: ' + empty)
  assert.equal(empty.includes('./...'), false, 'no invented Go pattern for a script runner')

  buttonByText(tree, '运行').props.onClick()
  tree = await panel.settle()
  const post = world.posts.find((entry) => entry.path === '/test-live/run')
  assert.deepEqual(post.body, { runner: 'script', flags: {}, verbose: true, sessionId: INJECTED_SESSION })
  assert.equal('targets' in post.body, false, 'no targets means "the runner default", so the key is omitted')
})

test('labels 缺失：回落「包」文案，且新 suites 桶与旧 packages 桶都能读', async () => {
  resetStorage()
  useServer(createServer({ runners: NO_LABELS_RUNNERS, runs: [RUN_V1, ...ALL_RUNS] }))
  const panel = createPanel({ sessionId: INJECTED_SESSION })
  const tree = await panel.settle()

  assert.equal(byRole(tree, 'runner').props.value, 'vitest', 'defaultRunner wins when it is a concrete id')
  const chips = byClass(tree, 'dtl-run').map(textOf)
  assert.ok(chips.some((text) => /通过 · 2 包/.test(text)), 'summary.suites is read even without a runner label')
  assert.ok(chips.some((text) => /通过 · 3 包/.test(text)), 'the legacy summary.packages bucket still renders')
  assert.ok(textOf(tree).includes('包：2 通过'), 'a missing labels.suite falls back to 包')
})

test('auto 跑完：meta 显示本次实际用的 runner', async () => {
  resetStorage()
  const world = useServer(createServer({ runners: RUNNERS }))
  const panel = createPanel({ sessionId: INJECTED_SESSION })
  let tree = await panel.settle()

  buttonByText(tree, '运行').props.onClick()
  tree = await panel.settle()

  const post = world.posts.find((entry) => entry.path === '/test-live/run')
  assert.deepEqual(post.body, { runner: 'auto', flags: {}, verbose: true, sessionId: INJECTED_SESSION })

  const meta = byClass(tree, 'dtl-meta').map(textOf).join('\n')
  assert.ok(meta.includes('runner：自动识别 → Go 测试'), 'the resolved runner is shown: ' + meta)
})

test('defaultRunner=go 与分号分隔符：目标按描述符切分，verbose 勾选映射进 flags', async () => {
  resetStorage()
  const world = useServer(createServer({ runners: GO_SEMI_RUNNERS }))
  const panel = createPanel({ sessionId: INJECTED_SESSION })
  let tree = await panel.settle()

  assert.equal(byRole(tree, 'runner').props.value, 'go', 'defaultRunner=go is selected, not 自动识别')
  const input = byRole(tree, 'targets')
  input.props.onChange({ target: { value: './a/...; ./b/...' } })
  tree = await panel.settle()
  buttonByText(tree, '运行').props.onClick()
  tree = await panel.settle()

  const first = world.posts.find((entry) => entry.path === '/test-live/run')
  assert.deepEqual(first.body.targets, ['./a/...', './b/...'], "targets split on the descriptor's separator")
  assert.deepEqual(first.body.flags, { verbose: true }, 'flags carry explicit booleans per descriptor flag')
  assert.equal(first.body.verbose, true)

  // unchecking the descriptor flag must reach both the body and the old pref key
  const box = findAll(tree, (node) => node.props['data-flag'] === 'verbose')[0]
  box.props.onChange({ target: { checked: false } })
  tree = await panel.settle()
  assert.equal(findAll(tree, (node) => node.props['data-flag'] === 'verbose')[0].props.checked, false)
  assert.equal(JSON.parse(storage.get('dsh-test-live:verbose')), false, 'the old -v preference is kept in sync')

  // a fresh panel starts from that stored preference, so flags is empty
  const panel2 = createPanel({ sessionId: INJECTED_SESSION })
  tree = await panel2.settle()
  assert.equal(findAll(tree, (node) => node.props['data-flag'] === 'verbose')[0].props.checked, false, 'flag.default is overridden by the stored -v choice')
  buttonByText(tree, '运行').props.onClick()
  tree = await panel2.settle()
  const second = world.posts.filter((entry) => entry.path === '/test-live/run')[1]
  assert.deepEqual(second.body.flags, { verbose: false }, 'an unchecked flag is sent as false, not dropped')
  assert.equal(second.body.verbose, false)
})

/** A runner the client has no command prefix for: `generic` uses config.command. */
const GENERIC_RUNNERS = {
  defaultRunner: 'generic',
  runners: [
    { id: 'generic', label: '自定义命令', language: 'other', selection: { mode: 'none' }, flags: [], labels: { suite: '用例' }, available: true },
  ],
}

test('generic：空态不编造命令，也不留空 code', async () => {
  resetStorage()
  useServer(createServer({ runners: GENERIC_RUNNERS, runs: [] }))
  const panel = createPanel({ sessionId: INJECTED_SESSION })
  const tree = await panel.settle()

  assert.equal(byRole(tree, 'runner').props.value, 'generic')
  const empty = byClass(tree, 'dtl-empty').map(textOf).join('\n')
  assert.ok(empty.includes('自定义命令 的默认命令'), 'a runner without a known prefix gets a neutral phrase: ' + empty)
  assert.equal(empty.includes('go test'), false, 'the client does not invent a Go command for generic')
  // no empty <code> element
  const codes = findAll(tree, (node) => node.type === 'code').map(textOf)
  assert.deepEqual(codes, ['test_live_run'], 'only the real command reference is a code span: ' + JSON.stringify(codes))
})

test('吃真实投影：用 src/core/runners.js 的 runnerCatalog() 渲染，字段名对得上', async () => {
  // The fixtures above are hand-written from the contract. This test feeds the
  // panel the catalogue the host actually serves, so a renamed projection field
  // (`selectionHint`, `mode`, `labels.suite`) breaks here instead of in the GUI.
  let runnerCatalog
  try {
    ;({ runnerCatalog } = await import(new URL('../src/core/runners.js', import.meta.url).href))
  } catch (error) {
    assert.fail('cannot import src/core/runners.js (owned by runner-core): ' + error.message)
  }
  const real = runnerCatalog({ allowScriptRunners: false })
  assert.ok(Array.isArray(real) && real.length > 0, 'runnerCatalog() must return a non-empty list')

  resetStorage()
  const world = useServer(createServer({
    runners: { runners: real, defaultRunner: 'auto', allowScriptRunners: false },
    runs: [RUN_V1, ...ALL_RUNS],
  }))
  const panel = createPanel({ sessionId: INJECTED_SESSION })
  let tree = await panel.settle()

  // the picker is the real catalogue, in its own order, behind 自动识别
  const select = byRole(tree, 'runner')
  assert.deepEqual(
    optionsOf(select).map((option) => option.props.value),
    ['auto'].concat(real.map((entry) => entry.id)),
  )
  assert.deepEqual(
    optionsOf(select).slice(1).map(textOf),
    real.map((entry) => entry.label),
    'the option text is the host label',
  )

  // `available:false` from the real catalogue is greyed with the real reason
  const scriptEntry = real.find((entry) => entry.id === 'script')
  if (scriptEntry) {
    const option = optionsOf(select).find((node) => node.props.value === 'script')
    assert.equal(option.props.disabled, scriptEntry.available === false)
    assert.equal(option.props.title, String(scriptEntry.reason))
  }

  // a real `files` runner: placeholder + selectionHint (not the command hint)
  byRole(tree, 'runner').props.onChange({ target: { value: 'vitest' } })
  tree = await panel.settle()
  const vitest = real.find((entry) => entry.id === 'vitest')
  const input = byRole(tree, 'targets')
  assert.equal(input.props.placeholder, vitest.selectionPlaceholder)
  assert.ok(typeof vitest.selectionHint === 'string' && vitest.selectionHint !== '',
    'the projection must carry selectionHint — this is the field the target row reads')
  assert.ok(textOf(tree).includes(vitest.selectionHint), 'the target row shows selectionHint, not the command hint')
  if (vitest.hint && vitest.hint !== vitest.selectionHint) {
    assert.equal(
      findAll(tree, (node) => node.className === 'dtl-note')
        .some((node) => textOf(node) === vitest.hint),
      false,
      'the command hint must not be pasted next to the target input',
    )
  }

  // a real `none` runner hides the target row
  const noneRunner = real.find((entry) => entry.mode === 'none' && entry.available !== false)
  assert.ok(noneRunner, 'the catalogue is expected to have an available mode:none runner')
  if (noneRunner) {
    byRole(tree, 'runner').props.onChange({ target: { value: noneRunner.id } })
    tree = await panel.settle()
    assert.equal(byRole(tree, 'targets'), undefined, 'mode:none hides the target input for ' + noneRunner.id)
    assert.ok(byRole(tree, 'follow-row'), 'the follow row survives')
  }

  // and the POST body keeps the real flag ids
  buttonByText(tree, '运行').props.onClick()
  tree = await panel.settle()
  const post = world.posts.filter((entry) => entry.path === '/test-live/run').pop()
  assert.equal(typeof post.body.runner, 'string')
  assert.equal(typeof post.body.flags, 'object', 'flags is the {flagId: boolean} object the route accepts')
  assert.equal(Array.isArray(post.body.flags), false, 'an array of ids would be refused by the route')
})
