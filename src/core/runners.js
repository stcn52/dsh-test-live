/**
 * Runner descriptors: one table that says how each supported test runner is
 * invoked, how its targets and its test-name filter are spelled, and which
 * flags it accepts.
 *
 * The table is data, not code. `config.js` validates callers' input against it,
 * `runner.js` builds the argv from it, the routes serve it as a catalog and the
 * panel renders it. Nothing here spawns a process or reads a log, and argv
 * construction lives in one pure function ({@link buildRunArgv}) — that is what
 * lets the Go argv stay byte-identical to the pre-descriptor implementation
 * (`-v -race -count=1 -run=X -timeout=Ns <targets>`, in that order).
 *
 * `cargo` is deliberately absent: no binary exists on the machines this plugin
 * was proven on, so a descriptor would be untested guesswork. `runnerCatalog`
 * therefore lists six real runners plus `generic`, never `cargo`.
 * @module dsh-test-live/runners
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Recursively freeze a descriptor so a consumer cannot edit the shared table.
 * @param value - object to freeze (nested objects and arrays included).
 * @returns the frozen value.
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry)
    Object.freeze(value)
  }
  return value
}

/**
 * Relative package patterns accepted for Go: no spaces, no absolute paths, no
 * shell metacharacters. Moved here verbatim from config.js so a Go deployment
 * keeps exactly the patterns it accepted before.
 * @param value - candidate target.
 * @returns true when the target may be handed to `go test`.
 */
function validateGoTarget(value) {
  return typeof value === 'string' && /^\.{0,2}\/?[A-Za-z0-9_.\-/]*$/.test(value) && !value.startsWith('/')
}

/**
 * Relative file targets for the JavaScript runners: no absolute path and no
 * whitespace (a target becomes exactly one argv element, and a space in a file
 * name is the caller's problem to quote — the panel never does).
 * @param value - candidate target.
 * @returns true when the target is a relative, space-free path or glob.
 */
function validateFileTarget(value) {
  return typeof value === 'string' && value !== '' && !value.startsWith('/') && !/\s/.test(value)
}

/**
 * Python node ids: `tests/test_calc.py::test_add`, `tests/[test_b]*.py`, and
 * test names with spaces are all legitimate, so only an absolute path and a
 * control character are refused.
 * @param value - candidate target.
 * @returns true when the target may be handed to pytest.
 */
function validateNodeId(value) {
  return typeof value === 'string' && value.trim() !== '' && !value.startsWith('/') && !/[\n\r]/.test(value)
}

/**
 * Test-name filters for the runners whose CLI takes one (`-t`, `-k`, ...).
 * A name may contain spaces for every runner except Go, whose `-run` regex the
 * panel has never accepted spaces in.
 * @param value - candidate pattern.
 * @returns true when the pattern may be handed to that runner.
 */
function validateName(value) {
  return typeof value === 'string' && value.trim() !== '' && !/[\n\r]/.test(value)
}

/** The Go `-run` regex alphabet: unchanged from the pre-descriptor config. */
const GO_NAME = /^[A-Za-z0-9_./|()[\]*+?^$-]+$/

/**
 * Every runner the plugin knows, in detection order.
 *
 * Detection order matters: `go.mod` beats a `package.json`, the JS runners are
 * tried before the generic `script` fallback, and `pytest` markers are checked
 * before that fallback so a Python project that also keeps a `package.json` for
 * tooling still detects as pytest.
 */
export const RUNNER_IDS = Object.freeze(['go', 'vitest', 'jest', 'nodeTest', 'pytest', 'script', 'generic'])

export const RUNNERS = deepFreeze({
  go: {
    id: 'go',
    label: 'Go test',
    language: 'go',
    executable: 'go',
    baseArgs: ['test'],
    detect: { files: ['go.mod'] },
    selection: {
      mode: 'packages',
      placeholder: './...',
      default: ['./...'],
      separator: ',',
      hint: '相对包模式，如 ./... 或 ./database/kdb',
      validate: validateGoTarget,
    },
    nameFilter: { flag: '-run', placeholder: 'TestApplyMigrations', allowSpaces: false, validate: value => GO_NAME.test(value) },
    flags: [
      // `default` is the panel's preselected state, not "added when the caller
      // omits it": the hub only ever adds a flag the caller asked for, which is
      // what keeps `hub.start({})` byte-identical to the old `go test` argv.
      { id: 'verbose', label: '详细输出（-v）', argv: ['-v'], default: true },
      { id: 'race', label: '竞态检测（-race）', argv: ['-race'] },
      { id: 'count', label: '禁用缓存（-count=1）', argv: ['-count=1'] },
    ],
    timeout: { flag: '-timeout', template: '{n}s' },
    labels: { suite: '包' },
    hint: 'go test，追加 -v/-race/-count/-run/-timeout',
  },
  vitest: {
    id: 'vitest',
    label: 'Vitest',
    language: 'js',
    executable: 'pnpm',
    baseArgs: ['exec', 'vitest', 'run'],
    detect: { packageDeps: ['vitest'] },
    selection: {
      mode: 'files',
      placeholder: 'tests/',
      default: [],
      separator: ',',
      hint: '相对文件路径或目录，如 tests/ 或 src/a.test.js',
      validate: validateFileTarget,
    },
    nameFilter: { flag: '-t', placeholder: 'calc add', allowSpaces: true, validate: validateName },
    flags: [{ id: 'verbose', label: '逐用例输出（--reporter=verbose）', argv: ['--reporter=verbose'], default: true }],
    labels: { suite: '文件' },
    hint: 'pnpm exec vitest run，-timeout 不进 argv（墙钟由宿主负责）',
  },
  jest: {
    id: 'jest',
    label: 'Jest',
    language: 'js',
    executable: 'pnpm',
    baseArgs: ['exec', 'jest'],
    detect: { packageDeps: ['jest'] },
    selection: {
      mode: 'files',
      placeholder: 'tests/',
      default: [],
      separator: ',',
      hint: '相对文件路径或目录，如 tests/ 或 src/a.test.js',
      validate: validateFileTarget,
    },
    nameFilter: { flag: '-t', placeholder: 'calc add', allowSpaces: true, validate: validateName },
    flags: [{ id: 'verbose', label: '逐用例输出（--verbose）', argv: ['--verbose'], default: true }],
    labels: { suite: '文件' },
    hint: 'pnpm exec jest，-timeout 不进 argv（墙钟由宿主负责）',
  },
  nodeTest: {
    id: 'nodeTest',
    label: 'node --test',
    language: 'js',
    executable: 'node',
    baseArgs: ['--test'],
    detect: { packageScripts: /node\s+--test/ },
    selection: {
      mode: 'files',
      placeholder: 'test/',
      default: [],
      separator: ',',
      hint: '相对文件路径或目录，如 test/ 或 test/math.test.js',
      validate: validateFileTarget,
    },
    nameFilter: {
      flag: '--test-name-pattern',
      placeholder: 'adds two',
      allowSpaces: true,
      validate: validateName,
    },
    // spec reporter: `✔`/`✖` lines instead of TAP, which the panel can count.
    flags: [{ id: 'verbose', label: 'spec 输出（--test-reporter=spec）', argv: ['--test-reporter=spec'], default: true }],
    labels: { suite: '文件' },
    hint: 'node --test，-timeout 不进 argv（墙钟由宿主负责）',
  },
  pytest: {
    id: 'pytest',
    label: 'pytest',
    language: 'python',
    executable: 'pytest',
    baseArgs: [],
    detect: { files: ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'], pythonTests: true },
    selection: {
      mode: 'nodeids',
      placeholder: 'tests/',
      default: [],
      separator: ',',
      hint: '相对 nodeid，如 tests/test_calc.py::test_add 或 tests/',
      validate: validateNodeId,
    },
    nameFilter: { flag: '-k', placeholder: 'calc and add', allowSpaces: true, validate: validateName },
    flags: [{ id: 'verbose', label: '逐用例输出（-v）', argv: ['-v'], default: true }],
    labels: { suite: '用例' },
    hint: 'pytest，-timeout 不进 argv（墙钟由宿主负责）',
  },
  script: {
    id: 'script',
    label: 'package.json script',
    language: 'js',
    executable: 'pnpm',
    baseArgs: ['test', '--'],
    scriptRunner: true,
    detect: { files: ['package.json'] },
    selection: {
      mode: 'none',
      placeholder: '',
      default: [],
      hint: '交给项目自己的 scripts.test，不接受目标',
      validate: () => true,
    },
    nameFilter: null,
    flags: [],
    labels: { suite: '文件' },
    hint: 'pnpm test --，参数由 package.json 的 test 脚本决定',
  },
  generic: {
    id: 'generic',
    label: '自定义命令',
    language: null,
    // null executable: config.command + config.baseArgs are used verbatim and
    // no flag is ever appended.
    executable: null,
    baseArgs: [],
    selection: {
      mode: 'none',
      placeholder: '',
      default: [],
      hint: 'kind: command 时命令完全来自插件配置',
      validate: () => true,
    },
    nameFilter: null,
    flags: [],
    labels: { suite: '套件' },
    hint: '只跑配置里的 command + baseArgs，不追加任何 flags',
  },
})

/**
 * @param id - candidate runner id.
 * @returns true for an id in {@link RUNNERS}.
 */
export function isKnownRunner(id) {
  return typeof id === 'string' && Object.hasOwn(RUNNERS, id)
}

/**
 * Read and parse `<dir>/package.json` without throwing.
 * @param dir - project directory.
 * @returns the parsed object, or null when missing/unreadable/not an object.
 */
function readPackageJson(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** File names that mean "this directory holds pytest tests". */
const PYTHON_TEST_FILE = /^(?:test_.+\.py|.+_test\.py|conftest\.py)$/

/**
 * Find pytest test files in a project directory.
 *
 * A repository often has no `pytest.ini` at all: `tests/test_orders.py` alone is
 * enough for pytest to run, and that is exactly the layout of the fixture
 * project this plugin was tested against. Only the directory itself and one
 * level down (`tests/`) are inspected, so detection stays cheap and cannot walk
 * a whole tree from an unrelated working directory.
 * @param dir - project directory.
 * @returns the evidence string, or null when no python test file is visible.
 */
function pythonTestEvidence(dir) {
  for (const candidate of [dir, join(dir, 'tests')]) {
    try {
      for (const entry of readdirSync(candidate, { withFileTypes: true })) {
        if (entry.isFile() && PYTHON_TEST_FILE.test(entry.name)) {
          const shown = candidate === dir ? entry.name : `tests/${entry.name}`
          return `${shown} 存在`
        }
      }
    } catch {
      // Missing or unreadable: not evidence, keep looking.
    }
  }
  return null
}

/**
 * Guess which runner a directory uses.
 *
 * Order (contract v2): `go.mod` → go; package dependencies containing vitest or
 * jest → vitest/jest; a `scripts.test` that runs `node --test` → nodeTest; the
 * pytest config markers → pytest; any other `package.json` → script (or generic
 * with a reason when script runners are disabled); nothing → generic. A
 * `Cargo.toml` alone lands on generic with an explicit "not implemented" reason
 * rather than a runner that cannot be proven on this machine.
 * @param cwd - project directory (relative or absolute).
 * @param options - `{ allowScriptRunners }`; only the script fallback cares.
 * @returns `{ id, reason }`, never a throw (an unreadable directory is generic).
 */
export function detectRunner(cwd, options = {}) {
  const dir = typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : process.cwd()
  const allowScriptRunners = options?.allowScriptRunners === true
  const pkg = readPackageJson(dir)
  const deps = pkg === null ? null : { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const testScript = pkg !== null && typeof pkg.scripts === 'object' && pkg.scripts !== null ? pkg.scripts.test : undefined

  for (const id of RUNNER_IDS) {
    const descriptor = RUNNERS[id]
    const detect = descriptor.detect ?? {}
    for (const file of detect.files ?? []) {
      if (existsSync(join(dir, file))) {
        if (descriptor.scriptRunner === true && !allowScriptRunners) {
          return { id: 'generic', reason: `${file} 存在，但 runner "script" 需要 allowScriptRunners: true，已回落 generic` }
        }
        return { id, reason: `${file} 存在` }
      }
    }
    if (detect.pythonTests === true) {
      const evidence = pythonTestEvidence(dir)
      if (evidence !== null) return { id, reason: evidence }
    }
    if (deps !== null) {
      for (const dep of detect.packageDeps ?? []) {
        if (Object.hasOwn(deps, dep)) return { id, reason: `package.json 依赖里含 ${dep}` }
      }
    }
    if (pkg !== null && detect.packageScripts instanceof RegExp && typeof testScript === 'string' && detect.packageScripts.test(testScript)) {
      return { id, reason: `package.json 的 scripts.test 是 "${testScript}"` }
    }
  }
  if (existsSync(join(dir, 'Cargo.toml'))) {
    return { id: 'generic', reason: 'Cargo.toml 存在，但 cargo runner 本期未实现（本机无 cargo，无法自证）' }
  }
  return { id: 'generic', reason: '未找到 go.mod / package.json / pytest 配置，改用配置里的自定义命令' }
}

/**
 * One descriptor, normalized for a consumer: the table entry plus the joined
 * command preview the panel shows above the target input.
 * @param id - runner id.
 * @returns the descriptor (read-only) with `argvPreview`.
 */
export function describeRunner(id) {
  if (!isKnownRunner(id)) {
    throw new Error(`unknown runner "${id}"; known runners are ${RUNNER_IDS.join(', ')}`)
  }
  const descriptor = RUNNERS[id]
  const head = descriptor.executable === null ? '<config.command>' : descriptor.executable
  return { ...descriptor, argvPreview: [head, ...descriptor.baseArgs].join(' ') }
}

/**
 * The catalog the panel and the routes render: one row per runner, with the
 * script runner marked unavailable unless the deployment enabled it.
 * @param options - `{ allowScriptRunners }`.
 * @returns one row per runner, in table order.
 */
export function runnerCatalog(options = {}) {
  const allowScriptRunners = options?.allowScriptRunners === true
  return RUNNER_IDS.map(id => {
    const descriptor = RUNNERS[id]
    const gated = descriptor.scriptRunner === true && !allowScriptRunners
    return {
      id,
      label: descriptor.label,
      language: descriptor.language,
      executable: descriptor.executable,
      baseArgs: descriptor.baseArgs.slice(),
      mode: descriptor.selection.mode,
      selectionPlaceholder: descriptor.selection.placeholder,
      selectionHint: descriptor.selection.hint ?? null,
      flags: descriptor.flags.map(flag => ({ ...flag, argv: flag.argv.slice() })),
      labels: { ...descriptor.labels },
      available: !gated,
      reason: gated ? 'runner "script" 需要 allowScriptRunners: true' : null,
      hint: descriptor.hint ?? null,
    }
  })
}

/**
 * Validate one target against a descriptor's selection rules.
 * @param descriptor - runner descriptor.
 * @param target - candidate target.
 * @returns true when the runner accepts it.
 */
export function validateTarget(descriptor, target) {
  const validate = descriptor?.selection?.validate
  return typeof validate === 'function' ? validate(target) === true : false
}

/**
 * Validate one test-name filter against a descriptor's name-filter rules.
 * @param descriptor - runner descriptor.
 * @param pattern - candidate pattern.
 * @returns true when the runner accepts it.
 */
export function validatePattern(descriptor, pattern) {
  const validate = descriptor?.nameFilter?.validate
  if (typeof validate !== 'function') return true
  return validate(pattern) === true
}

/**
 * Build the argv that follows `descriptor.baseArgs` for one run.
 *
 * Order is fixed and load-bearing: flags in table order, then the name filter,
 * then the timeout, then the targets. For Go that reproduces
 * `-v -race -count=1 -run=X -timeout=Ns <targets>` exactly. A flag is added
 * only when `options.flags[flag.id] === true`, so an omitted flag means "not
 * passed" for every runner (the descriptor's `default` only preselects it in
 * the panel) — this is what keeps the historical `go test` argv unchanged.
 *
 * `generic` and `script` have no flags, no filter, no timeout and no targets:
 * their argv is `baseArgs` alone.
 * @param descriptor - runner descriptor (or an id).
 * @param options - `{ targets, pattern, flags, timeoutSec }`.
 * @returns argument list (never null).
 */
export function buildRunArgv(descriptor, options = {}) {
  const spec = typeof descriptor === 'string' ? RUNNERS[descriptor] : descriptor
  if (spec === null || typeof spec !== 'object') throw new Error('buildRunArgv needs a runner descriptor')
  const input = options !== null && typeof options === 'object' ? options : {}
  const argv = []
  const flags = input.flags !== null && typeof input.flags === 'object' ? input.flags : {}
  for (const flag of spec.flags ?? []) {
    if (flags[flag.id] === true) argv.push(...flag.argv)
  }
  const filter = spec.nameFilter
  const pattern = typeof input.pattern === 'string' ? input.pattern.trim() : ''
  if (filter !== null && filter !== undefined && filter.flag && pattern !== '') {
    argv.push(`${filter.flag}=${pattern}`)
  }
  if (spec.timeout !== null && spec.timeout !== undefined && spec.timeout.flag) {
    argv.push(`${spec.timeout.flag}=${spec.timeout.template.replace('{n}', String(input.timeoutSec ?? ''))}`)
  }
  if (spec.selection.mode !== 'none') {
    for (const target of input.targets ?? []) argv.push(String(target))
  }
  return argv
}
