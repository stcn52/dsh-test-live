import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { resolveConfig } from '../src/core/config.js'
import { createHub } from '../src/core/runner.js'
import { registerTools } from '../src/tools/index.js'

/**
 * Resolve the plugin config with persistence switched off.
 *
 * Without this the hub reads the host's real state file
 * (`~/.dsh/test-live/runs.json`), so a run persisted by one test was restored by
 * the next one and the "no test run yet" / "count" assertions answered with
 * somebody else's history. Persistence itself is covered by
 * tests/runner.test.js; the tool surface is tested against an in-memory registry.
 * @param raw - plugin row config overrides.
 * @returns frozen settings.
 */
function testConfig(raw = {}) {
  return resolveConfig({ stateFile: null, ...raw })
}

/**
 * Build a fake spawn whose child stays running until `close` is called.
 * @returns {{ spawn: Function, last: () => object }}
 */
function fakeSpawn() {
  let last = null
  const spawn = () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killCalls = []
    child.kill = signal => {
      child.killCalls.push(signal)
      return true
    }
    child.close = (code, signal) => child.emit('close', code, signal)
    last = child
    return child
  }
  return { spawn, last: () => last }
}

/**
 * Register the tools against a stub tool service.
 * @param hub - run registry under test.
 * @returns tool definitions by name.
 */
function collect(hub) {
  const tools = new Map()
  registerTools({ tools: { register: definition => tools.set(definition.name, definition) } }, hub)
  return tools
}

test('test_live_run returns at once and leaves the run streaming', async () => {
  const fake = fakeSpawn()
  const hub = createHub(testConfig({}), { spawn: fake.spawn })
  const tools = collect(hub)

  const value = await tools.get('test_live_run').execute({ packages: ['./a'], count: true }, {})

  assert.equal(value.status, 'running')
  assert.match(value.text, /detached from this call/)
  assert.equal(fake.last().killCalls.length, 0)
  fake.last().stdout.write('ok  \tpkg/a\t0.1s\n')
  const after = tools.get('test_live_status').execute({}, {})
  assert.equal(after.status, 'running')
})

test('test_live_run with wait=true reports the finished run', async () => {
  const fake = fakeSpawn()
  const hub = createHub(testConfig({}), { spawn: fake.spawn })
  const tools = collect(hub)

  const pending = tools.get('test_live_run').execute({ wait: true, waitSec: 5 }, {})
  // Let the run start, then finish it while the call is waiting.
  await new Promise(resolve => setImmediate(resolve))
  fake.last().stdout.write('ok  \tpkg/a\t0.1s\n')
  fake.last().close(0, null)

  const value = await pending
  assert.equal(value.status, 'passed')
})

test('cancelling the call stops the run it was waiting for', async () => {
  const fake = fakeSpawn()
  const hub = createHub(testConfig({}), { spawn: fake.spawn })
  const tools = collect(hub)
  const controller = new AbortController()

  const pending = tools.get('test_live_run').execute({ wait: true, waitSec: 60 }, { signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  // Let the tool react to the abort before the fake child reports its death.
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(fake.last().killCalls, ['SIGTERM'])
  fake.last().close(null, 'SIGTERM')

  const value = await pending
  assert.equal(value.status, 'canceled')
  assert.match(value.text, /call canceled/)
})

test('an exhausted wait budget does not kill a healthy run', async () => {
  const fake = fakeSpawn()
  const hub = createHub(testConfig({}), { spawn: fake.spawn })
  const tools = collect(hub)
  // The wait timer is unref'd, so the test itself has to keep the loop alive long
  // enough for the 1s budget to elapse.
  const keepAlive = setTimeout(() => {}, 1500)
  try {
    const value = await tools.get('test_live_run').execute({ wait: true, waitSec: 1 }, {})
    assert.equal(value.status, 'running')
    assert.match(value.text, /still running after 1s/)
    assert.deepEqual(fake.last().killCalls, [])
  } finally {
    clearTimeout(keepAlive)
  }
})

// ---------------------------------------------------------------------------
// Conversation ownership.
// ---------------------------------------------------------------------------

/** Resolver stub: two known conversations, everything else degrades to nulls. */
const KNOWN_SESSIONS = {
  s1: { sessionId: 's1', sessionLabel: '修复登录', cwd: '/repo/a' },
  s2: { sessionId: 's2', sessionLabel: '重构面板', cwd: '/repo/b' },
}

/**
 * @param table - id → description.
 * @returns {{describe: Function, list: Function}} resolver stub.
 */
function stubResolver(table = KNOWN_SESSIONS) {
  const known = new Map(Object.entries(table))
  return {
    describe(input) {
      const id = typeof input === 'string' ? input : (input?.id ?? null)
      return known.get(id) ?? { sessionId: id, sessionLabel: null, cwd: null }
    },
    list() {
      return [...known.values()]
    },
  }
}

/**
 * Register the tools with a resolver and hand back the definitions.
 * @param hub - run registry (or a spy around one).
 * @param resolver - resolver stub.
 * @returns tool definitions by name.
 */
function collectWith(hub, resolver) {
  const tools = new Map()
  registerTools({ tools: { register: definition => tools.set(definition.name, definition) } }, hub, resolver)
  return tools
}

/**
 * Wrap a hub so the ownership context it receives is observable.
 * @param hub - real hub.
 * @returns {{hub: object, calls: object}} the wrapper and its recordings.
 */
function spyHub(hub) {
  const calls = { start: [], follow: [] }
  return {
    calls,
    hub: {
      ...hub,
      start(options, context) {
        calls.start.push({ options, context })
        return hub.start(options, context)
      },
      follow(path, root, context) {
        calls.follow.push({ path, root, context })
        return hub.follow(path, root, context)
      },
    },
  }
}

/** One exec context for a platform session. */
function execIn(sessionId) {
  return { agent: { session: { id: sessionId } } }
}

test('test_live_run takes its conversation from the call, not the arguments', async () => {
  const fake = fakeSpawn()
  const real = createHub(testConfig({}), { spawn: fake.spawn })
  const { hub, calls } = spyHub(real)
  const tools = collectWith(hub, stubResolver())

  const value = await tools.get('test_live_run').execute({ packages: ['./a'] }, execIn('s1'))

  assert.deepEqual(calls.start[0].context, {
    sessionId: 's1',
    sessionLabel: '修复登录',
    cwd: '/repo/a',
    origin: 'tool',
  })
  // The run itself carries the ownership, and the report names the conversation.
  const meta = real.get(value.id)
  assert.equal(meta.sessionId, 's1')
  assert.equal(meta.sessionLabel, '修复登录')
  assert.equal(meta.origin, 'tool')
  assert.match(value.text, /session: 修复登录/)
  real.dispose()
})

test('test_live_run without a session context keeps the host-wide shape', async () => {
  const fake = fakeSpawn()
  const real = createHub(testConfig({}), { spawn: fake.spawn })
  const { hub, calls } = spyHub(real)
  const tools = collectWith(hub, stubResolver())

  const value = await tools.get('test_live_run').execute({}, {})

  assert.deepEqual(calls.start[0].context, { sessionId: null, sessionLabel: null, cwd: null, origin: 'tool' })
  const meta = real.get(value.id)
  assert.equal(meta.sessionId, null)
  assert.equal(meta.origin, 'tool')
  real.dispose()
})

test('test_live_run degrades when the session resolver throws', async () => {
  const fake = fakeSpawn()
  const real = createHub(testConfig({}), { spawn: fake.spawn })
  const resolver = {
    describe() {
      throw new Error('session service is shutting down')
    },
    list() {
      throw new Error('session service is shutting down')
    },
  }
  const tools = collectWith(real, resolver)

  const value = await tools.get('test_live_run').execute({}, execIn('s1'))

  assert.equal(value.status, 'running')
  assert.equal(real.get(value.id).sessionId, null, 'an unresolvable conversation must not fail the run')
  real.dispose()
})

test('test_live_follow follows inside the conversation cwd', async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-test-live-tool-'))
  await writeFile(join(sessionDir, 'run.log'), 'ok  \tpkg/a\t0.1s\n', 'utf8')
  const root = await mkdtemp(join(tmpdir(), 'dsh-test-live-root-'))
  const real = createHub(testConfig({ followRoot: root, followIntervalMs: 100 }))
  const tools = collectWith(real, stubResolver({ s1: { sessionId: 's1', sessionLabel: '修复登录', cwd: sessionDir } }))

  // A relative path in a tool call means "inside this conversation", which the
  // host config root does not cover: the conversation widens the roots.
  const value = await tools.get('test_live_follow').execute({ path: 'run.log' }, execIn('s1'))

  const meta = real.get(value.id)
  assert.equal(meta.kind, 'file')
  assert.equal(meta.sessionId, 's1')
  assert.equal(meta.file, join(sessionDir, 'run.log'))
  real.dispose()
})

test('test_live_follow still refuses a path outside every root', async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-test-live-tool-'))
  const root = await mkdtemp(join(tmpdir(), 'dsh-test-live-root-'))
  const real = createHub(testConfig({ followRoot: root }))
  const tools = collectWith(real, stubResolver({ s1: { sessionId: 's1', sessionLabel: '修复登录', cwd: sessionDir } }))

  await assert.rejects(
    async () => tools.get('test_live_follow').execute({ path: '../../etc/passwd' }, execIn('s1')),
    /outside/,
  )
  assert.equal(real.list().length, 0)
  real.dispose()
})

test('test_live_runs lists every conversation, then one on request', async () => {
  const fake = fakeSpawn()
  const real = createHub(testConfig({}), { spawn: fake.spawn })
  const tools = collectWith(real, stubResolver())

  const first = await tools.get('test_live_run').execute({}, execIn('s1'))
  const second = await tools.get('test_live_run').execute({}, execIn('s2'))

  const all = tools.get('test_live_runs').execute({})
  assert.equal(all.count, 2)
  assert.deepEqual([...all.text.matchAll(/对话 (\S+)/g)].map(match => match[1]).sort(), ['修复登录', '重构面板'])
  assert.match(all.text, new RegExp(`2 run\\(s\\) \\(every conversation\\)`))

  const scoped = tools.get('test_live_runs').execute({ sessionId: 's2' })
  assert.equal(scoped.count, 1)
  assert.match(scoped.text, new RegExp(second.id))
  assert.doesNotMatch(scoped.text, new RegExp(first.id))

  const limited = tools.get('test_live_runs').execute({ sessionId: 's2', limit: 1 })
  assert.equal(limited.count, 1)

  real.dispose()
})

test('test_live_runs appends the requested tail lines', async () => {
  const fake = fakeSpawn()
  const real = createHub(testConfig({}), { spawn: fake.spawn })
  const tools = collectWith(real, stubResolver())

  const value = await tools.get('test_live_run').execute({}, execIn('s1'))
  fake.last().stdout.write('ok  \tpkg/a\t0.1s\n--- FAIL: TestB (0.01s)\n')
  await new Promise(resolve => setImmediate(resolve))

  const listed = tools.get('test_live_runs').execute({ tail: 1 })
  assert.match(listed.text, /^\s+\| --- FAIL: TestB \(0\.01s\)$/m)
  assert.equal(value.status, 'running')
  real.dispose()
})

test('test_live_runs on an empty host says so instead of failing', () => {
  const real = createHub(testConfig({}), { spawn: () => ({ on() {}, stdout: null, stderr: null }) })
  const tools = collectWith(real, stubResolver())

  const value = tools.get('test_live_runs').execute({})
  assert.equal(value.count, 0)
  assert.match(value.text, /no test run/)
  real.dispose()
})

test('test_live_status reads this conversation, not the newest run on the host', async () => {
  const fake = fakeSpawn()
  const real = createHub(testConfig({}), { spawn: fake.spawn })
  const tools = collectWith(real, stubResolver())

  const mine = await tools.get('test_live_run').execute({}, execIn('s1'))
  const theirs = await tools.get('test_live_run').execute({}, execIn('s2'))

  const value = tools.get('test_live_status').execute({}, execIn('s1'))
  assert.equal(value.id, mine.id, 'a status call must not describe another conversation run')
  assert.notEqual(value.id, theirs.id)

  // An explicit sessionId reads another conversation on purpose.
  assert.equal(tools.get('test_live_status').execute({ sessionId: 's2' }, execIn('s1')).id, theirs.id)
  real.dispose()
})

test('test_live_status without a session keeps the host-wide newest run', async () => {
  const fake = fakeSpawn()
  const real = createHub(testConfig({}), { spawn: fake.spawn })
  const tools = collectWith(real, stubResolver())

  await tools.get('test_live_run').execute({}, execIn('s1'))
  const newest = await tools.get('test_live_run').execute({}, execIn('s2'))

  const value = tools.get('test_live_status').execute({}, {})
  assert.equal(value.id, newest.id)
  real.dispose()
})

test('test_live_status in a conversation without runs says so', async () => {
  const fake = fakeSpawn()
  const real = createHub(testConfig({}), { spawn: fake.spawn })
  const tools = collectWith(real, stubResolver())

  await tools.get('test_live_run').execute({}, execIn('s2'))

  const value = tools.get('test_live_status').execute({}, execIn('s1'))
  assert.equal(value.status, 'none')
  assert.match(value.text, /this conversation has no test run yet/)
  real.dispose()
})

test('test_live_cancel only cancels a run of the calling conversation', async () => {
  const fake = fakeSpawn()
  const real = createHub(testConfig({}), { spawn: fake.spawn })
  const tools = collectWith(real, stubResolver())

  const mine = await tools.get('test_live_run').execute({}, execIn('s1'))
  const theirs = await tools.get('test_live_run').execute({}, execIn('s2'))

  const value = tools.get('test_live_cancel').execute({}, execIn('s1'))
  assert.equal(value.id, mine.id)
  assert.equal(real.get(theirs.id).status, 'running', 'another conversation run must be untouched')
  real.dispose()
})

// ---------------------------------------------------------------------------
// Runner descriptors: the tool surface passes the caller's choice through and
// reports which runner produced a run, without ever rebuilding the argv.
// ---------------------------------------------------------------------------

test('test_live_run advertises runner, targets and the legacy aliases', () => {
  const real = createHub(testConfig({}), { spawn: () => ({ on() {}, stdout: null, stderr: null }) })
  const tools = collectWith(real, stubResolver())
  const params = tools.get('test_live_run').parameters.properties

  assert.ok(params.runner, 'runner must be callable')
  assert.ok(params.runner.enum.includes('auto'))
  assert.ok(params.runner.enum.includes('pytest'))
  assert.ok(params.targets, 'targets must be callable')
  assert.ok(params.flags, 'flags must be callable')
  // ADDED, not replacing: a model that still sends the Go-era arguments works.
  assert.ok(params.packages)
  assert.ok(params.verbose)
  assert.ok(params.race)
  assert.ok(params.count)
  real.dispose()
})

test('test_live_run hands runner, targets and flags to the hub untouched', async () => {
  const fake = fakeSpawn()
  const real = createHub(testConfig({}), { spawn: fake.spawn })
  const { hub, calls } = spyHub(real)
  const tools = collectWith(hub, stubResolver())

  const args = { runner: 'nodeTest', targets: ['test/'], flags: { verbose: true } }
  const value = await tools.get('test_live_run').execute(args, {})

  assert.equal(value.status, 'running')
  assert.deepEqual(calls.start[0].options, args, 'the argv belongs to the runner, not to the tool surface')
  assert.equal(real.get(value.id).runner, 'nodeTest')
  real.dispose()
})

test('test_live_run refuses an unknown runner before spawning anything', async () => {
  const fake = fakeSpawn()
  const real = createHub(testConfig({}), { spawn: fake.spawn })
  const tools = collectWith(real, stubResolver())

  await assert.rejects(async () => tools.get('test_live_run').execute({ runner: 'cargo' }, {}), /unknown runner "cargo"/)
  assert.equal(fake.last(), null, 'a refused call must not spawn')
  assert.equal(real.list().length, 0)
  real.dispose()
})

test('test_live_run refuses the script runner unless the host enabled it', async () => {
  const gated = fakeSpawn()
  const real = createHub(testConfig({}), { spawn: gated.spawn })
  const tools = collectWith(real, stubResolver())

  await assert.rejects(async () => tools.get('test_live_run').execute({ runner: 'script' }, {}), /allowScriptRunners/)
  assert.equal(gated.last(), null)
  real.dispose()

  const open = fakeSpawn()
  const allowedHub = createHub(testConfig({ allowScriptRunners: true }), { spawn: open.spawn })
  const allowed = collectWith(allowedHub, stubResolver())
  const value = await allowed.get('test_live_run').execute({ runner: 'script' }, {})

  assert.equal(value.status, 'running')
  assert.equal(allowedHub.get(value.id).runner, 'script')
  allowedHub.dispose()
})

test('test_live_status names the runner that produced the run', async () => {
  const fake = fakeSpawn()
  const real = createHub(testConfig({}), { spawn: fake.spawn })
  const tools = collectWith(real, stubResolver())

  const started = await tools.get('test_live_run').execute({ runner: 'pytest', targets: ['tests/'] }, {})
  fake.last().stdout.write('tests/test_calc.py::test_add PASSED\n')
  fake.last().close(0, null)
  await new Promise(resolve => setImmediate(resolve))

  const value = tools.get('test_live_status').execute({ id: started.id }, {})
  assert.match(value.text, /^runner: pytest$/m, 'the report must say which grammar produced the counters')
  assert.match(value.text, /pytest tests\//, 'and the argv it ran')
  real.dispose()
})

test('test_live_status is honest about a run from before runners existed', () => {
  const legacy = {
    id: 'run_old',
    kind: 'command',
    status: 'passed',
    command: 'go',
    args: ['test', './...'],
    cwd: '/repo',
    runner: null,
    runnerLabel: null,
    summaryText: '1 packages ok',
  }
  const tools = collectWith(
    { latest: () => legacy, get: () => legacy, list: () => [legacy], linesSince: () => [], cancel: () => false },
    stubResolver(),
  )

  const value = tools.get('test_live_status').execute({}, {})
  assert.match(value.text, /^runner: not recorded$/m)
})

test('test_live_follow spells the write-with command for the current runner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-test-live-tool-'))
  await writeFile(join(dir, 'run.log'), 'ok\n', 'utf8')
  const real = createHub(testConfig({ followRoot: dir, followIntervalMs: 100 }))
  const tools = collectWith(real, stubResolver())
  const follow = args => tools.get('test_live_follow').execute(args, {})

  // No runner named and no run yet: the historical Go wording is unchanged.
  const historical = follow({ path: 'run.log' })
  assert.match(historical.text, /^write with: go test \.\/\.\.\. 2>&1 \| tee /m)

  const pytest = follow({ path: 'run.log', runner: 'pytest' })
  assert.equal(pytest.runner, 'pytest')
  assert.match(pytest.text, /^write with: pytest -v 2>&1 \| tee /m)

  const vitest = follow({ path: 'run.log', runner: 'vitest' })
  assert.match(vitest.text, /^write with: pnpm exec vitest run 2>&1 \| tee /m)

  const go = follow({ path: 'run.log', runner: 'go' })
  assert.match(go.text, /^runner: go$/m)

  // A typo fails here instead of producing a hint for a runner that cannot parse.
  assert.throws(() => follow({ path: 'run.log', runner: 'cargo' }), /unknown runner "cargo"/)
  real.dispose()
})

test('test_live_follow follows the runner of the newest run of the conversation', async () => {
  const fake = fakeSpawn()
  const dir = await mkdtemp(join(tmpdir(), 'dsh-test-live-tool-'))
  await writeFile(join(dir, 'run.log'), 'ok\n', 'utf8')
  const real = createHub(testConfig({ followRoot: dir, followIntervalMs: 100 }), { spawn: fake.spawn })
  const tools = collectWith(real, stubResolver({ s1: { sessionId: 's1', sessionLabel: '修复登录', cwd: dir } }))

  await tools.get('test_live_run').execute({ runner: 'nodeTest' }, execIn('s1'))
  const value = tools.get('test_live_follow').execute({ path: 'run.log' }, execIn('s1'))

  assert.equal(value.runner, 'nodeTest')
  assert.match(value.text, /^write with: node --test 2>&1 \| tee /m)
  real.dispose()
})

test('test_live_follow records the runner it was asked to parse with', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-test-live-tool-'))
  await writeFile(join(dir, 'run.log'), 'ok\n', 'utf8')
  const real = createHub(testConfig({ followRoot: dir, followIntervalMs: 100 }))
  const tools = collectWith(real, stubResolver())
  const follow = args => tools.get('test_live_follow').execute(args, {})

  const pytest = follow({ path: 'run.log', runner: 'pytest' })
  assert.equal(real.get(pytest.id).runner, 'pytest')

  // `auto` on a follow is honestly unresolved: there is no argv to detect from.
  const auto = follow({ path: 'run.log', runner: 'auto' })
  assert.equal(real.get(auto.id).runner, null)
  assert.match(real.get(auto.id).detectReason, /follow 不执行 runner/)

  // The historical call keeps the runner-less record it always had.
  const bare = follow({ path: 'run.log' })
  assert.equal(real.get(bare.id).runner, null)
  assert.equal(real.get(bare.id).detectReason, null)
  real.dispose()
})
