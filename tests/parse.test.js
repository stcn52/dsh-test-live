/**
 * The per-runner output grammars, checked against the real captured output in
 * `tests/fixtures/`.
 *
 * Every expectation is written twice on purpose: once as a hand-written number
 * (what the grammar must produce) and once as a regex over the runner's *own*
 * summary sentence in the same file (what the runner says it did). When the two
 * disagree the test fails, so a grammar cannot drift quietly.
 *
 * Run with: node --test tests/parse.test.js
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  LINE_KINDS,
  classifyLine,
  createSummary,
  deriveStatus,
  failureName,
  failureWhere,
  grammarLabels,
  migrateSummary,
  observeLine,
  summarize,
  summaryCounts,
} from '../src/core/parse.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

const ZERO = { suites: { ok: 0, fail: 0, noTest: 0, total: 0 }, tests: { pass: 0, fail: 0, skip: 0 }, failures: 0, buildErrors: 0 }

/**
 * Feed one fixture file through the parser exactly as the runner would.
 * @param dir - fixture subdirectory (= runner family).
 * @param file - fixture file name.
 * @param runner - runner id, or undefined to exercise the legacy default.
 * @returns { text, summary, lines, counts } where lines keeps text+kind.
 */
function replay(dir, file, runner) {
  const text = readFileSync(join(FIXTURES, dir, file), 'utf8')
  const summary = createSummary(runner)
  const lines = []
  for (const line of text.split('\n')) {
    const kind = classifyLine(line, runner)
    lines.push({ text: line, kind })
    observeLine(summary, line, runner)
  }
  return { text, summary, lines, counts: summaryCounts(summary) }
}

/** `{ ok, fail, noTest }` -> counter object used by the tables below. */
function suites(ok, fail, noTest = 0) {
  return { ok, fail, noTest, total: ok + fail }
}

function tests(pass, fail, skip = 0) {
  return { pass, fail, skip }
}

/**
 * What the runner printed about itself, read with regexes that know nothing
 * about the grammar's internals.
 * @param text - whole fixture text.
 * @param runner - runner id.
 * @returns partial counts; a missing key means "this runner does not print it".
 */
function toolCounts(text, runner) {
  const out = {}
  const pairs = sentence => {
    const found = {}
    const pattern = /(\d+)\s+(passed|failed|skipped)/g
    let match
    while ((match = pattern.exec(sentence)) !== null) found[match[2]] = Number(match[1])
    return found
  }
  if (runner === 'go') {
    out.tests = tests(
      (text.match(/^--- PASS:/gm) ?? []).length,
      (text.match(/^--- FAIL:/gm) ?? []).length,
      (text.match(/^--- SKIP:/gm) ?? []).length,
    )
    out.suites = suites(
      (text.match(/^ok\s+\S/m) ?? []).length,
      (text.match(/^FAIL\s+\S/m) ?? []).length,
      (text.match(/^\?\s+\S/m) ?? []).length,
    )
  }
  if (runner === 'vitest') {
    const files = /^\s*Test Files\s+(\d+) (passed|failed) \((\d+)\)$/m.exec(text)
    const totals = /^\s*Tests\s+(.+?)\((\d+)\)\s*$/m.exec(text)
    if (files) out.suitesTotal = Number(files[3])
    if (totals) {
      const found = pairs(totals[1])
      out.tests = tests(found.passed ?? 0, found.failed ?? 0, found.skipped ?? 0)
      out.testsTotal = Number(totals[2])
    }
  }
  if (runner === 'jest') {
    const suitesLine = /^Test Suites:\s*(.+)$/m.exec(text)
    const testsLine = /^Tests:\s*(.+)$/m.exec(text)
    if (suitesLine) {
      const found = pairs(suitesLine[1])
      out.suitesTotal = (found.passed ?? 0) + (found.failed ?? 0)
    }
    if (testsLine) {
      const found = pairs(testsLine[1])
      out.tests = tests(found.passed ?? 0, found.failed ?? 0, found.skipped ?? 0)
      out.testsTotal = Number(/(\d+) total/.exec(testsLine[1])?.[1] ?? NaN)
    }
  }
  if (runner === 'nodeTest') {
    const tap = key => Number(new RegExp(`^# ${key} (\\d+)$`, 'm').exec(text)?.[1] ?? NaN)
    const spec = key => Number(new RegExp(`^\u2139 ${key} (\\d+)$`, 'm').exec(text)?.[1] ?? NaN)
    const counter = (a, b) => (Number.isNaN(tap(a)) ? spec(a) : tap(a))
    out.tests = tests(counter('pass'), counter('fail'), Number.isNaN(tap('skipped')) ? spec('skipped') : tap('skipped'))
    out.testsTotal = Number.isNaN(tap('tests')) ? spec('tests') : tap('tests')
    const suitesTotal = Number.isNaN(tap('suites')) ? spec('suites') : tap('suites')
    if (!Number.isNaN(suitesTotal)) out.suitesTotal = suitesTotal
  }
  if (runner === 'pytest') {
    const tail = /^=+\s+(.+?)\s+in\s+[\d.]+s\s+=+$/m.exec(text)
    if (tail) out.tests = tests(pairs(tail[1]).passed ?? 0, pairs(tail[1]).failed ?? 0, pairs(tail[1]).skipped ?? 0)
    const collected = /^collecting \.\.\. collected (\d+) items?/m.exec(text)
    if (collected) out.collected = Number(collected[1])
  }
  return out
}

/**
 * One row per fixture: what the grammar must produce, and (via toolCounts) what
 * the runner itself recorded in the same file.
 */
const FIXTURES_TABLE = [
  // go — assembled from the repo's own captured lines, see fixtures/PROVENANCE.md
  { dir: 'go', file: 'go-pass.txt', runner: 'go', suites: suites(1, 0), tests: tests(1, 0), failures: 0, buildErrors: 0, coverage: ['81.2% of statements'] },
  { dir: 'go', file: 'go-fail.txt', runner: 'go', suites: suites(0, 1), tests: tests(0, 1), failures: 1, buildErrors: 0 },
  { dir: 'go', file: 'go-mixed.txt', runner: 'go', suites: suites(1, 1, 1), tests: tests(0, 0), failures: 0, buildErrors: 0 },
  { dir: 'go', file: 'go-skip.txt', runner: 'go', suites: suites(1, 0), tests: tests(0, 0, 1), failures: 0, buildErrors: 0 },
  { dir: 'go', file: 'go-subtests.txt', runner: 'go', suites: suites(0, 0), tests: tests(0, 2), failures: 2, buildErrors: 0 },
  // `# pkg` + `FAIL pkg` is the 0.2.0 behaviour: the package is both failed and a build error.
  { dir: 'go', file: 'go-build.txt', runner: 'go', suites: suites(0, 1), tests: tests(0, 0), failures: 0, buildErrors: 1 },
  { dir: 'go', file: 'go-panic.txt', runner: 'go', suites: suites(0, 1), tests: tests(0, 0), failures: 0, buildErrors: 0 },

  // vitest — totals from ` Test Files` / ` Tests`
  { dir: 'vitest', file: 'vitest-pass.txt', runner: 'vitest', suites: suites(1, 0), tests: tests(2, 0), failures: 0, buildErrors: 0 },
  { dir: 'vitest', file: 'vitest-fail.txt', runner: 'vitest', suites: suites(0, 1), tests: tests(1, 1), failures: 1, buildErrors: 0 },

  // jest — totals from `Test Suites:` / `Tests:`
  { dir: 'jest', file: 'jest-pass.txt', runner: 'jest', suites: suites(1, 0), tests: tests(1, 0), failures: 0, buildErrors: 0 },
  { dir: 'jest', file: 'jest-fail.txt', runner: 'jest', suites: suites(0, 1), tests: tests(0, 1), failures: 1, buildErrors: 0 },

  // node --test, TAP shape
  { dir: 'node-test', file: 'node-test-pass.txt', runner: 'nodeTest', suites: suites(0, 0), tests: tests(2, 0), failures: 0, buildErrors: 0 },
  { dir: 'node-test', file: 'node-test-fail.txt', runner: 'nodeTest', suites: suites(0, 0), tests: tests(0, 1), failures: 1, buildErrors: 0 },
  { dir: 'node-test', file: 'node-test-all.txt', runner: 'nodeTest', suites: suites(0, 0), tests: tests(2, 1), failures: 1, buildErrors: 0 },
  { dir: 'node-test', file: 'pnpm-test-all.txt', runner: 'nodeTest', suites: suites(0, 0), tests: tests(2, 1), failures: 1, buildErrors: 0 },
  { dir: 'node-test', file: 'node-test-module-error.txt', runner: 'nodeTest', suites: suites(0, 0), tests: tests(0, 1), failures: 1, buildErrors: 1 },
  { dir: 'node-test', file: 'node-test-syntax-error.txt', runner: 'nodeTest', suites: suites(0, 0), tests: tests(0, 1), failures: 1, buildErrors: 1 },

  // node --test, spec shape (the descriptor's default reporter)
  { dir: 'node-test', file: 'node-test-spec-pass.txt', runner: 'nodeTest', suites: suites(0, 0), tests: tests(2, 0), failures: 0, buildErrors: 0 },
  { dir: 'node-test', file: 'node-test-spec-fail.txt', runner: 'nodeTest', suites: suites(0, 0), tests: tests(0, 1), failures: 1, buildErrors: 0 },
  { dir: 'node-test', file: 'node-test-spec-all.txt', runner: 'nodeTest', suites: suites(0, 0), tests: tests(2, 1), failures: 1, buildErrors: 0 },
  { dir: 'node-test', file: 'node-test-spec-suites.txt', runner: 'nodeTest', suites: suites(1, 1), tests: tests(2, 1), failures: 1, buildErrors: 0 },
  { dir: 'node-test', file: 'node-test-spec-load-error.txt', runner: 'nodeTest', suites: suites(0, 0), tests: tests(0, 1), failures: 1, buildErrors: 1 },
  { dir: 'node-test', file: 'node-test-spec-syntax-error.txt', runner: 'nodeTest', suites: suites(0, 0), tests: tests(0, 1), failures: 1, buildErrors: 1 },

  // pytest — `collected N items` and the `… in 0.01s` tail
  { dir: 'pytest', file: 'pytest-pass.txt', runner: 'pytest', suites: suites(1, 0), tests: tests(2, 0, 1), failures: 0, buildErrors: 0 },
  { dir: 'pytest', file: 'pytest-fail.txt', runner: 'pytest', suites: suites(0, 1), tests: tests(1, 1), failures: 1, buildErrors: 0 },
  { dir: 'pytest', file: 'pytest-mixed.txt', runner: 'pytest', suites: suites(1, 1), tests: tests(3, 1, 1), failures: 1, buildErrors: 0 },
  { dir: 'pytest', file: 'pytest-collect-error.txt', runner: 'pytest', suites: suites(0, 0), tests: tests(0, 0), failures: 0, buildErrors: 1 },
  { dir: 'pytest', file: 'pytest-syntax-error.txt', runner: 'pytest', suites: suites(0, 0), tests: tests(0, 0), failures: 0, buildErrors: 1 },
]

test('every fixture parses to the counts the runner itself printed', () => {
  assert.ok(FIXTURES_TABLE.length >= 26, 'the fixture table must cover every captured file')
  for (const row of FIXTURES_TABLE) {
    const { text, counts } = replay(row.dir, row.file, row.runner)
    const label = `${row.dir}/${row.file}`
    assert.deepEqual(counts.suites, row.suites, `${label}: suites`)
    assert.deepEqual(counts.tests, row.tests, `${label}: tests`)
    assert.equal(counts.failures, row.failures, `${label}: failures`)
    assert.equal(counts.buildErrors, row.buildErrors, `${label}: buildErrors`)

    // Independent cross-check against the runner's own summary numbers.
    const claimed = toolCounts(text, row.runner)
    if (claimed.tests) assert.deepEqual(counts.tests, claimed.tests, `${label}: runner said its own test counts`)
    if (Number.isFinite(claimed.testsTotal)) {
      const total = counts.tests.pass + counts.tests.fail + counts.tests.skip
      assert.equal(total, claimed.testsTotal, `${label}: runner's test total`)
    }
    if (Number.isFinite(claimed.suitesTotal)) {
      assert.equal(counts.suites.total, claimed.suitesTotal, `${label}: runner's suite total`)
    }
    if (Number.isFinite(claimed.collected)) {
      const total = counts.tests.pass + counts.tests.fail + counts.tests.skip
      assert.equal(total, claimed.collected, `${label}: pytest collected items`)
    }
  }
})

test('coverage lines are kept for the go grammar', () => {
  const { summary } = replay('go', 'go-pass.txt', 'go')
  assert.deepEqual(summary.coverage, ['81.2% of statements'])
})

// ---------------------------------------------------------------------------
// Legacy behaviour: no runner id must still be exactly the 0.2.0 Go parser.
// ---------------------------------------------------------------------------

test('without a runner id classifyLine labels the go test markers', () => {
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
  for (const [line, want] of cases) {
    assert.equal(classifyLine(line), want, line)
    assert.equal(classifyLine(line, 'go'), want, `${line} (explicit go)`)
  }
})

test('without a runner id observeLine folds go markers into the summary', () => {
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
  assert.deepEqual(summary.suites.ok, ['pkg/one'])
  assert.deepEqual(summary.suites.fail, ['pkg/two'])
  assert.deepEqual(summary.suites.noTest, ['pkg/three'])
  // The pre-rename name still reads the same buckets.
  assert.deepEqual(summary.packages, summary.suites)
  assert.deepEqual(summary.packages.ok, ['pkg/one'])
  assert.deepEqual(summary.buildErrors, ['pkg/broken'])
  assert.deepEqual(summary.coverage, ['81.2% of statements'])
})

test('without a runner id every go fixture parses identically to runnerId="go"', () => {
  for (const row of FIXTURES_TABLE.filter(item => item.runner === 'go')) {
    const legacy = replay(row.dir, row.file, undefined)
    const named = replay(row.dir, row.file, 'go')
    assert.deepEqual(legacy.counts, named.counts, row.file)
    assert.deepEqual(legacy.summary.failures, named.summary.failures, row.file)
  }
})

test('without a runner id deriveStatus and summarize keep the 0.2.0 answers', () => {
  const clean = createSummary()
  assert.equal(deriveStatus(0, false, false, clean), 'passed')
  assert.equal(deriveStatus(1, false, false, clean), 'failed')
  assert.equal(deriveStatus(null, true, false, clean), 'canceled')
  assert.equal(deriveStatus(null, false, true, clean), 'failed')
  const withFailure = createSummary()
  withFailure.tests.fail = 1
  assert.equal(deriveStatus(0, false, false, withFailure), 'failed')

  const summary = createSummary()
  summary.suites.ok.push('a', 'b')
  summary.tests.pass = 3
  const text = summarize({ status: 'passed', durationMs: 1500, summary })
  assert.match(text, /^passed in 1\.5s · 2 packages ok · 3 passed \/ 0 failed \/ 0 skipped$/)
})

// ---------------------------------------------------------------------------
// Anti-misjudgement: none of the new shapes may look like a Go build error or
// a Go package result.
// ---------------------------------------------------------------------------

test('node --test TAP bookkeeping is not a build error and not a package', () => {
  const { lines } = replay('node-test', 'node-test-all.txt', 'nodeTest')
  const kindOf = new Map(lines.map(line => [line.text, line.kind]))
  assert.equal(kindOf.get('# Subtest: adds two numbers'), 'test')
  assert.equal(kindOf.get('# tests 3'), 'result')
  assert.equal(kindOf.get('# pass 2'), 'result')
  assert.equal(kindOf.get('# duration_ms 100.573209'), 'result')
  assert.equal(kindOf.get('1..3'), 'result')
  assert.equal(kindOf.get('ok 2 - adds two numbers'), 'pass')
  assert.equal(kindOf.get('not ok 1 - fails on purpose'), 'fail')
  for (const line of lines) {
    assert.ok(!['build', 'package-ok', 'package-fail', 'package-empty'].includes(line.kind), `misfired on: ${line.text}`)
  }
})

test('vitest and jest never produce a go kind', () => {
  for (const row of FIXTURES_TABLE.filter(item => item.runner === 'vitest' || item.runner === 'jest')) {
    for (const line of replay(row.dir, row.file, row.runner).lines) {
      assert.notEqual(line.kind, 'build', `${row.file}: ${line.text}`)
      assert.notEqual(line.kind, 'package-ok', `${row.file}: ${line.text}`)
      assert.notEqual(line.kind, 'package-fail', `${row.file}: ${line.text}`)
      assert.notEqual(line.kind, 'package-empty', `${row.file}: ${line.text}`)
    }
  }
})

test('only a file that failed to load becomes a node --test build error', () => {
  const clean = replay('node-test', 'node-test-all.txt', 'nodeTest')
  assert.deepEqual(clean.summary.buildErrors, [])
  const moduleError = replay('node-test', 'node-test-module-error.txt', 'nodeTest')
  assert.deepEqual(moduleError.summary.buildErrors, ['test/_badimport.test.js'])
  const syntaxError = replay('node-test', 'node-test-syntax-error.txt', 'nodeTest')
  assert.deepEqual(syntaxError.summary.buildErrors, ['test/_syntax.test.js'])
  // A plain assertion diagnostic must never be promoted to a build error.
  const specFail = replay('node-test', 'node-test-spec-fail.txt', 'nodeTest')
  assert.deepEqual(specFail.summary.buildErrors, [])
})

test('vitest and jest failures are test failures, not build errors', () => {
  assert.deepEqual(replay('vitest', 'vitest-fail.txt', 'vitest').summary.buildErrors, [])
  assert.deepEqual(replay('jest', 'jest-fail.txt', 'jest').summary.buildErrors, [])
  assert.deepEqual(replay('pytest', 'pytest-fail.txt', 'pytest').summary.buildErrors, [])
})

// ---------------------------------------------------------------------------
// Unknown runners count nothing.
// ---------------------------------------------------------------------------

test('an unknown runner only colours plain/panic/result and invents no counts', () => {
  const everyFixture = FIXTURES_TABLE.map(row => [row.dir, row.file])
  for (const runnerId of ['generic', 'cargo', 'ruby']) {
    for (const [dir, file] of everyFixture) {
      const { summary, lines } = replay(dir, file, runnerId)
      assert.deepEqual(summaryCounts(summary), ZERO, `${runnerId} ${dir}/${file}: no counts`)
      for (const line of lines) {
        assert.ok(['plain', 'panic', 'result'].includes(line.kind), `${runnerId} ${dir}/${file}: ${line.text} -> ${line.kind}`)
      }
    }
  }
})

test('a package.json script is counted from the aggregate lines it prints', () => {
  // `script` runs whatever package.json says, so it may print node --test, vitest,
  // jest or pytest output. Its grammar only reads the aggregate sentences those
  // tools share, and must land on the same test counters as the runner's own
  // grammar for the same captured output.
  const rows = []
  for (const dir of readdirSync(FIXTURES)) {
    const path = join(FIXTURES, dir)
    if (!statSync(path).isDirectory()) continue
    // `go test` prints none of the aggregate sentences a script shares; that is
    // why a Go module detects as `go` in the first place.
    if (dir === 'go') continue
    for (const file of readdirSync(path).filter(name => name.endsWith('.txt'))) rows.push([dir, file])
  }
  assert.ok(rows.length >= 15, `fixture table too small: ${rows.length}`)
  let counted = 0
  for (const [dir, file] of rows) {
    const native = dir === 'node-test' ? 'nodeTest' : dir
    const ours = replay(dir, file, 'script').counts.tests
    const theirs = replay(dir, file, native).counts.tests
    assert.deepEqual(ours, theirs, `script grammar must agree with ${native} on ${dir}/${file}`)
    if (ours.pass + ours.fail + ours.skip > 0) counted++
  }
  assert.ok(counted >= 15, `expected nearly every fixture to carry counts, got ${counted}`)
})

test('a generic summary prints no suite or test clause', () => {
  const summary = createSummary('cargo')
  for (const line of ['ok 1 - adds', '=== RUN   TestA', 'Test Files  1 passed (1)', '1..2']) observeLine(summary, line, 'cargo')
  assert.deepEqual(summaryCounts(summary), ZERO)
  const text = summarize({ status: 'failed', durationMs: 300, summary }, 'cargo')
  assert.equal(text, 'failed in 0.3s')
})

test('summarize still says PASS / panic for an unknown runner', () => {
  assert.equal(classifyLine('PASS', 'generic'), 'result')
  assert.equal(classifyLine('fatal error: out of memory', 'generic'), 'panic')
  assert.equal(classifyLine('--- FAIL: TestA (0.00s)', 'generic'), 'plain')
})

// ---------------------------------------------------------------------------
// Failure entries: go keeps the 0.2.0 strings, the newer grammars carry where.
// ---------------------------------------------------------------------------

test('go failures stay bare strings and the newer grammars carry a location', () => {
  const goEntry = replay('go', 'go-fail.txt', 'go').summary.failures[0]
  assert.equal(typeof goEntry, 'string')
  assert.equal(failureName(goEntry), 'TestB')
  assert.equal(failureWhere(goEntry), '')

  const expected = [
    ['vitest', 'vitest-fail.txt', 'vitest', 'fails on purpose', 'tests/fail.test.js:9'],
    ['jest', 'jest-fail.txt', 'jest', 'fails on purpose', 'tests/fail.test.js:5'],
    ['node-test', 'node-test-spec-suites.txt', 'nodeTest', 'fails', 'test/calc.test.js:7'],
    ['pytest', 'pytest-mixed.txt', 'pytest', 'test_fails_on_purpose', 'tests/test_broken.py:9'],
  ]
  for (const [dir, file, runner, name, where] of expected) {
    const entries = replay(dir, file, runner).summary.failures
    assert.equal(entries.length, 1, `${file}: one entry per failing test, not one per line that mentions it`)
    assert.deepEqual(entries[0], { name, where }, file)
  }
})

// ---------------------------------------------------------------------------
// The summary contract itself.
// ---------------------------------------------------------------------------

test('createSummary exposes suites and the non-enumerable packages alias', () => {
  const summary = createSummary()
  assert.deepEqual(Object.keys(summary).sort(), ['buildErrors', 'coverage', 'failures', 'suites', 'tests'])
  assert.equal(summary.packages, summary.suites)
  assert.equal(JSON.stringify(summary).includes('packages'), false)
  assert.deepEqual(JSON.parse(JSON.stringify(summary)).suites, { ok: [], fail: [], noTest: [] })
})

test('LINE_KINDS keeps the go kinds for the stylesheet and adds the neutral ones', () => {
  for (const kind of ['package-ok', 'package-fail', 'package-empty', 'build']) assert.ok(LINE_KINDS.includes(kind), kind)
  for (const kind of ['suite', 'test', 'error', 'result', 'panic']) assert.ok(LINE_KINDS.includes(kind), kind)
})

test('migrateSummary lifts packages to suites and stays streamable', () => {
  const stored = {
    packages: { ok: ['pkg/one'], fail: ['pkg/two'], noTest: ['pkg/three'] },
    tests: { pass: 3, fail: 1, skip: 0 },
    failures: ['TestB'],
    buildErrors: ['pkg/broken'],
    coverage: ['81.2% of statements'],
  }
  const summary = migrateSummary(stored)
  assert.deepEqual(summary.suites, stored.packages)
  assert.deepEqual(summary.packages, stored.packages)
  assert.deepEqual(summary.failures, ['TestB'])
  assert.deepEqual(summary.buildErrors, ['pkg/broken'])
  // Further output keeps folding into the restored buckets.
  observeLine(summary, '--- FAIL: TestB (0.01s)', 'go')
  assert.equal(summary.tests.fail, 2)
  assert.equal(summaryCounts(summary).suites.total, 2)
})

test('migrateSummary tolerates null, empty and half-written records', () => {
  for (const input of [null, undefined, {}, { packages: null }, { suites: { ok: 'nope' } }]) {
    assert.deepEqual(summaryCounts(migrateSummary(input)), ZERO, JSON.stringify(input))
  }
})

test('observeLine without a runner id uses the id the summary was created with', () => {
  const summary = createSummary('vitest')
  observeLine(summary, ' Test Files  1 passed (1)')
  observeLine(summary, ' Tests  2 passed (2)')
  assert.equal(summaryCounts(summary).suites.ok, 1)
  assert.equal(summaryCounts(summary).tests.pass, 2)
})

test('deriveStatus honours failing suites of any runner', () => {
  const summary = createSummary('vitest')
  observeLine(summary, ' Test Files  1 failed (1)', 'vitest')
  assert.equal(deriveStatus(0, false, false, summary, 'vitest'), 'failed')
  assert.equal(deriveStatus(0, false, false, createSummary('vitest'), 'vitest'), 'passed')
})

test('summarize names the unit each runner actually runs', () => {
  const vitestPass = replay('vitest', 'vitest-pass.txt', 'vitest').summary
  assert.equal(summarize({ status: 'passed', durationMs: 200, summary: vitestPass }, 'vitest'), 'passed in 0.2s · 1 file ok · 2 passed / 0 failed / 0 skipped')

  const jestPass = replay('jest', 'jest-pass.txt', 'jest').summary
  assert.equal(summarize({ status: 'passed', durationMs: 200, summary: jestPass }, 'jest'), 'passed in 0.2s · 1 suite ok · 1 passed / 0 failed / 0 skipped')

  const pytestPass = replay('pytest', 'pytest-pass.txt', 'pytest').summary
  assert.equal(summarize({ status: 'passed', durationMs: 200, summary: pytestPass }, 'pytest'), 'passed in 0.2s · 1 test file ok · 2 passed / 0 failed / 1 skipped')

  // meta.runner is honoured when no explicit id is passed.
  assert.match(summarize({ status: 'passed', durationMs: 1, runner: 'jest', summary: jestPass }), /1 suite ok/)

  const build = replay('go', 'go-build.txt', 'go').summary
  assert.equal(summarize({ status: 'failed', durationMs: 100, summary: build }, 'go'), 'failed in 0.1s · 0 packages ok · 1 packages failed · 1 build errors')
})

test('grammarLabels serves the panel vocabulary', () => {
  assert.deepEqual(grammarLabels('go'), { suite: '包' })
  assert.deepEqual(grammarLabels('vitest'), { suite: '文件' })
  assert.deepEqual(grammarLabels('pytest'), { suite: '用例' })
  assert.deepEqual(grammarLabels('cargo'), { suite: '用例' })
})
