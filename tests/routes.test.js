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
  assert.deepEqual(JSON.parse(res.body()), { runs: [] })
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
