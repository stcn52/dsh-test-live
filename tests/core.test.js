import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildArgs,
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
import { drainLines } from '../src/core/runner.js'

test('resolveConfig keeps defaults and rejects unsafe executables', () => {
  const settings = resolveConfig(undefined)
  assert.equal(settings.command, 'go')
  assert.deepEqual(settings.baseArgs, ['test'])
  assert.equal(settings.cwd, null)
  assert.equal(settings.maxRuns, 8)
  assert.throws(() => resolveConfig({ command: 'rm -rf /' }), /plain executable name/)
  assert.throws(() => resolveConfig({ command: './go' }), /plain executable name/)
  assert.equal(resolveConfig({ command: '/usr/local/go/bin/go' }).command, '/usr/local/go/bin/go')
  assert.throws(() => resolveConfig({ cwd: 'relative/dir' }), /absolute path/)
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
