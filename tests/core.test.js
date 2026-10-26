import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildArgs,
  defaultStateFile,
  normalizeRunOptions,
  resolveConfig,
} from '../src/core/config.js'
import {
  classifyLine,
  createSummary,
  deriveStatus,
  observeLine,
  summarize,
} from '../src/core/parse.js'
import { createHub, drainLines } from '../src/core/runner.js'
import { createSessionResolver } from '../src/core/session.js'
import { createRunStore } from '../src/core/store.js'

test('resolveConfig keeps defaults and rejects unsafe executables', () => {
  const settings = resolveConfig(undefined)
  assert.equal(settings.command, 'go')
  assert.deepEqual(settings.baseArgs, ['test'])
  assert.equal(settings.cwd, null)
  // Bounded in-memory history; durable history is longer (historyRuns).
  assert.equal(settings.maxRuns, 30)
  assert.equal(settings.historyRuns, 100)
  assert.equal(settings.historyLines, 200)
  assert.equal(settings.defaultScope, 'all')
  assert.equal(settings.followRoots.length, 0)
  assert.throws(() => resolveConfig({ command: 'rm -rf /' }), /plain executable name/)
  assert.throws(() => resolveConfig({ command: './go' }), /plain executable name/)
  assert.equal(resolveConfig({ command: '/usr/local/go/bin/go' }).command, '/usr/local/go/bin/go')
  assert.throws(() => resolveConfig({ cwd: 'relative/dir' }), /absolute path/)
})

test('resolveConfig derives a global state file and validates it', () => {
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/tmp/dsh-home-for-test'
    assert.equal(defaultStateFile(), '/tmp/dsh-home-for-test/test-live/runs.json')
    assert.equal(resolveConfig({}).stateFile, '/tmp/dsh-home-for-test/test-live/runs.json')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  // An explicit null disables persistence; a relative path is refused.
  assert.equal(resolveConfig({ stateFile: null }).stateFile, null)
  assert.equal(resolveConfig({ stateFile: '/var/tmp/x.json' }).stateFile, '/var/tmp/x.json')
  assert.throws(() => resolveConfig({ stateFile: 'relative/runs.json' }), /absolute path or null/)
  assert.equal(resolveConfig({ defaultScope: 'session' }).defaultScope, 'session')
  assert.equal(resolveConfig({ defaultScope: 'bogus' }).defaultScope, 'all')
})

test('resolveConfig stringifies env values', () => {
  const settings = resolveConfig({ env: { DEBUG: 1, FLAG: true, SKIP: null } })
  assert.deepEqual(settings.env, { DEBUG: '1', FLAG: 'true' })
})

test('normalizeRunOptions defaults to the whole module', () => {
  const settings = resolveConfig({})
  const options = normalizeRunOptions({}, settings)
  assert.deepEqual(options.packages, ['./...'])
  assert.equal(options.verbose, false)
  assert.equal(options.timeoutSec, 900)
})

test('normalizeRunOptions rejects injection-shaped patterns', () => {
  const settings = resolveConfig({})
  assert.throws(() => normalizeRunOptions({ packages: ['/etc/passwd'] }, settings), /not allowed/)
  assert.throws(() => normalizeRunOptions({ packages: ['./x; rm -rf /'] }, settings), /not allowed/)
  assert.throws(() => normalizeRunOptions({ pattern: 'TestX; rm' }, settings), /unsupported characters/)
})

test('buildArgs renders the go test flags', () => {
  const settings = resolveConfig({})
  const options = normalizeRunOptions(
    { packages: ['./database/...'], verbose: true, race: true, count: true, pattern: 'TestApply', timeoutSec: 60 },
    settings,
  )
  assert.deepEqual(buildArgs(options, settings.kind), [
    '-v', '-race', '-count=1', '-run=TestApply', '-timeout=60s', './database/...',
  ])
  // kind=command runs exactly the configured command.
  assert.deepEqual(buildArgs(options, 'command'), [])
})

test('classifyLine labels the go test markers', () => {
  const cases = [
    ['=== RUN   TestA', 'run'],
    ['=== PAUSE TestA', 'run'],
    ['--- PASS: TestA (0.00s)', 'pass'],
    ['--- FAIL: TestB/sub (0.01s)', 'fail'],
    ['--- SKIP: TestC (0.00s)', 'skip'],
    ['ok  \tgithub.com/x/y\t0.123s', 'package-ok'],
    ['FAIL\tgithub.com/x/y\t0.456s', 'package-fail'],
    ['?\tgithub.com/x/y\t[no test files]', 'package-empty'],
    ['# github.com/x/y', 'build'],
    ['PASS', 'result'],
    ['panic: boom', 'panic'],
    ['some output', 'plain'],
  ]
  for (const [line, want] of cases) assert.equal(classifyLine(line), want, line)
})

test('observeLine folds markers into the summary', () => {
  const summary = createSummary()
  const lines = [
    '=== RUN   TestA',
    '--- PASS: TestA (0.00s)',
    '--- FAIL: TestB (0.01s)',
    '--- SKIP: TestC (0.00s)',
    '--- FAIL: TestD (0.00s)',
    'ok  \tpkg/one\t0.1s',
    'FAIL\tpkg/two\t0.2s',
    '?\tpkg/three\t[no test files]',
    '# pkg/broken',
    'coverage: 81.2% of statements',
  ]
  for (const line of lines) observeLine(summary, line)
  assert.equal(summary.tests.pass, 1)
  assert.equal(summary.tests.fail, 2)
  assert.equal(summary.tests.skip, 1)
  assert.deepEqual(summary.failures, ['TestB', 'TestD'])
  assert.deepEqual(summary.packages.ok, ['pkg/one'])
  assert.deepEqual(summary.packages.fail, ['pkg/two'])
  assert.deepEqual(summary.packages.noTest, ['pkg/three'])
  assert.deepEqual(summary.buildErrors, ['pkg/broken'])
  assert.deepEqual(summary.coverage, ['81.2% of statements'])
})

test('deriveStatus maps exit code, cancellation and timeouts', () => {
  const clean = createSummary()
  assert.equal(deriveStatus(0, false, false, clean), 'passed')
  assert.equal(deriveStatus(1, false, false, clean), 'failed')
  assert.equal(deriveStatus(null, true, false, clean), 'canceled')
  assert.equal(deriveStatus(null, false, true, clean), 'failed')
  const withFailure = createSummary()
  withFailure.tests.fail = 1
  assert.equal(deriveStatus(0, false, false, withFailure), 'failed')
})

test('summarize reports counters and duration', () => {
  const summary = createSummary()
  summary.packages.ok.push('a', 'b')
  summary.tests.pass = 3
  const text = summarize({ status: 'passed', durationMs: 1500, summary })
  assert.match(text, /passed in 1\.5s/)
  assert.match(text, /2 packages ok/)
  assert.match(text, /3 passed \/ 0 failed \/ 0 skipped/)
})

test('drainLines keeps the incomplete tail as carry', () => {
  const first = drainLines('a\nb\nc', '')
  assert.deepEqual(first.lines, ['a', 'b'])
  assert.equal(first.carry, 'c')
  const second = drainLines('d\n', first.carry)
  assert.deepEqual(second.lines, ['cd'])
  assert.equal(second.carry, '')
  // A CRLF chunk must not leak the CR into the rendered line.
  assert.deepEqual(drainLines('x\r\n', '').lines, ['x'])
})

test('session resolver reads the host services and degrades quietly', () => {
  const session = { id: 'session-a', header: { cwd: '/repo/a', title: 'Fix A' } }
  const titles = new Map([[session, { title: 'Fix A (live)' }]])
  const ctx = {
    sessions: {
      get: id => (id === 'session-a' ? session : undefined),
      list: () => [session, { id: 'session-b', header: { cwd: '/repo/b' } }],
    },
    workingDirectory: { get: input => (input === session ? '/repo/a' : undefined) },
    sessionTitle: { get: input => titles.get(input) },
  }
  const resolver = createSessionResolver(ctx)
  assert.deepEqual(resolver.describe(session), {
    sessionId: 'session-a',
    sessionLabel: 'Fix A (live)',
    cwd: '/repo/a',
  })
  assert.deepEqual(resolver.describe('session-a'), {
    sessionId: 'session-a',
    sessionLabel: 'Fix A (live)',
    cwd: '/repo/a',
  })
  // Unknown id: the id survives, the rest is null (never a throw).
  assert.deepEqual(resolver.describe('session-missing'), {
    sessionId: 'session-missing',
    sessionLabel: null,
    cwd: null,
  })
  assert.deepEqual(resolver.describe(undefined), { sessionId: null, sessionLabel: null, cwd: null })
  assert.deepEqual(resolver.describe('   '), { sessionId: null, sessionLabel: null, cwd: null })
  assert.deepEqual(
    resolver.list().map(entry => entry.sessionId),
    ['session-a', 'session-b'],
  )
  // A host without any of the services, or one whose services throw.
  assert.deepEqual(createSessionResolver({}).describe('session-a'), {
    sessionId: 'session-a',
    sessionLabel: null,
    cwd: null,
  })
  assert.deepEqual(createSessionResolver(undefined).list(), [])
  const angry = {
    sessions: {
      get() {
        throw new Error('boom')
      },
      list() {
        throw new Error('boom')
      },
    },
    workingDirectory: {
      get() {
        throw new Error('boom')
      },
    },
    sessionTitle: {
      get() {
        throw new Error('boom')
      },
    },
  }
  const broken = createSessionResolver(angry)
  assert.deepEqual(broken.describe('session-a'), {
    sessionId: 'session-a',
    sessionLabel: null,
    cwd: null,
  })
  assert.deepEqual(broken.list(), [])
})

test('run store round-trips, trims and survives a corrupt file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-store-test-'))
  try {
    const stateFile = join(dir, 'nested', 'runs.json')
    const store = createRunStore({ stateFile, historyRuns: 2, historyLines: 2, delayMs: 0 })
    const run = id => ({
      id,
      kind: 'command',
      status: 'passed',
      command: 'go',
      args: ['test'],
      cwd: '/repo',
      sessionId: 'session-a',
      startedAt: 1,
      finishedAt: 2,
      durationMs: 1,
      lastSeq: 3,
      summary: { tests: { pass: 1, fail: 0, skip: 0 } },
      lines: [
        { seq: 1, text: 'one', kind: 'plain', provisional: false },
        { seq: 2, text: 'two', kind: 'plain' },
        { seq: 3, text: 'three', kind: 'plain' },
      ],
    })
    store.save([run('run_a'), run('run_b'), run('run_c')])
    assert.equal(store.flush(), true)
    const loaded = createRunStore({ stateFile }).load()
    // historyRuns = 2 keeps the newest two runs, historyLines = 2 the tail.
    assert.deepEqual(loaded.map(record => record.id), ['run_b', 'run_c'])
    assert.deepEqual(loaded[1].lines.map(line => line.text), ['two', 'three'])
    assert.equal(loaded[1].lines[0].provisional, undefined)
    assert.equal(loaded[1].sessionId, 'session-a')
    assert.equal(loaded[1].lastSeq, 3)

    // Corrupt file: no history, no throw.
    writeFileSync(stateFile, '{not json')
    assert.deepEqual(createRunStore({ stateFile }).load(), [])
    // Missing file: no history, no throw.
    assert.deepEqual(createRunStore({ stateFile: join(dir, 'nothing.json') }).load(), [])
    // Disabled store: load/save/flush are no-ops.
    const disabled = createRunStore({ stateFile: null })
    assert.equal(disabled.enabled, false)
    disabled.save([run('run_a')])
    assert.equal(disabled.flush(), false)
    assert.deepEqual(disabled.load(), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the hub loads archived history before the first request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-store-test-'))
  try {
    const stateFile = join(dir, 'runs.json')
    const store = createRunStore({ stateFile })
    store.save([
      {
        id: 'run_old',
        kind: 'command',
        status: 'passed',
        command: 'go',
        args: ['test'],
        cwd: '/repo',
        sessionId: 'session-a',
        startedAt: 1,
        finishedAt: 2,
        lines: [{ seq: 1, text: 'ok  \tpkg/a\t0.1s', kind: 'package-ok' }],
      },
    ])
    store.flush()
    const hub = createHub(resolveConfig({ stateFile }), { spawn: () => assert.fail('must not spawn') })
    assert.equal(hub.list().length, 1)
    assert.equal(hub.list()[0].archived, true)
    assert.equal(hub.list()[0].status, 'passed')
    assert.equal(hub.linesSince('run_old', -1)[0].text, 'ok  \tpkg/a\t0.1s')
    assert.equal(hub.sessions()[0].count, 1)
    hub.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
