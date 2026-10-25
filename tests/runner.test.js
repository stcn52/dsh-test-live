import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { resolveConfig } from '../src/core/config.js'
import { createHub } from '../src/core/runner.js'

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
  const hub = createHub(resolveConfig({}), { spawn: fake.spawn })
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
  const hub = createHub(resolveConfig({}), { spawn: fake.spawn })
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
  const hub = createHub(resolveConfig({}), { spawn: fake.spawn })
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
  const hub = createHub(resolveConfig({ maxLines: 100 }), { spawn: fake.spawn })
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
  const hub = createHub(resolveConfig({}), { spawn: fake.spawn })
  const started = hub.start({})
  const child = fake.last()
  assert.equal(hub.cancel(started.id), true)
  assert.deepEqual(child.killCalls, ['SIGTERM'])
  child.emit('close', null, 'SIGTERM')
  assert.equal((await hub.waitFor(started.id, 1000)).status, 'canceled')
})

test('a spawn failure is reported as a failed run', async () => {
  const hub = createHub(resolveConfig({}), {
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
  const hub = createHub(resolveConfig({ maxRuns: 2 }), { spawn: fake.spawn })
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
  const hub = createHub(resolveConfig({}), { spawn: fakeSpawn().spawn })
  assert.deepEqual(hub.linesSince('run_missing', 0), [])
  assert.equal(hub.get('run_missing'), null)
  assert.equal(hub.latest(), null)
})

test('dispose stops running children', () => {
  const fake = fakeSpawn()
  const hub = createHub(resolveConfig({}), { spawn: fake.spawn })
  hub.start({})
  const child = fake.last()
  hub.dispose()
  assert.deepEqual(child.killCalls, ['SIGTERM'])
})

test('a run spawns into its own process group', () => {
  const fake = fakeSpawn()
  const hub = createHub(resolveConfig({}), { spawn: fake.spawn })
  hub.start({})
  assert.equal(fake.last().options.detached, true)
})

test('cancel signals the whole process group, not just go test', () => {
  const fake = fakeSpawn({ pid: 4321 })
  const sent = []
  const hub = createHub(resolveConfig({}), {
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
  const hub = createHub(resolveConfig({}), {
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
  const hub = createHub(resolveConfig({}), { spawn: fake.spawn })
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
  const hub = createHub(resolveConfig({}), { spawn: fake.spawn })
  const started = hub.start({})
  const controller = new AbortController()
  controller.abort()
  const meta = await hub.waitFor(started.id, 60_000, controller.signal)
  assert.equal(meta.status, 'running')
})
