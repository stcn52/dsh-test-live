import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { resolveConfig } from '../src/core/config.js'
import { createHub } from '../src/core/runner.js'
import { registerTools } from '../src/tools/index.js'

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
  const hub = createHub(resolveConfig({}), { spawn: fake.spawn })
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
  const hub = createHub(resolveConfig({}), { spawn: fake.spawn })
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
  const hub = createHub(resolveConfig({}), { spawn: fake.spawn })
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
  const hub = createHub(resolveConfig({}), { spawn: fake.spawn })
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
