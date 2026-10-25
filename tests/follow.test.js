import assert from 'node:assert/strict'
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../src/core/config.js'
import { createHub, resolveFollowPath } from '../src/core/runner.js'

/** Poll a predicate until it holds or the budget expires. */
async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

test('resolveFollowPath keeps paths inside the root', () => {
  const settings = resolveConfig({ followRoot: '/srv/project' })
  assert.equal(resolveFollowPath('run.log', settings), '/srv/project/run.log')
  assert.equal(resolveFollowPath('/srv/project/sub/run.log', settings), '/srv/project/sub/run.log')
  assert.throws(() => resolveFollowPath('../etc/passwd', settings), /outside/)
  assert.throws(() => resolveFollowPath('/etc/passwd', settings), /outside/)
  assert.throws(() => resolveFollowPath('   ', settings), /required/)
})

test('follow streams appended lines and folds the summary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-test-live-'))
  const file = join(dir, 'run.log')
  await writeFile(file, '=== RUN   TestA\nok  \tpkg/a\t0.1s\n', 'utf8')

  const hub = createHub(resolveConfig({ followRoot: dir, followIntervalMs: 100 }))
  const meta = hub.follow('run.log')
  assert.equal(meta.kind, 'file')
  assert.equal(meta.status, 'running')

  assert.ok(await waitFor(() => hub.linesSince(meta.id, -1).length >= 2))
  const first = hub.get(meta.id)
  assert.deepEqual(first.summary.packages.ok, ['pkg/a'])

  await appendFile(file, '--- FAIL: TestB (0.01s)\n', 'utf8')
  assert.ok(await waitFor(() => hub.linesSince(meta.id, -1).length >= 3))
  assert.deepEqual(hub.get(meta.id).summary.failures, ['TestB'])

  assert.equal(hub.cancel(meta.id), true)
  assert.equal(hub.get(meta.id).status, 'canceled')
  const frozen = hub.linesSince(meta.id, -1).length
  await appendFile(file, 'after cancel\n', 'utf8')
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(hub.linesSince(meta.id, -1).length, frozen, 'a cancelled follow must stop reading')
  hub.dispose()
})

test('follow notices truncation and re-reads from the start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-test-live-'))
  const file = join(dir, 'run.log')
  await writeFile(file, 'first line\n', 'utf8')
  const hub = createHub(resolveConfig({ followRoot: dir, followIntervalMs: 100 }))
  const meta = hub.follow('run.log')
  assert.ok(await waitFor(() => hub.linesSince(meta.id, -1).length >= 1))

  // `> file` again: shorter content means the reader must restart at 0.
  await writeFile(file, 'fresh\n', 'utf8')
  assert.ok(await waitFor(() =>
    hub.linesSince(meta.id, -1).some(entry => entry.text.includes('file truncated'))))
  assert.ok(await waitFor(() =>
    hub.linesSince(meta.id, -1).some(entry => entry.text === 'fresh')))
  hub.dispose()
})

test('follow waits for the file to appear (tail -F semantics)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-test-live-'))
  const hub = createHub(resolveConfig({ followRoot: dir, followIntervalMs: 100 }))
  const meta = hub.follow('later.log')
  assert.ok(await waitFor(() => hub.linesSince(meta.id, -1).some(entry => entry.text.includes('waiting for'))))
  assert.equal(hub.get(meta.id).status, 'running')

  // The writer creates the file afterwards (the tee case): it must be picked up.
  await writeFile(join(dir, 'later.log'), 'ok  \tpkg/a\t0.1s\n', 'utf8')
  assert.ok(await waitFor(() => hub.linesSince(meta.id, -1).some(entry => entry.text.startsWith('ok  '))))
  assert.equal(hub.get(meta.id).status, 'running')
  hub.dispose()
})

test('follow fails the run when the path is not readable as a file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-test-live-'))
  const hub = createHub(resolveConfig({ followRoot: dir, followIntervalMs: 100 }))
  // A directory stats fine but cannot be read as a log: EISDIR takes the failure path.
  const meta = hub.follow('.')
  assert.ok(await waitFor(() => hub.get(meta.id).status === 'failed'))
  const lines = hub.linesSince(meta.id, -1)
  assert.match(lines[lines.length - 1].text, /cannot read/)
  hub.dispose()
})

test('follow is refused outside the configured root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-test-live-'))
  const hub = createHub(resolveConfig({ followRoot: dir }))
  assert.throws(() => hub.follow('../../etc/passwd'), /outside/)
  hub.dispose()
})

test('dispose stops a running follow', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-test-live-'))
  const file = join(dir, 'run.log')
  await writeFile(file, 'x\n', 'utf8')
  const hub = createHub(resolveConfig({ followRoot: dir, followIntervalMs: 100 }))
  const meta = hub.follow('run.log')
  hub.dispose()
  assert.equal(hub.get(meta.id).status, 'canceled')
})
