import assert from 'node:assert/strict'
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../src/core/config.js'
import { createHub, resolveFollowPath } from '../src/core/runner.js'

/**
 * Resolve the plugin config with persistence switched off.
 *
 * A hub disposed by one test wrote its runs into the host's real state file
 * (`~/.dsh/test-live/runs.json`) and the next test's hub restored them, so
 * `hub.list().length` was not what the test itself created. Persistence is
 * tests/runner.test.js's subject; the follow reader is tested in memory.
 * @param raw - plugin row config overrides.
 * @returns frozen settings.
 */
function testConfig(raw = {}) {
  return resolveConfig({ stateFile: null, ...raw })
}

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
  const settings = testConfig({ followRoot: '/srv/project' })
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

  const hub = createHub(testConfig({ followRoot: dir, followIntervalMs: 100 }))
  const meta = hub.follow('run.log')
  assert.equal(meta.kind, 'file')
  assert.equal(meta.status, 'running')

  assert.ok(await waitFor(() => hub.linesSince(meta.id, -1).length >= 2))
  const first = hub.get(meta.id)
  // CHANGED (runner descriptors): the `packages` bucket is `suites` now; the old
  // name survives only as a non-enumerable alias for pre-rename readers, and the
  // HTTP payload/state file carry `suites` only.
  assert.deepEqual(first.summary.suites.ok, ['pkg/a'])

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
  const hub = createHub(testConfig({ followRoot: dir, followIntervalMs: 100 }))
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
  const hub = createHub(testConfig({ followRoot: dir, followIntervalMs: 100 }))
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
  const hub = createHub(testConfig({ followRoot: dir, followIntervalMs: 100 }))
  // A directory stats fine but cannot be read as a log: EISDIR takes the failure path.
  const meta = hub.follow('.')
  assert.ok(await waitFor(() => hub.get(meta.id).status === 'failed'))
  const lines = hub.linesSince(meta.id, -1)
  assert.match(lines[lines.length - 1].text, /cannot read/)
  hub.dispose()
})

test('follow is refused outside the configured root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-test-live-'))
  const hub = createHub(testConfig({ followRoot: dir }))
  assert.throws(() => hub.follow('../../etc/passwd'), /outside/)
  hub.dispose()
})

test('dispose stops a running follow', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-test-live-'))
  const file = join(dir, 'run.log')
  await writeFile(file, 'x\n', 'utf8')
  const hub = createHub(testConfig({ followRoot: dir, followIntervalMs: 100 }))
  const meta = hub.follow('run.log')
  hub.dispose()
  assert.equal(hub.get(meta.id).status, 'canceled')
})

// ---------------------------------------------------------------------------
// Conversation ownership: a follow started from a conversation may read that
// conversation's own project, and nothing else.
// ---------------------------------------------------------------------------

test('a conversation adds its own cwd to the follow roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-test-live-root-'))
  const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-test-live-session-'))
  await writeFile(join(sessionDir, 'run.log'), 'ok  \tpkg/a\t0.1s\n', 'utf8')
  const hub = createHub(testConfig({ followRoot: root, followIntervalMs: 100 }))
  const context = { sessionId: 's1', sessionLabel: '修复登录', cwd: sessionDir, origin: 'panel' }

  const roots = hub.followRootsFor(context)
  assert.ok(roots.includes(root), 'the configured root stays allowed')
  assert.ok(roots.includes(sessionDir), 'the conversation cwd joins the allow-list')

  const meta = hub.follow(join(sessionDir, 'run.log'), sessionDir, context)
  assert.equal(meta.kind, 'file')
  assert.equal(meta.sessionId, 's1')
  assert.equal(meta.sessionLabel, '修复登录')
  assert.equal(meta.origin, 'panel')
  assert.ok(await waitFor(() => hub.linesSince(meta.id, -1).some(entry => entry.text.startsWith('ok  '))))
  hub.dispose()
})

test('the widened roots change nothing without a context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-test-live-root-'))
  const hub = createHub(testConfig({ followRoot: root }))
  assert.deepEqual(hub.followRootsFor(undefined), hub.roots())
  assert.deepEqual(hub.followRootsFor({}), hub.roots())
  hub.dispose()
})

test('a conversation cannot follow outside every root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-test-live-root-'))
  const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-test-live-session-'))
  const hub = createHub(testConfig({ followRoot: root }))
  const context = { sessionId: 's1', sessionLabel: '修复登录', cwd: sessionDir, origin: 'panel' }

  // The wording is what the panel's error box shows and what the routes turn
  // into a 400, so it is asserted, not just the throw.
  assert.throws(() => hub.follow('../../etc/passwd', undefined, context), /outside/)
  assert.throws(() => hub.follow('/etc/passwd', undefined, context), /outside/)
  assert.throws(() => hub.follow(join(sessionDir, 'run.log'), undefined, { ...context, cwd: null }), /outside/)
  assert.equal(hub.list().length, 0)
  hub.dispose()
})

test('a follow without a context records no conversation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-test-live-'))
  await writeFile(join(dir, 'run.log'), 'x\n', 'utf8')
  const hub = createHub(testConfig({ followRoot: dir, followIntervalMs: 100 }))
  const meta = hub.follow('run.log')
  assert.equal(meta.sessionId, null)
  assert.equal(meta.sessionLabel, null)
  assert.equal(meta.archived, false)
  hub.dispose()
})
