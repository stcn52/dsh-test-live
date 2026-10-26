import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { resolveConfig } from '../src/core/config.js'
import { createHub } from '../src/core/runner.js'
import { createRunStore } from '../src/core/store.js'

/**
 * Plugin config for a test: persistence off unless the test names a state file,
 * so a test can never write into the real `~/.dsh`.
 * @param overrides - config fields for this test.
 * @returns resolved settings.
 */
function config(overrides = {}) {
  return resolveConfig({ stateFile: null, ...overrides })
}

/** @returns a fresh temporary directory (the caller removes it). */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-test-live-'))
}

/** Wait until `check()` is truthy, or fail the test after `timeoutMs`. */
async function until(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * Build a fake spawn that records the command line and exposes a writable child.
 * @param overrides - extra child fields (e.g. `pid` for a signallable group).
 * @returns {{ spawn: Function, last: () => object }}
 */
function fakeSpawn(overrides = {}) {
  let last = null
  const spawn = (command, args, options) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killCalls = []
    child.kill = signal => {
      child.killCalls.push(signal)
      return true
    }
    child.command = command
    child.args = args
    child.options = options
    Object.assign(child, overrides)
    last = child
    return child
  }
  return { spawn, last: () => last }
}

/** Write text to the fake child and let the stream flush. */
async function write(child, text) {
  child.stdout.write(text)
  await new Promise(resolve => setImmediate(resolve))
}

test('a passing run streams lines and finishes as passed', async () => {
  const fake = fakeSpawn()
  const hub = createHub(config({}), { spawn: fake.spawn })
  const started = hub.start({ packages: ['./...'], verbose: false })
  assert.equal(started.status, 'running')
  assert.deepEqual(started.args, ['test', '-timeout=900s', './...'])

  const child = fake.last()
  const seen = []
  hub.subscribe(started.id, { onLine: entry => seen.push(entry.text) })
  await write(child, '=== RUN   TestA\n--- PASS: TestA (0.00s)\nok  \tpkg/a\t0.1s\n')
  child.emit('close', 0, null)

  const finished = await hub.waitFor(started.id, 1000)
  assert.equal(finished.status, 'passed')
  assert.deepEqual(seen, ['=== RUN   TestA', '--- PASS: TestA (0.00s)', 'ok  \tpkg/a\t0.1s'])
  assert.equal(finished.summary.tests.pass, 1)
  assert.deepEqual(finished.summary.packages.ok, ['pkg/a'])
  assert.ok(finished.durationMs >= 0)
})

test('a failing run records the failing test and package', async () => {
  const fake = fakeSpawn()
  const hub = createHub(config({}), { spawn: fake.spawn })
  const started = hub.start({})
  const child = fake.last()
  await write(child, '--- FAIL: TestB (0.01s)\nFAIL\tpkg/b\t0.2s\nFAIL\n')
  child.emit('close', 1, null)
  const finished = hub.waitFor(started.id, 1000)
  assert.equal((await finished).status, 'failed')
  assert.deepEqual((await finished).summary.failures, ['TestB'])
})

test('an incomplete line is completed in place', async () => {
  const fake = fakeSpawn()
  const hub = createHub(config({}), { spawn: fake.spawn })
  const started = hub.start({})
  const child = fake.last()
  await write(child, '=== RUN   Tes')
  let lines = hub.linesSince(started.id, -1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].provisional, true)
  assert.equal(lines[0].seq, 1)

  await write(child, 'tA\n')
  lines = hub.linesSince(started.id, -1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].text, '=== RUN   TestA')
  assert.equal(lines[0].provisional, false)
  assert.equal(lines[0].kind, 'run')
})

test('the line buffer honours maxLines and flags truncation', async () => {
  const fake = fakeSpawn()
  const hub = createHub(config({ maxLines: 100 }), { spawn: fake.spawn })
  const started = hub.start({})
  const child = fake.last()
  // maxLines is clamped to >= 100, so write past that ceiling.
  let text = ''
  for (let i = 0; i < 130; i++) text += `line ${i}\n`
  await write(child, text)
  child.emit('close', 0, null)
  const finished = await hub.waitFor(started.id, 1000)
  assert.equal(finished.truncated, true)
  assert.equal(finished.buffered, 100)
  assert.equal(hub.linesSince(started.id, -1)[0].text, 'line 30')
})

test('cancel signals the child and marks the run canceled', async () => {
  const fake = fakeSpawn()
  const hub = createHub(config({}), { spawn: fake.spawn })
  const started = hub.start({})
  const child = fake.last()
  assert.equal(hub.cancel(started.id), true)
  assert.deepEqual(child.killCalls, ['SIGTERM'])
  child.emit('close', null, 'SIGTERM')
  assert.equal((await hub.waitFor(started.id, 1000)).status, 'canceled')
})

test('a spawn failure is reported as a failed run', async () => {
  const hub = createHub(config({}), {
    spawn: () => {
      throw new Error('spawn go ENOENT')
    },
  })
  const started = hub.start({})
  assert.equal(started.status, 'failed')
  assert.match(started.error, /ENOENT/)
  const lines = hub.linesSince(started.id, -1)
  assert.match(lines[lines.length - 1].text, /cannot start go/)
})

test('history keeps only maxRuns finished runs', async () => {
  const fake = fakeSpawn()
  const hub = createHub(config({ maxRuns: 2 }), { spawn: fake.spawn })
  const ids = []
  for (let i = 0; i < 4; i++) {
    const started = hub.start({})
    ids.push(started.id)
    fake.last().emit('close', 0, null)
    await hub.waitFor(started.id, 1000)
  }
  assert.equal(hub.list().length, 2)
  assert.equal(hub.get(ids[0]), null)
  assert.equal(hub.get(ids[3]).status, 'passed')
})

test('linesSince filters by seq and unknown runs have no lines', () => {
  const hub = createHub(config({}), { spawn: fakeSpawn().spawn })
  assert.deepEqual(hub.linesSince('run_missing', 0), [])
  assert.equal(hub.get('run_missing'), null)
  assert.equal(hub.latest(), null)
})

test('dispose stops running children', () => {
  const fake = fakeSpawn()
  const hub = createHub(config({}), { spawn: fake.spawn })
  hub.start({})
  const child = fake.last()
  hub.dispose()
  assert.deepEqual(child.killCalls, ['SIGTERM'])
})

test('a run spawns into its own process group', () => {
  const fake = fakeSpawn()
  const hub = createHub(config({}), { spawn: fake.spawn })
  hub.start({})
  assert.equal(fake.last().options.detached, true)
})

test('cancel signals the whole process group, not just go test', () => {
  const fake = fakeSpawn({ pid: 4321 })
  const sent = []
  const hub = createHub(config({}), {
    spawn: fake.spawn,
    signalProcess: (pid, signal) => sent.push([pid, signal]),
  })
  const started = hub.start({})
  assert.equal(hub.cancel(started.id), true)
  assert.deepEqual(sent, [[-4321, 'SIGTERM']])
  assert.deepEqual(fake.last().killCalls, [])
})

test('a vanished process group falls back to the child', () => {
  const fake = fakeSpawn({ pid: 4321 })
  const hub = createHub(config({}), {
    spawn: fake.spawn,
    signalProcess: () => {
      throw new Error('ESRCH')
    },
  })
  const started = hub.start({})
  assert.equal(hub.cancel(started.id), true)
  assert.deepEqual(fake.last().killCalls, ['SIGTERM'])
})

test('an aborted wait settles at once and leaves the run alive', async () => {
  const fake = fakeSpawn()
  const hub = createHub(config({}), { spawn: fake.spawn })
  const started = hub.start({})
  const controller = new AbortController()
  const waiting = hub.waitFor(started.id, 60_000, controller.signal)
  controller.abort()
  const meta = await waiting
  assert.equal(meta.status, 'running')
  assert.equal(hub.get(started.id).status, 'running')
})

test('an already aborted signal does not wait at all', async () => {
  const fake = fakeSpawn()
  const hub = createHub(config({}), { spawn: fake.spawn })
  const started = hub.start({})
  const controller = new AbortController()
  controller.abort()
  const meta = await hub.waitFor(started.id, 60_000, controller.signal)
  assert.equal(meta.status, 'running')
})

// --- session ownership -----------------------------------------------------

test('a run records the conversation and spawns in its cwd', () => {
  const fake = fakeSpawn()
  const hub = createHub(config({ cwd: '/configured/project' }), { spawn: fake.spawn })
  const owned = hub.start({}, { sessionId: 'session-a', sessionLabel: '对话 A', cwd: '/session/project', origin: 'tool' })
  assert.equal(owned.sessionId, 'session-a')
  assert.equal(owned.sessionLabel, '对话 A')
  assert.equal(owned.origin, 'tool')
  assert.equal(owned.archived, false)
  assert.equal(owned.cwd, '/session/project')
  assert.equal(fake.last().options.cwd, '/session/project')

  // No context: the deployment cwd is the fallback, not the owner.
  const fallback = hub.start({})
  assert.equal(fallback.cwd, '/configured/project')
  assert.equal(fallback.sessionId, null)
  assert.equal(fallback.origin, null)

  // A relative session cwd is refused rather than resolved against the host.
  const relative = hub.start({}, { cwd: 'relative/dir' })
  assert.equal(relative.cwd, '/configured/project')
})

test('deps.cwdFor still fills the gap between session cwd and config', () => {
  const fake = fakeSpawn()
  const seen = []
  const hub = createHub(config({ cwd: '/configured/project' }), {
    spawn: fake.spawn,
    cwdFor: context => {
      seen.push(context?.sessionId ?? null)
      return '/hook/project'
    },
  })
  assert.equal(hub.start({}).cwd, '/hook/project')
  assert.equal(hub.start({}, { sessionId: 'session-a', cwd: '/session/project' }).cwd, '/session/project')
  assert.deepEqual(seen, [null, 'session-a'])
})

test('run ids are unique across runs and restart-safe in shape', async () => {
  const fake = fakeSpawn()
  const hub = createHub(config(), { spawn: fake.spawn })
  const ids = new Set()
  for (let i = 0; i < 40; i++) {
    const started = hub.start({})
    ids.add(started.id)
    fake.last().emit('close', 0, null)
    await hub.waitFor(started.id, 1000)
  }
  assert.equal(ids.size, 40)
  for (const id of ids) assert.match(id, /^run_[0-9a-z]+$/)
})

// --- persistence -----------------------------------------------------------

test('a stored run returns as archived history with its lines', async () => {
  const dir = tempDir()
  try {
    const stateFile = join(dir, 'test-live', 'runs.json')
    const fake = fakeSpawn()
    const first = createHub(resolveConfig({ stateFile }), { spawn: fake.spawn })
    const started = first.start({}, { sessionId: 'session-a', sessionLabel: '对话 A', cwd: dir, origin: 'panel' })
    const child = fake.last()
    await write(child, '--- PASS: TestA (0.00s)\nok  \tpkg/a\t0.1s\n')
    child.emit('close', 0, null)
    await first.waitFor(started.id, 1000)
    first.dispose()
    assert.ok(existsSync(stateFile), 'dispose must flush the store')

    const second = createHub(resolveConfig({ stateFile }), { spawn: fakeSpawn().spawn })
    const listed = second.list()
    assert.equal(listed.length, 1)
    const restored = listed[0]
    assert.equal(restored.id, started.id)
    assert.equal(restored.archived, true)
    assert.equal(restored.status, 'passed')
    assert.equal(restored.sessionId, 'session-a')
    assert.equal(restored.sessionLabel, '对话 A')
    assert.equal(restored.cwd, dir)
    assert.equal(restored.origin, 'panel')
    assert.deepEqual(
      second.linesSince(restored.id, -1).map(entry => entry.text),
      ['--- PASS: TestA (0.00s)', 'ok  \tpkg/a\t0.1s'],
    )
    assert.equal(second.latest().id, started.id)
    assert.equal(second.get(started.id).status, 'passed')
    assert.equal(second.sessions()[0].id, 'session-a')
    second.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a run that was running at shutdown returns as canceled', () => {
  const dir = tempDir()
  try {
    const stateFile = join(dir, 'test-live', 'runs.json')
    const store = createRunStore({ stateFile })
    store.save([
      {
        id: 'run_interrupted',
        kind: 'command',
        status: 'running',
        command: 'go',
        args: ['test', './...'],
        cwd: dir,
        sessionId: 'session-a',
        startedAt: Date.now() - 5000,
        lastSeq: 1,
        lines: [{ seq: 1, text: '=== RUN   TestA', kind: 'run' }],
      },
    ])
    store.flush()

    const hub = createHub(resolveConfig({ stateFile }), { spawn: fakeSpawn().spawn })
    const meta = hub.latest()
    assert.equal(meta.id, 'run_interrupted')
    assert.equal(meta.status, 'canceled')
    assert.equal(meta.canceled, true)
    assert.equal(meta.archived, true)
    assert.match(meta.error, /宿主重启/)
    assert.equal(hub.linesSince(meta.id, -1)[0].text, '=== RUN   TestA')
    hub.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stateFile: null keeps the registry in memory only', async () => {
  const dir = tempDir()
  try {
    const fake = fakeSpawn()
    const hub = createHub(config(), { spawn: fake.spawn })
    const started = hub.start({}, { cwd: dir })
    fake.last().emit('close', 0, null)
    await hub.waitFor(started.id, 1000)
    hub.dispose()
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- filtering and follow roots --------------------------------------------

test('list, latest and sessions filter by conversation', async () => {
  const fake = fakeSpawn()
  // A monotonic clock keeps "newest first" deterministic inside one millisecond.
  let clock = 1_000
  const hub = createHub(config(), { spawn: fake.spawn, now: () => (clock += 1) })
  const finish = async started => {
    fake.last().emit('close', 0, null)
    await hub.waitFor(started.id, 1000)
  }
  const a = hub.start({}, { sessionId: 'session-a', sessionLabel: '对话 A', cwd: '/repo/a' })
  await finish(a)
  const b = hub.start({}, { sessionId: 'session-b', sessionLabel: '对话 B', cwd: '/repo/b' })
  await finish(b)
  const anonymous = hub.start({})
  await finish(anonymous)

  assert.equal(hub.list().length, 3)
  assert.deepEqual(hub.list({ sessionId: 'session-a' }).map(meta => meta.id), [a.id])
  assert.deepEqual(hub.list({ sessionId: 'session-a', limit: 1 }).map(meta => meta.id), [a.id])
  assert.deepEqual(hub.list({ sessionId: 'no-such-session' }), [])
  assert.deepEqual(hub.list({ limit: 2 }).map(meta => meta.id), [anonymous.id, b.id])
  assert.equal(hub.latest().id, anonymous.id)
  assert.equal(hub.latest({ sessionId: 'session-b' }).id, b.id)
  assert.equal(hub.latest({ sessionId: 'no-such-session' }), null)

  const sessions = hub.sessions()
  assert.deepEqual(sessions.map(row => row.id), ['session-b', 'session-a'])
  assert.equal(sessions[0].label, '对话 B')
  assert.equal(sessions[0].cwd, '/repo/b')
  assert.equal(sessions[0].count, 1)
  assert.equal(sessions[0].running, false)
  assert.ok(sessions[0].lastAt >= sessions[1].lastAt)
  // Runs without an owner cannot be attributed, so they get no session row.
  assert.equal(sessions.length, 2)
})

test('followRootsFor adds the conversation cwd and follow accepts it', async () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'fulltest.log')
    writeFileSync(file, 'ok  \tpkg/a\t0.1s\n')
    const hub = createHub(config({ followRoot: '/configured/root' }), { spawn: fakeSpawn().spawn })
    assert.deepEqual(hub.roots(), ['/configured/root'])
    assert.deepEqual(hub.followRootsFor({ cwd: dir }), ['/configured/root', dir])
    // Already configured: no duplicate entry.
    assert.deepEqual(hub.followRootsFor({ cwd: '/configured/root' }), ['/configured/root'])

    const meta = hub.follow('fulltest.log', dir, {
      sessionId: 'session-a',
      sessionLabel: '对话 A',
      cwd: dir,
      origin: 'tool',
    })
    assert.equal(meta.file, file)
    assert.equal(meta.sessionId, 'session-a')
    assert.equal(meta.origin, 'tool')
    assert.equal(meta.cwd, dir)
    // A root outside the allow-list is still refused.
    assert.throws(() => hub.follow('x.log', '/etc'), /not one of the configured follow roots/)

    await until(() => hub.linesSince(meta.id, -1).some(entry => entry.text.includes('pkg/a')))
    hub.cancel(meta.id)
    hub.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
