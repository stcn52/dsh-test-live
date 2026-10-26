import assert from 'node:assert/strict'
import { appendFile, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../src/core/config.js'
import { RUNNERS } from '../src/core/runners.js'
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
// The runner a follow records.
//
// A follow never spawns anything, so `runner` is provenance, not argv: an
// explicit id names the grammar that parses the file, `auto` cannot be detected
// without a spawn directory, and a call that names none stays runner-less
// exactly as before the field existed.
// ---------------------------------------------------------------------------

test('follow records an explicit runner and parses with its grammar', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-test-live-'))
  // A pytest result line: the Go grammar would leave it `plain`, so a counted
  // pass proves the recorded runner is the grammar the reader actually used.
  await writeFile(join(dir, 'run.log'), 'tests/test_calc.py::test_add PASSED                                      [ 33%]\n', 'utf8')
  const hub = createHub(testConfig({ followRoot: dir, followIntervalMs: 100 }))

  const meta = hub.follow('run.log', undefined, { runner: 'pytest' })
  assert.equal(meta.runner, 'pytest')
  assert.equal(meta.runnerLabel, RUNNERS.pytest.label)
  assert.equal(meta.detectReason, null)
  assert.equal(hub.get(meta.id).runner, 'pytest')
  assert.ok(await waitFor(() => hub.get(meta.id).summary.tests.pass === 1))
  hub.dispose()
})

test('follow with runner "auto" records no runner and says why', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-test-live-'))
  await writeFile(join(dir, 'run.log'), 'x\n', 'utf8')
  const hub = createHub(testConfig({ followRoot: dir, followIntervalMs: 100 }))

  const meta = hub.follow('run.log', undefined, { runner: 'auto' })
  // `auto` means "detect it", but a follow builds no argv and inspects no
  // directory: recording what detection would have guessed would be dishonest.
  assert.equal(meta.runner, null)
  assert.equal(meta.runnerLabel, null)
  assert.match(meta.detectReason, /follow 不执行 runner/)
  assert.equal(hub.get(meta.id).detectReason, meta.detectReason)
  hub.dispose()
})

test('follow without a runner stays runner-less like an old call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-test-live-'))
  await writeFile(join(dir, 'run.log'), 'x\n', 'utf8')
  const hub = createHub(testConfig({ followRoot: dir, followIntervalMs: 100 }))

  const meta = hub.follow('run.log')
  assert.equal(meta.runner, null)
  assert.equal(meta.runnerLabel, null)
  assert.equal(meta.detectReason, null)
  assert.equal(hub.get(meta.id).runner, null)
  hub.dispose()
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

// ---------------------------------------------------------------------------
// Multiple configured roots: the first root is the default for *relative* paths
// only. An absolute path names its own root, so a log under the second root must
// not be refused as "outside" the first one (regression: a follow whose
// conversation has no cwd reached the hub with no explicit root at all).
// ---------------------------------------------------------------------------

/**
 * Two existing roots, each holding one log.
 * @returns {{ rootA: string, rootB: string }}
 */
async function twoRoots() {
  const rootA = await mkdtemp(join(tmpdir(), 'dsh-test-live-rootA-'))
  const rootB = await mkdtemp(join(tmpdir(), 'dsh-test-live-rootB-'))
  await writeFile(join(rootA, 'run.log'), 'ok  \tpkg/a\t0.1s\n', 'utf8')
  await writeFile(join(rootB, 'fulltest.log'), 'ok  \tpkg/b\t0.1s\n', 'utf8')
  return { rootA, rootB }
}

test('an absolute path in the second of several roots is followed there', async () => {
  const { rootA, rootB } = await twoRoots()
  const hub = createHub(testConfig({ followRoots: [rootA, rootB], followIntervalMs: 100 }))

  // No explicit root and no context: the hub has to choose the root itself, which
  // is the shape a follow takes when the calling conversation has no cwd
  // (src/host/routes.js then passes no root at all).
  const meta = hub.follow(join(rootB, 'fulltest.log'))
  assert.equal(meta.kind, 'file')
  assert.equal(meta.file, join(rootB, 'fulltest.log'))
  assert.equal(meta.cwd, rootB, 'the followed log decides the run directory')
  assert.ok(await waitFor(() => hub.linesSince(meta.id, -1).some(entry => entry.text.startsWith('ok  '))))

  // Both roots stay reachable: matching the second one must not make the first
  // one unreachable, and a relative path still lands in the first root.
  assert.equal(hub.follow(join(rootA, 'run.log')).file, join(rootA, 'run.log'))
  assert.equal(hub.follow('run.log').file, join(rootA, 'run.log'))
  hub.dispose()
})

test('an absolute path outside every root is still refused and names the roots', async () => {
  const { rootA, rootB } = await twoRoots()
  const elsewhere = await mkdtemp(join(tmpdir(), 'dsh-test-live-elsewhere-'))
  await writeFile(join(elsewhere, 'run.log'), 'x\n', 'utf8')
  const hub = createHub(testConfig({ followRoots: [rootA, rootB] }))

  // The wording is what the panel's error box shows, so it is asserted: with
  // several roots a message naming only the default one would be misleading.
  assert.throws(
    () => hub.follow(join(elsewhere, 'run.log')),
    error => /outside/.test(error.message) && error.message.includes(rootA) && error.message.includes(rootB),
  )
  assert.equal(hub.list().length, 0)
  hub.dispose()
})

test('a symlink inside a root cannot name a file outside every root', async () => {
  const { rootA, rootB } = await twoRoots()
  const elsewhere = await mkdtemp(join(tmpdir(), 'dsh-test-live-elsewhere-'))
  await writeFile(join(elsewhere, 'secret.log'), 'x\n', 'utf8')
  await symlink(join(elsewhere, 'secret.log'), join(rootB, 'link.log'))
  const hub = createHub(testConfig({ followRoots: [rootA, rootB] }))

  // Matching the root on the literal path must not weaken the containment test:
  // the prefix comparison runs on the real path, so the symlink is refused.
  assert.throws(() => hub.follow(join(rootB, 'link.log')), /outside/)
  hub.dispose()
})

test('resolveFollowPath matches an absolute path against every configured root', () => {
  const settings = testConfig({ followRoots: ['/srv/one', '/srv/two'] })
  assert.equal(resolveFollowPath('/srv/two/log/run.log', settings), '/srv/two/log/run.log')
  assert.equal(resolveFollowPath('/srv/one/run.log', settings), '/srv/one/run.log')
  // A relative path keeps the historical default: the first root, in panel order.
  assert.equal(resolveFollowPath('run.log', settings), '/srv/one/run.log')
})

test('a single root keeps the exact wording it always had', () => {
  const settings = testConfig({ followRoot: '/srv/project' })
  assert.equal(resolveFollowPath('run.log', settings), '/srv/project/run.log')
  assert.equal(resolveFollowPath('/srv/project/sub/run.log', settings), '/srv/project/sub/run.log')
  // Regression pin, not just /outside/: with one root the message is byte-identical
  // to the one the panel has always shown.
  assert.throws(
    () => resolveFollowPath('/etc/passwd', settings),
    { message: 'follow path "/etc/passwd" is outside /srv/project' },
  )
  assert.throws(
    () => resolveFollowPath('../etc/passwd', settings),
    { message: 'follow path "../etc/passwd" is outside /srv/project' },
  )
})
