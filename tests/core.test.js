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
import {
  RUNNERS,
  RUNNER_IDS,
  buildRunArgv,
  describeRunner,
  detectRunner,
  runnerCatalog,
  validatePattern,
  validateTarget,
} from '../src/core/runners.js'
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
  assert.deepEqual(options.targets, ['./...'])
  // Transitional alias of the field that used to be called `packages`.
  assert.deepEqual(options.packages, ['./...'])
  // No flag is added unless the caller asked for it: `hub.start({})` must stay
  // byte-identical to the historical `go test -timeout=900s ./...`.
  assert.deepEqual(options.flags, {})
  assert.equal(options.targetsExplicit, false)
  assert.equal(options.runner, null)
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

// --- runner descriptors (src/core/runners.js) -------------------------------

test('the runner table lists exactly the supported runners', () => {
  assert.deepEqual(RUNNER_IDS, ['go', 'vitest', 'jest', 'nodeTest', 'pytest', 'script', 'generic'])
  // cargo is absent on purpose: no binary on the machines this was proven on,
  // so a descriptor would be untested guesswork.
  assert.equal(Object.hasOwn(RUNNERS, 'cargo'), false)

  const go = describeRunner('go')
  assert.equal(go.executable, 'go')
  assert.deepEqual(go.baseArgs, ['test'])
  assert.deepEqual(go.selection.default, ['./...'])
  assert.equal(go.selection.placeholder, './...')
  assert.equal(go.nameFilter.flag, '-run')
  assert.deepEqual(go.flags.map(flag => flag.id), ['verbose', 'race', 'count'])
  assert.equal(go.timeout.flag, '-timeout')
  assert.equal(go.timeout.template, '{n}s')
  assert.deepEqual(go.labels, { suite: '包' })
  assert.equal(go.argvPreview, 'go test')

  assert.deepEqual(describeRunner('vitest').baseArgs, ['exec', 'vitest', 'run'])
  assert.equal(describeRunner('vitest').executable, 'pnpm')
  assert.equal(describeRunner('jest').nameFilter.flag, '-t')
  assert.equal(describeRunner('nodeTest').nameFilter.flag, '--test-name-pattern')
  assert.deepEqual(describeRunner('nodeTest').baseArgs, ['--test'])
  assert.equal(describeRunner('pytest').executable, 'pytest')
  assert.equal(describeRunner('pytest').selection.mode, 'nodeids')
  assert.deepEqual(describeRunner('script').baseArgs, ['test', '--'])
  assert.equal(describeRunner('script').scriptRunner, true)
  assert.equal(describeRunner('generic').executable, null)
  assert.throws(() => describeRunner('cargo'), /unknown runner/)
})

test('buildRunArgv spells each runner the way its CLI expects', () => {
  assert.deepEqual(
    buildRunArgv(RUNNERS.go, {
      targets: ['./...'],
      pattern: 'TestApply',
      flags: { verbose: true, race: true, count: true },
      timeoutSec: 60,
    }),
    ['-v', '-race', '-count=1', '-run=TestApply', '-timeout=60s', './...'],
  )
  // The descriptor's `default` preselects a checkbox in the panel; it is not an
  // argv default, which is what keeps the Go argv unchanged.
  assert.deepEqual(buildRunArgv(RUNNERS.go, { targets: ['./...'], timeoutSec: 900 }), ['-timeout=900s', './...'])
  assert.deepEqual(buildRunArgv(RUNNERS.vitest, { targets: ['tests/'], pattern: 'calc add', flags: { verbose: true } }), [
    '--reporter=verbose', '-t=calc add', 'tests/',
  ])
  assert.deepEqual(buildRunArgv(RUNNERS.jest, { targets: ['tests/a.test.js'], flags: { verbose: true } }), [
    '--verbose', 'tests/a.test.js',
  ])
  assert.deepEqual(buildRunArgv(RUNNERS.nodeTest, { pattern: 'adds two', flags: { verbose: true } }), [
    '--test-reporter=spec', '--test-name-pattern=adds two',
  ])
  assert.deepEqual(buildRunArgv(RUNNERS.pytest, { targets: ['tests/test_calc.py::test_add'], pattern: 'calc and add' }), [
    '-k=calc and add', 'tests/test_calc.py::test_add',
  ])
  // No flags, no filter, no timeout, no targets: argv is baseArgs alone.
  assert.deepEqual(buildRunArgv(RUNNERS.script, { targets: ['ignored'], pattern: 'X', flags: { verbose: true } }), [])
  assert.deepEqual(buildRunArgv(RUNNERS.generic, { targets: ['./...'], pattern: 'X', flags: { verbose: true } }), [])
})

test('the go descriptor keeps the historical flag order for every shape', () => {
  // Literal expectations (not a self-comparison): an edit to the flag order or
  // to the timeout template has to fail here.
  const cases = [
    [{ targets: ['./...'], timeoutSec: 900 }, ['-timeout=900s', './...']],
    [{ targets: ['./...'], pattern: 'TestA|TestB', timeoutSec: 120 }, ['-run=TestA|TestB', '-timeout=120s', './...']],
    [{ targets: ['./a', './b'], timeoutSec: 1 }, ['-timeout=1s', './a', './b']],
    [{ targets: ['./x'], flags: { verbose: true }, timeoutSec: 900 }, ['-v', '-timeout=900s', './x']],
    [
      { targets: ['./database/...'], pattern: 'TestApply', flags: { verbose: true, race: true, count: true }, timeoutSec: 60 },
      ['-v', '-race', '-count=1', '-run=TestApply', '-timeout=60s', './database/...'],
    ],
  ]
  for (const [options, want] of cases) {
    assert.deepEqual(buildRunArgv(RUNNERS.go, options), want)
  }
  // The old `buildArgs` entry point still renders the same flags for a legacy
  // options object (this is what a pre-descriptor caller passes).
  assert.deepEqual(
    buildArgs({ packages: ['./...'], pattern: 'TestA', verbose: true, race: true, count: true, timeoutSec: 30 }, 'go-test'),
    buildRunArgv(RUNNERS.go, {
      targets: ['./...'],
      pattern: 'TestA',
      flags: { verbose: true, race: true, count: true },
      timeoutSec: 30,
    }),
  )
})

test('each runner refuses the targets and names it cannot accept', () => {
  assert.equal(validateTarget(RUNNERS.go, './...'), true)
  assert.equal(validateTarget(RUNNERS.go, './database/kdb'), true)
  assert.equal(validateTarget(RUNNERS.go, '/etc/passwd'), false)
  assert.equal(validateTarget(RUNNERS.go, './x y'), false)
  assert.equal(validateTarget(RUNNERS.vitest, 'tests/a.test.js'), true)
  assert.equal(validateTarget(RUNNERS.vitest, 'src/**/*.test.js'), true)
  assert.equal(validateTarget(RUNNERS.vitest, ''), false)
  assert.equal(validateTarget(RUNNERS.vitest, '/abs/tests'), false)
  assert.equal(validateTarget(RUNNERS.pytest, 'tests/test_calc.py::test_add'), true)
  assert.equal(validateTarget(RUNNERS.pytest, 'tests/[test_b]*.py'), true)
  assert.equal(validateTarget(RUNNERS.pytest, '/abs/test_calc.py'), false)
  // `-run` has never taken a space; `-t`/`-k` do.
  assert.equal(validatePattern(RUNNERS.go, 'TestA|TestB'), true)
  assert.equal(validatePattern(RUNNERS.go, 'adds two'), false)
  assert.equal(validatePattern(RUNNERS.vitest, 'calc add'), true)
  assert.equal(validatePattern(RUNNERS.pytest, 'calc and add'), true)
  // A runner without a name filter accepts anything (the pattern is ignored).
  assert.equal(validatePattern(RUNNERS.generic, 'whatever'), true)
})

test('detectRunner follows the contract order', () => {
  const cases = [
    [{ 'go.mod': 'module example.com/x\n' }, 'go'],
    [{ 'package.json': JSON.stringify({ devDependencies: { vitest: '^5.0.0' } }) }, 'vitest'],
    [{ 'package.json': JSON.stringify({ dependencies: { jest: '^30.0.0' } }) }, 'jest'],
    [{ 'package.json': JSON.stringify({ scripts: { test: 'node --test tests/*.test.js' } }) }, 'nodeTest'],
    [{ 'pytest.ini': '[pytest]\n' }, 'pytest'],
    [{ 'pyproject.toml': '[tool.pytest.ini_options]\n' }, 'pytest'],
    [{ 'setup.cfg': '[tool:pytest]\n' }, 'pytest'],
    [{ 'tox.ini': '[pytest]\n' }, 'pytest'],
    [{}, 'generic'],
    // go.mod wins over a package.json; the JS runners win over pytest markers.
    [{ 'go.mod': 'module x\n', 'package.json': JSON.stringify({ devDependencies: { vitest: '^5' } }) }, 'go'],
    [{ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }), 'pytest.ini': '' }, 'nodeTest'],
  ]
  for (const [files, want] of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-detect-'))
    try {
      for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
      const found = detectRunner(dir)
      assert.equal(found.id, want, JSON.stringify(files))
      assert.equal(typeof found.reason, 'string')
      assert.ok(found.reason.length > 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('detectRunner gates the script fallback on allowScriptRunners', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-detect-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
    const allowed = detectRunner(dir, { allowScriptRunners: true })
    assert.equal(allowed.id, 'script')
    const refused = detectRunner(dir)
    assert.equal(refused.id, 'generic')
    assert.match(refused.reason, /allowScriptRunners: true/)
    // cargo is not implemented this round: say so instead of guessing.
    rmSync(join(dir, 'package.json'))
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\n')
    const cargo = detectRunner(dir)
    assert.equal(cargo.id, 'generic')
    assert.match(cargo.reason, /Cargo\.toml/)
    // An unreadable directory must not throw.
    assert.equal(detectRunner(join(dir, 'no-such-dir')).id, 'generic')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runnerCatalog marks the script runner unavailable unless allowed', () => {
  const off = runnerCatalog()
  assert.equal(off.length, 7)
  assert.deepEqual(off.map(row => row.id), [...RUNNER_IDS])
  const script = off.find(row => row.id === 'script')
  assert.equal(script.available, false)
  assert.match(script.reason, /allowScriptRunners: true/)
  assert.equal(off.filter(row => row.id !== 'script').every(row => row.available), true)
  assert.equal(off.find(row => row.id === 'script').reason.includes('script'), true)

  const on = runnerCatalog({ allowScriptRunners: true }).find(row => row.id === 'script')
  assert.equal(on.available, true)
  assert.equal(on.reason, null)
  assert.equal(off.find(row => row.id === 'go').selectionPlaceholder, './...')
  assert.deepEqual(off.find(row => row.id === 'vitest').flags.map(flag => flag.id), ['verbose'])
  assert.deepEqual(off.find(row => row.id === 'pytest').labels, { suite: '用例' })
})

test('resolveConfig resolves the runner and rejects unknown ids', () => {
  const defaults = resolveConfig({})
  // Not 'auto': a deployment that configured nothing must keep its old argv,
  // and `kind` already defaults to 'go-test'. Detection is opt-in.
  assert.equal(defaults.runner, 'go')
  assert.equal(defaults.allowScriptRunners, false)
  assert.equal(resolveConfig({ runner: 'vitest' }).runner, 'vitest')
  assert.equal(resolveConfig({ runner: 'auto' }).runner, 'auto')
  assert.equal(resolveConfig({ runner: 'NODETEST' }).runner, 'nodeTest')
  assert.equal(resolveConfig({ runner: ' generic ' }).runner, 'generic')
  // kind: 'command' IS the generic runner; pairing it with another is a bug.
  assert.equal(resolveConfig({ kind: 'command', command: 'make' }).runner, 'generic')
  assert.equal(resolveConfig({ kind: 'command', runner: 'generic' }).runner, 'generic')
  assert.throws(() => resolveConfig({ runner: 'cargo' }), /not a known runner/)
  assert.throws(() => resolveConfig({ runner: 7 }), /must be a string/)
  assert.throws(() => resolveConfig({ kind: 'command', runner: 'vitest' }), /conflicts with config\.runner/)
  assert.equal(resolveConfig({ allowScriptRunners: true }).allowScriptRunners, true)
  // Only a real boolean turns a permission on; a string does not.
  assert.equal(resolveConfig({ allowScriptRunners: 'yes' }).allowScriptRunners, false)
})

test('normalizeRunOptions validates against the runner that will run', () => {
  const settings = resolveConfig({})
  const vitest = normalizeRunOptions({ runner: 'vitest', targets: ['tests/a.test.js'], pattern: 'calc add' }, settings)
  assert.equal(vitest.runner, 'vitest')
  assert.deepEqual(vitest.targets, ['tests/a.test.js'])
  assert.equal(vitest.targetsExplicit, true)
  assert.deepEqual(vitest.flags, {})

  // The Go rules are unchanged for the default deployment.
  assert.throws(() => normalizeRunOptions({ targets: ['/etc/passwd'] }, settings), /not allowed/)
  assert.throws(() => normalizeRunOptions({ runner: 'vitest', targets: ['/etc/passwd'] }, settings), /not allowed for runner "vitest"/)
  // pytest takes node ids and `[]` globs, which the Go rules never allowed.
  assert.deepEqual(
    normalizeRunOptions({ runner: 'pytest', targets: ['tests/test_calc.py::test_add', 'tests/[test_b]*.py'] }, settings).targets,
    ['tests/test_calc.py::test_add', 'tests/[test_b]*.py'],
  )
  // Legacy booleans are still the spelling of the three Go switches.
  const legacy = normalizeRunOptions({ verbose: true, race: true, count: true, pattern: 'TestA', timeoutSec: 30 }, settings)
  assert.deepEqual(legacy.flags, { verbose: true, race: true, count: true })
  // `auto` can only be shape-checked here; the hub re-validates after detection.
  assert.equal(normalizeRunOptions({ runner: 'auto', targets: ['tests/a b.test.js'] }, settings).runner, 'auto')
  assert.throws(() => normalizeRunOptions({ runner: 'cargo' }, settings), /not a known runner/)
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
