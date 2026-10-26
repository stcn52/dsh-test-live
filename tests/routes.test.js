import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../src/core/config.js'
import { createHub } from '../src/core/runner.js'
import { registerRoutes } from '../src/host/routes.js'

/**
 * Build a fake cordis context that records injection scopes.
 * @returns {{ ctx: object, scopes: Array<object> }}
 */
function fakeContext() {
  const scopes = []
  const ctx = {
    inject(deps, callback) {
      scopes.push({ deps, callback })
    },
  }
  return { ctx, scopes }
}

/**
 * Enter a recorded injection scope with a fake web server.
 * @param scope - one recorded { deps, callback }.
 * @returns the registered routes.
 */
function enterScope(scope) {
  const routes = []
  const webCtx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      return fn()
    },
  }
  scope.callback(webCtx)
  return routes
}

/**
 * Minimal server response recorder.
 * @returns {object} a response with the fields the routes touch.
 */
function fakeResponse() {
  const chunks = []
  return {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
    },
    end(text) {
      this.writableEnded = true
      if (text !== undefined) chunks.push(String(text))
    },
    body() {
      return chunks.join('')
    },
  }
}

/**
 * Minimal request whose body iterator is empty.
 * @param method - HTTP method.
 * @param url - request URL.
 * @returns {object} a request-like async iterable.
 */
function fakeRequest(method, url) {
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {},
  }
}

test('routes mount through an injection scope, not a name lookup', () => {
  const { ctx, scopes } = fakeContext()
  const hub = createHub(resolveConfig({}), { spawn: () => ({ on() {}, stdout: null, stderr: null }) })

  assert.equal(registerRoutes(ctx, hub), true)
  assert.equal(scopes.length, 1)
  assert.deepEqual(scopes[0].deps, ['webServer'])

  const routes = enterScope(scopes[0])
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/test-live')
  assert.equal(typeof routes[0].handler, 'function')
})

test('the mounted prefix answers /test-live/runs with JSON', async () => {
  const { ctx, scopes } = fakeContext()
  const hub = createHub(resolveConfig({}), { spawn: () => ({ on() {}, stdout: null, stderr: null }) })
  registerRoutes(ctx, hub)
  const [route] = enterScope(scopes[0])

  const res = fakeResponse()
  route.handler(fakeRequest('GET', '/test-live/runs'), res)
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body())
  // CHANGED (conversation ownership): the body used to be exactly `{runs: []}`.
  // It now also carries the conversation list and the scope the host is in; the
  // `runs` field itself is unchanged, which is what a pre-conversation client
  // reads. Asserted per-field rather than deepEqual so the additive fields stay
  // additive.
  assert.deepEqual(payload.runs, [])
  assert.deepEqual(payload.sessions, [])
  assert.equal(payload.scope, 'all')
  assert.equal(payload.defaultScope, 'all')
})

test('a missing injection API is reported instead of throwing', () => {
  const hub = createHub(resolveConfig({}), { spawn: () => ({ on() {}, stdout: null, stderr: null }) })
  assert.equal(registerRoutes({}, hub), false)
})

/**
 * Minimal request carrying a JSON body.
 * @param method - HTTP method.
 * @param url - request URL.
 * @param payload - JSON-serializable body.
 * @returns {object} a request-like async iterable.
 */
function fakeRequestWithBody(method, url, payload) {
  const body = Buffer.from(JSON.stringify(payload))
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      yield body
    },
  }
}

test('POST /test-live/follow starts a file run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-test-live-route-'))
  await writeFile(join(dir, 'run.log'), 'hello\n', 'utf8')
  const { ctx, scopes } = fakeContext()
  const hub = createHub(resolveConfig({ followRoot: dir, followIntervalMs: 100 }))
  registerRoutes(ctx, hub)
  const [route] = enterScope(scopes[0])

  const res = fakeResponse()
  route.handler(fakeRequestWithBody('POST', '/test-live/follow', { path: 'run.log' }), res)
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(res.statusCode, 202)
  const meta = JSON.parse(res.body())
  assert.equal(meta.kind, 'file')
  assert.equal(meta.status, 'running')
  assert.equal(hub.list().length, 1)
  hub.dispose()
})

test('POST /test-live/follow refuses a path outside the root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-test-live-route-'))
  const { ctx, scopes } = fakeContext()
  const hub = createHub(resolveConfig({ followRoot: dir }))
  registerRoutes(ctx, hub)
  const [route] = enterScope(scopes[0])

  const res = fakeResponse()
  route.handler(fakeRequestWithBody('POST', '/test-live/follow', { path: '../../etc/passwd' }), res)
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(res.statusCode, 400)
  assert.match(JSON.parse(res.body()).error, /outside/)
  assert.equal(hub.list().length, 0)
  hub.dispose()
})

test('GET /test-live/follow requires POST', async () => {
  const { ctx, scopes } = fakeContext()
  const hub = createHub(resolveConfig({}))
  registerRoutes(ctx, hub)
  const [route] = enterScope(scopes[0])

  const res = fakeResponse()
  route.handler(fakeRequest('GET', '/test-live/follow'), res)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(res.statusCode, 405)
  hub.dispose()
})

// ---------------------------------------------------------------------------
// Conversation ownership.
//
// These tests drive the HTTP layer against a hub stub shaped like the host-core
// contract ({list,latest,get,sessions,start,follow,roots,cwd}) plus a resolver
// stub. That keeps this file about routing decisions (which filter, which
// context, which envelope) instead of re-testing the registry, and it does not
// couple the route suite to the core landing order.
// ---------------------------------------------------------------------------

/** One metadata row per conversation the stub resolver knows. */
const KNOWN_SESSIONS = {
  s1: { sessionId: 's1', sessionLabel: '修复登录', cwd: '/repo/a' },
  s2: { sessionId: 's2', sessionLabel: '重构面板', cwd: '/repo/b' },
}

/**
 * A resolver stub over KNOWN_SESSIONS.
 * @param table - id → {sessionId, sessionLabel, cwd}.
 * @returns {{describe: Function, list: Function}}
 */
function stubResolver(table = KNOWN_SESSIONS) {
  const known = new Map(Object.entries(table))
  return {
    describe(input) {
      const id = typeof input === 'string' ? input : (input?.id ?? input?.sessionId ?? null)
      return known.get(id) ?? { sessionId: id, sessionLabel: null, cwd: null }
    },
    list() {
      return [...known.values()]
    },
  }
}

/**
 * A hub stub following the contract host-core implements.
 * @param seedRuns - run metas to serve, newest first.
 * @param options - {defaultScope, roots}.
 * @returns the stub, with every call recorded on `.calls`.
 */
function stubHub(seedRuns = [], options = {}) {
  const runs = seedRuns.map((run, index) => ({
    status: 'passed',
    kind: 'command',
    startedAt: 2000 - index,
    durationMs: 1000,
    summaryText: 'summary',
    cwd: '/repo',
    ...run,
  }))
  const calls = { list: [], latest: [], start: [], follow: [], cancel: [] }
  const select = filter => {
    const sessionId = typeof filter?.sessionId === 'string' ? filter.sessionId : null
    const scoped = sessionId === null ? runs.slice() : runs.filter(run => run.sessionId === sessionId)
    return Number.isInteger(filter?.limit) ? scoped.slice(0, filter.limit) : scoped
  }
  return {
    defaultScope: options.defaultScope ?? 'all',
    calls,
    list(filter = {}) {
      calls.list.push(filter)
      return select(filter)
    },
    latest(filter) {
      calls.latest.push(filter)
      return select(filter)[0] ?? null
    },
    get(id) {
      return runs.find(run => run.id === id) ?? null
    },
    sessions() {
      const grouped = new Map()
      for (const run of runs) {
        if (typeof run.sessionId !== 'string') continue
        const known = grouped.get(run.sessionId)
        if (known === undefined) {
          grouped.set(run.sessionId, {
            id: run.sessionId,
            label: null,
            cwd: run.cwd,
            count: 1,
            running: run.status === 'running',
            lastAt: run.startedAt,
          })
          continue
        }
        known.count += 1
        known.running = known.running || run.status === 'running'
      }
      return [...grouped.values()]
    },
    start(runOptions, context) {
      calls.start.push({ options: runOptions, context })
      const meta = {
        id: 'run_started',
        kind: 'command',
        status: 'running',
        command: 'go',
        args: [],
        cwd: context?.cwd ?? '/repo',
        sessionId: context?.sessionId ?? null,
        sessionLabel: context?.sessionLabel ?? null,
        origin: context?.origin ?? null,
        summaryText: '',
      }
      runs.unshift(meta)
      return meta
    },
    follow(path, root, context) {
      calls.follow.push({ path, root, context })
      const meta = {
        id: 'run_followed',
        kind: 'file',
        status: 'running',
        file: path,
        cwd: context?.cwd ?? '/repo',
        sessionId: context?.sessionId ?? null,
        origin: context?.origin ?? null,
        summaryText: '',
      }
      runs.unshift(meta)
      return meta
    },
    cancel(id) {
      calls.cancel.push(id)
      return false
    },
    linesSince() {
      return []
    },
    roots() {
      return options.roots ?? []
    },
    cwd() {
      return '/repo'
    },
    dispose() {},
  }
}

/**
 * Mount the routes against a stub hub and hand back the single registered route.
 * @param hub - hub stub.
 * @param resolver - resolver stub.
 * @returns the prefix route.
 */
function mountStub(hub, resolver) {
  const { ctx, scopes } = fakeContext()
  registerRoutes(ctx, hub, resolver)
  const [route] = enterScope(scopes[0])
  return route
}

/**
 * Drive one request through the mounted route.
 * @param route - prefix route.
 * @param method - HTTP method.
 * @param url - request URL.
 * @param payload - JSON body, omitted for a body-less request.
 * @returns the recorded response.
 */
async function callRoute(route, method, url, payload) {
  const res = fakeResponse()
  const req = payload === undefined ? fakeRequest(method, url) : fakeRequestWithBody(method, url, payload)
  route.handler(req, res)
  await new Promise(resolve => setImmediate(resolve))
  return res
}

/** Two runs, one per conversation, newest first. */
const TWO_RUNS = [
  { id: 'run_s1', sessionId: 's1', sessionLabel: null, startedAt: 2000 },
  { id: 'run_s2', sessionId: 's2', sessionLabel: null, startedAt: 1000 },
]

test('GET /runs defaults to the host-wide view and says which scope it used', async () => {
  const hub = stubHub(TWO_RUNS)
  const route = mountStub(hub, stubResolver())

  const res = await callRoute(route, 'GET', '/test-live/runs')

  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body())
  assert.deepEqual(payload.runs.map(run => run.id), ['run_s1', 'run_s2'])
  assert.equal(payload.scope, 'all')
  assert.equal(payload.defaultScope, 'all')
  // No scope asked for: the hub must not be told to filter by conversation.
  assert.equal(hub.calls.list[0].sessionId, undefined)
  // The conversation list is unfiltered even so, or the dropdown would lose the
  // options as soon as one of them is selected.
  assert.deepEqual(payload.sessions.map(session => session.id).sort(), ['s1', 's2'])
})

test('GET /runs?scope=session&sessionId=… returns only that conversation', async () => {
  const hub = stubHub(TWO_RUNS)
  const route = mountStub(hub, stubResolver())

  const res = await callRoute(route, 'GET', '/test-live/runs?scope=session&sessionId=s1')

  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body())
  assert.deepEqual(payload.runs.map(run => run.id), ['run_s1'])
  assert.equal(payload.scope, 'session')
  // Both conversations stay listed: switching scope must not hide the other tab.
  assert.deepEqual(payload.sessions.map(session => session.id).sort(), ['s1', 's2'])
})

test('scope=session without a sessionId degrades to the host-wide view', async () => {
  const hub = stubHub(TWO_RUNS)
  const route = mountStub(hub, stubResolver())

  const res = await callRoute(route, 'GET', '/test-live/runs?scope=session')

  const payload = JSON.parse(res.body())
  assert.deepEqual(payload.runs.map(run => run.id), ['run_s1', 'run_s2'])
  assert.equal(payload.scope, 'all')
})

test('a host whose defaultScope is session scopes the list when a conversation is named', async () => {
  const hub = stubHub(TWO_RUNS, { defaultScope: 'session' })
  const route = mountStub(hub, stubResolver())

  const res = await callRoute(route, 'GET', '/test-live/runs?sessionId=s2')

  const payload = JSON.parse(res.body())
  assert.equal(payload.defaultScope, 'session')
  assert.equal(payload.scope, 'session')
  assert.deepEqual(payload.runs.map(run => run.id), ['run_s2'])
})

test('limit is clamped before it reaches the hub, and an invalid limit is dropped', async () => {
  const hub = stubHub(TWO_RUNS)
  const route = mountStub(hub, stubResolver())

  await callRoute(route, 'GET', '/test-live/runs?limit=1')
  assert.equal(hub.calls.list.at(-1).limit, 1)

  await callRoute(route, 'GET', '/test-live/runs?limit=9999')
  assert.equal(hub.calls.list.at(-1).limit, 500, 'a huge limit must be clamped, not forwarded')

  await callRoute(route, 'GET', '/test-live/runs?limit=nonsense')
  assert.equal(hub.calls.list.at(-1).limit, undefined, 'an unparsable limit must fall back to the hub default')

  await callRoute(route, 'GET', '/test-live/runs?limit=-3')
  assert.equal(hub.calls.list.at(-1).limit, undefined)
})

test('GET /sessions lists every conversation that owns a run, labelled by the resolver', async () => {
  const hub = stubHub(TWO_RUNS)
  const route = mountStub(hub, stubResolver())

  const res = await callRoute(route, 'GET', '/test-live/sessions')

  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body())
  assert.equal(payload.defaultScope, 'all')
  const byId = new Map(payload.sessions.map(session => [session.id, session]))
  // The stub hub reports no label (an older run); the resolver fills it in.
  assert.equal(byId.get('s1').label, '修复登录')
  assert.equal(byId.get('s1').cwd, '/repo/a')
  assert.equal(byId.get('s1').count, 1)
  assert.equal(byId.get('s2').label, '重构面板')
})

test('GET /sessions requires GET', async () => {
  const route = mountStub(stubHub(TWO_RUNS), stubResolver())
  const res = await callRoute(route, 'POST', '/test-live/sessions', {})
  assert.equal(res.statusCode, 405)
})

test('POST /run resolves the conversation and tags the run origin=panel', async () => {
  const hub = stubHub()
  const route = mountStub(hub, stubResolver())

  const res = await callRoute(route, 'POST', '/test-live/run', { sessionId: 's1', count: true })

  assert.equal(res.statusCode, 202)
  assert.equal(hub.calls.start.length, 1)
  const { options, context } = hub.calls.start[0]
  assert.deepEqual(context, { sessionId: 's1', sessionLabel: '修复登录', cwd: '/repo/a', origin: 'panel' })
  // The conversation travels in the context, not as a run option.
  assert.equal(options.sessionId, undefined)
  assert.equal(options.count, true)
  const meta = JSON.parse(res.body())
  assert.equal(meta.sessionId, 's1')
  assert.equal(meta.origin, 'panel')
})

test('POST /run without a sessionId keeps the pre-conversation call shape', async () => {
  const hub = stubHub()
  const route = mountStub(hub, stubResolver())

  const res = await callRoute(route, 'POST', '/test-live/run', { packages: ['./a'] })

  assert.equal(res.statusCode, 202)
  const { options, context } = hub.calls.start[0]
  assert.deepEqual(options, { packages: ['./a'] })
  assert.deepEqual(context, { sessionId: null, sessionLabel: null, cwd: null, origin: 'panel' })
})

test('a resolver that throws still lets the run start', async () => {
  const hub = stubHub()
  const resolver = {
    describe() {
      throw new Error('session service is going away')
    },
    list() {
      throw new Error('session service is going away')
    },
  }
  const route = mountStub(hub, resolver)

  const res = await callRoute(route, 'POST', '/test-live/run', { sessionId: 's9' })

  assert.equal(res.statusCode, 202)
  assert.deepEqual(hub.calls.start[0].context, {
    sessionId: 's9',
    sessionLabel: null,
    cwd: null,
    origin: 'panel',
  })
  // /runs must survive the same resolver.
  assert.equal((await callRoute(route, 'GET', '/test-live/runs')).statusCode, 200)
})

test('POST /follow passes the conversation context so the hub can widen the roots', async () => {
  const hub = stubHub()
  const route = mountStub(hub, stubResolver())

  const res = await callRoute(route, 'POST', '/test-live/follow', { path: 'run.log', sessionId: 's1' })

  assert.equal(res.statusCode, 202)
  assert.deepEqual(hub.calls.follow[0], {
    path: 'run.log',
    // NEW: the hub validates a follow against one root, so the caller names it.
    // A relative path means "inside this conversation", never the host's cwd.
    root: '/repo/a',
    context: { sessionId: 's1', sessionLabel: '修复登录', cwd: '/repo/a', origin: 'panel' },
  })
})

test('POST /follow without a conversation still leaves the root to the host config', async () => {
  const hub = stubHub()
  const route = mountStub(hub, stubResolver())

  await callRoute(route, 'POST', '/test-live/follow', { path: 'run.log' })

  // Legacy shape: no root is named, the hub falls back to its configured root.
  assert.equal(hub.calls.follow[0].root, undefined)
  assert.deepEqual(hub.calls.follow[0].context, { sessionId: null, sessionLabel: null, cwd: null, origin: 'panel' })
})

test('POST /follow keeps an explicit root but never widens it', async () => {
  const hub = stubHub()
  const route = mountStub(hub, stubResolver())

  await callRoute(route, 'POST', '/test-live/follow', { path: 'run.log', root: '/srv/elsewhere', sessionId: 's1' })

  // The caller's root wins over the conversation cwd; the hub is the one that
  // checks it against the allow-list and refuses an unknown one.
  assert.equal(hub.calls.follow[0].root, '/srv/elsewhere')
})

test('a conversation does not widen the follow roots enough to escape every root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-test-live-route-'))
  const { ctx, scopes } = fakeContext()
  const hub = createHub(resolveConfig({ followRoot: dir }))
  registerRoutes(ctx, hub, stubResolver())
  const [route] = enterScope(scopes[0])

  const res = await callRoute(route, 'POST', '/test-live/follow', {
    path: '../../etc/passwd',
    sessionId: 's1',
  })

  assert.equal(res.statusCode, 400)
  // The original wording is part of the contract with the panel.
  assert.match(JSON.parse(res.body()).error, /outside/)
  assert.equal(hub.list().length, 0)
  hub.dispose()
})

test('follow accepts a log inside the conversation cwd', { skip: typeof createHub(resolveConfig({})).followRootsFor !== 'function' ? 'host-core: followRootsFor 未落地' : false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-test-live-root-'))
  const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-test-live-session-'))
  await writeFile(join(sessionDir, 'run.log'), 'ok\n', 'utf8')
  const { ctx, scopes } = fakeContext()
  const hub = createHub(resolveConfig({ followRoot: root, followIntervalMs: 100 }))
  registerRoutes(ctx, hub, stubResolver({ s1: { sessionId: 's1', sessionLabel: '修复登录', cwd: sessionDir } }))
  const [route] = enterScope(scopes[0])

  const res = await callRoute(route, 'POST', '/test-live/follow', {
    path: join(sessionDir, 'run.log'),
    sessionId: 's1',
  })

  assert.equal(res.statusCode, 202)
  assert.equal(hub.list().length, 1)
  hub.dispose()
})

test('GET /status falls back to the newest run of the named conversation', async () => {
  const hub = stubHub(TWO_RUNS)
  const route = mountStub(hub, stubResolver())

  const res = await callRoute(route, 'GET', '/test-live/status?scope=session&sessionId=s2')

  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body()).id, 'run_s2')
  assert.deepEqual(hub.calls.latest.at(-1), { sessionId: 's2' })
})

test('GET /status with no run at all still answers {run:null}', async () => {
  const hub = stubHub()
  const route = mountStub(hub, stubResolver())

  const res = await callRoute(route, 'GET', '/test-live/status')

  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body()), { run: null })
  assert.deepEqual(hub.calls.latest.at(-1), {})
})

test('GET /log falls back to the named conversation when no id is given', async () => {
  const hub = stubHub(TWO_RUNS)
  hub.linesSince = id => [{ seq: 1, text: `line of ${id}`, kind: 'plain' }]
  const route = mountStub(hub, stubResolver())

  const res = await callRoute(route, 'GET', '/test-live/log?sessionId=s2')

  assert.equal(res.statusCode, 200)
  assert.equal(res.body().trim(), 'line of run_s2')
})

test('POST /cancel scopes its fallback to the named conversation', async () => {
  const hub = stubHub(TWO_RUNS)
  const route = mountStub(hub, stubResolver())

  const res = await callRoute(route, 'POST', '/test-live/cancel', { sessionId: 's1' })

  assert.equal(res.statusCode, 409, 'the stub never cancels anything')
  assert.deepEqual(hub.calls.cancel, ['run_s1'])
})
