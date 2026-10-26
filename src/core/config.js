/**
 * Plugin configuration: defaults, validation, and the command building rules.
 *
 * Everything that reaches `child_process.spawn` is derived here from a small
 * closed set of options. The HTTP surface never accepts a command string, only
 * package patterns and a test-name regex, so a remote caller cannot turn the
 * panel into a shell.
 * @module dsh-test-live/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { RUNNERS, RUNNER_IDS, buildRunArgv, validatePattern, validateTarget } from './runners.js'

/**
 * Where finished runs are kept when the deployment does not name a file.
 *
 * The registry is fleet-wide, so the file lives under the DSH home (`DSH_HOME`
 * when the host sets it, else `~/.dsh`) rather than under one project.
 * @returns absolute path of the state file.
 */
export function defaultStateFile() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'test-live', 'runs.json')
}

/** Defaults; the patch file mirrors these values so a deployment edit is obvious. */
export const DEFAULTS = {
  // 'go-test' derives -v/-race/-run/-timeout and package patterns; 'command'
  // runs exactly `command + baseArgs` and ignores those options.
  kind: 'go-test',
  // Which runner descriptor executes a run: a concrete id (go, vitest, jest,
  // nodeTest, pytest, script, generic) or 'auto' to detect it from the project
  // directory. The default is 'go' and not 'auto' on purpose: a deployment that
  // configured nothing must keep the exact argv it ran before descriptors
  // existed (`kind` already defaults to 'go-test'), while a profile that wants
  // detection opts in with `runner: 'auto'`.
  runner: 'go',
  // Off by default: the script runner delegates to the project's own `test`
  // script — code this plugin does not control — so a deployment has to say so.
  allowScriptRunners: false,
  // The run directory is only a *fallback*: a run belongs to the conversation
  // that started it, and the session's own cwd wins whenever there is one.
  cwd: null,
  command: 'go',
  baseArgs: ['test'],
  env: {},
  // In-memory history: how many runs the panel can page through.
  maxRuns: 30,
  // Durable history: how many runs / how many tail lines per run reach the disk.
  historyRuns: 100,
  historyLines: 200,
  // '' means "derive from defaultStateFile()" (one file for the whole host);
  // an explicit `stateFile: null` (or false) disables persistence, and a string
  // names an absolute file. The DEFAULTS row spells the enabled case so copying
  // it cannot silently turn history off.
  stateFile: '',
  // Which slice of the log the panel opens on: every conversation, or this one.
  defaultScope: 'all',
  maxLines: 20000,
  defaultTimeoutSec: 900,
  // The file-follow mode: an external writer (terminal, bash, CI) tees into a
  // file; the panel tails it. followRoot bounds which files may be read.
  followRoot: null,
  // Ordered allow-list of roots the panel may follow files in; the panel shows
  // them as a picker. `followRoot` is its single-value alias, so a deployment
  // that only knows the old key keeps its exact historical behavior, and an
  // empty list means "the historical root" (followRoot, else cwd).
  followRoots: [],
  followIntervalMs: 300,
  ui: { autoScroll: true, packagesPlaceholder: './...' },
}

/**
 * Resolve the plugin row config into a frozen settings object.
 * @param raw - the plugin row config (may be undefined).
 * @returns normalized settings.
 */
export function resolveConfig(raw) {
  const config = raw ?? {}
  const kind = config.kind === 'command' ? 'command' : 'go-test'
  const runner = resolveRunner(config, kind)
  const followRoot =
    typeof config.followRoot === 'string' && config.followRoot.trim() !== '' ? config.followRoot.trim() : null
  const settings = {
    kind,
    runner,
    allowScriptRunners: config.allowScriptRunners === true,
    cwd: typeof config.cwd === 'string' && config.cwd.trim() !== '' ? config.cwd.trim() : null,
    command: typeof config.command === 'string' && config.command.trim() !== '' ? config.command.trim() : DEFAULTS.command,
    baseArgs: Array.isArray(config.baseArgs) ? config.baseArgs.map(String) : DEFAULTS.baseArgs.slice(),
    env: isPlainObject(config.env) ? normalizeEnv(config.env) : {},
    maxRuns: positiveInt(config.maxRuns, DEFAULTS.maxRuns, 1, 100),
    maxLines: positiveInt(config.maxLines, DEFAULTS.maxLines, 100, 200000),
    historyRuns: positiveInt(config.historyRuns, DEFAULTS.historyRuns, 1, 1000),
    historyLines: positiveInt(config.historyLines, DEFAULTS.historyLines, 10, 2000),
    stateFile:
      config.stateFile === null || config.stateFile === false
        ? null
        : typeof config.stateFile === 'string' && config.stateFile.trim() !== ''
          ? config.stateFile.trim()
          : defaultStateFile(),
    defaultScope: config.defaultScope === 'session' ? 'session' : 'all',
    defaultTimeoutSec: positiveInt(config.defaultTimeoutSec, DEFAULTS.defaultTimeoutSec, 1, 24 * 3600),
    followRoot,
    followRoots: normalizeRoots(config.followRoots, followRoot),
    followIntervalMs: positiveInt(config.followIntervalMs, DEFAULTS.followIntervalMs, 100, 5000),
    ui: {
      autoScroll: config.ui?.autoScroll !== false,
      packagesPlaceholder:
        typeof config.ui?.packagesPlaceholder === 'string'
          ? config.ui.packagesPlaceholder
          : DEFAULTS.ui.packagesPlaceholder,
    },
  }
  if (!isSafeExecutable(settings.command)) {
    throw new Error(`dsh-test-live: config.command "${settings.command}" must be a plain executable name`)
  }
  if (!isRelativeCwd(settings.cwd)) {
    throw new Error(`dsh-test-live: config.cwd "${settings.cwd}" must be an absolute path`)
  }
  if (!isRelativeCwd(settings.followRoot)) {
    throw new Error(`dsh-test-live: config.followRoot "${settings.followRoot}" must be an absolute path`)
  }
  if (settings.stateFile !== null && !isRelativeCwd(settings.stateFile)) {
    throw new Error(`dsh-test-live: config.stateFile "${settings.stateFile}" must be an absolute path or null`)
  }
  for (const root of settings.followRoots) {
    if (!isRelativeCwd(root)) {
      throw new Error(`dsh-test-live: config.followRoots "${root}" must be an absolute path`)
    }
  }
  return Object.freeze(settings)
}

/**
 * Fold `followRoot` and `followRoots` into one ordered allow-list. The legacy
 * single root comes first because it is the historical default for relative
 * paths; duplicates collapse so a profile may set both keys without surprises.
 * @param value - the `followRoots` config value (may be anything).
 * @param alias - the normalized `followRoot` value, or null.
 * @returns absolute root strings, alias first.
 */
export function normalizeRoots(value, alias) {
  const roots = []
  const push = candidate => {
    if (typeof candidate !== 'string') return
    const trimmed = candidate.trim()
    if (trimmed === '' || roots.includes(trimmed)) return
    roots.push(trimmed)
  }
  push(alias)
  if (Array.isArray(value)) for (const candidate of value) push(candidate)
  return roots
}

/**
 * @param value - candidate.
 * @param fallback - default.
 * @param min - lower bound.
 * @param max - upper bound.
 * @returns an integer inside the bounds.
 */
function positiveInt(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.trunc(value)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

/**
 * Env values must be strings; numbers and booleans are stringified because YAML
 * turns `DEBUG: 1` into a number and handing a number to spawn would throw.
 * @param env - candidate map.
 * @returns string map.
 */
function normalizeEnv(env) {
  const out = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === null || value === undefined) continue
    out[key] = String(value)
  }
  return out
}

/**
 * @param value - candidate command.
 * @returns true for a bare executable name or an absolute path without
 * whitespace. The value only ever comes from the plugin row config, never from
 * HTTP, so an absolute path (e.g. /usr/local/go/bin/go on a host whose PATH is
 * minimal) is a deployment choice, not an injection vector.
 */
function isSafeExecutable(value) {
  if (/^[A-Za-z0-9_.+-]+$/.test(value)) return true
  return /^\/(?:[A-Za-z0-9_.+-]+\/)*[A-Za-z0-9_.+-]+$/.test(value)
}

/**
 * @param value - candidate cwd.
 * @returns true for null (host cwd) or an absolute path.
 */
function isRelativeCwd(value) {
  return value === null || (typeof value === 'string' && value.startsWith('/'))
}

/**
 * @param value - candidate.
 * @returns true for a plain object.
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize the `runner` value of a config row or a run request.
 * @param value - candidate: `'auto'`, a runner id, or empty.
 * @param origin - where the value came from, for the error message.
 * @returns null (absent), `'auto'`, or a known runner id.
 */
function normalizeRunnerChoice(value, origin) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    throw new Error(`dsh-test-live: ${origin}.runner must be a string`)
  }
  const wanted = value.trim().toLowerCase()
  if (wanted === 'auto') return 'auto'
  const known = RUNNER_IDS.find(id => id.toLowerCase() === wanted)
  if (known === undefined) {
    throw new Error(
      `dsh-test-live: ${origin}.runner "${value}" is not a known runner (${RUNNER_IDS.join(', ')}, auto)`,
    )
  }
  return known
}

/**
 * Resolve the config row's runner, keeping the historical `kind` mapping.
 *
 * `kind: 'command'` *is* the generic runner, so pairing it with another runner
 * is a contradiction the deployment should hear about at load time rather than
 * on its first run.
 * @param config - the plugin row config.
 * @param kind - normalized kind.
 * @returns a runner id or `'auto'`.
 */
function resolveRunner(config, kind) {
  const choice = normalizeRunnerChoice(config.runner, 'config')
  if (kind === 'command') {
    if (choice !== null && choice !== 'generic') {
      throw new Error(
        `dsh-test-live: config.kind "command" conflicts with config.runner "${config.runner}" (command is the generic runner)`,
      )
    }
    return 'generic'
  }
  return choice ?? RUNNERS.go.id
}

/**
 * The runner id that validated requests before descriptors existed: the legacy
 * `kind` mapping. It is the fallback rule for `runner: 'auto'`, whose real
 * descriptor is only known once the run's directory is resolved.
 * @param settings - resolved plugin config.
 * @returns 'go' or 'generic'.
 */
function legacyRunnerId(settings) {
  return settings?.kind === 'command' ? 'generic' : 'go'
}

/**
 * Which descriptor validates a request that has not resolved its runner yet.
 *
 * `runner: 'auto'` is resolved by detection inside the hub, so at request time
 * only the shape can be checked: the union of the target rules accepts a Go
 * package pattern, a relative file path and a pytest node id while still
 * refusing an absolute path. The hub re-validates against the detected
 * descriptor before spawning anything.
 * @param requested - the request's runner choice (null, `'auto'`, or an id).
 * @param settings - resolved plugin config.
 * @returns `{ descriptor, permissive }`.
 */
function validationRule(requested, settings) {
  if (requested !== null && requested !== 'auto') return { descriptor: RUNNERS[requested], permissive: false }
  if (requested === null) {
    const configured = typeof settings?.runner === 'string' ? settings.runner : 'go'
    if (configured !== 'auto') return { descriptor: RUNNERS[configured] ?? RUNNERS.go, permissive: false }
  }
  return { descriptor: RUNNERS[legacyRunnerId(settings)], permissive: true }
}

/**
 * @param rule - validation rule.
 * @param target - the refused target.
 * @returns a readable error, worded for the runner that refused it.
 */
function targetError(rule, target) {
  if (rule.descriptor.id === 'go') {
    return new Error(
      `package pattern "${target}" is not allowed; use relative patterns such as ./... or ./database/kdb`,
    )
  }
  return new Error(`target "${target}" is not allowed for runner "${rule.descriptor.id}"; ${rule.descriptor.selection.hint}`)
}

/**
 * @param rule - validation rule.
 * @param pattern - the refused test-name pattern.
 * @returns a readable error, worded for the runner that refused it.
 */
function patternError(rule, pattern) {
  if (rule.descriptor.id === 'go') {
    return new Error(`test pattern "${pattern}" contains unsupported characters`)
  }
  return new Error(`test pattern "${pattern}" is not allowed for runner "${rule.descriptor.id}"`)
}

/**
 * Refuse any target the runner would not accept. Shared with the hub, which
 * re-checks after `auto` detection resolved a concrete descriptor.
 * @param descriptor - runner descriptor.
 * @param targets - targets about to become argv elements.
 */
export function assertTargets(descriptor, targets) {
  const rule = { descriptor, permissive: false }
  for (const target of targets) {
    if (!validateTarget(descriptor, target)) throw targetError(rule, target)
  }
}

/**
 * Refuse a test-name pattern the runner would not accept.
 * @param descriptor - runner descriptor.
 * @param pattern - the pattern (empty means "no filter" and is always fine).
 */
export function assertPattern(descriptor, pattern) {
  if (typeof pattern !== 'string' || pattern === '') return
  if (!validatePattern(descriptor, pattern)) throw patternError({ descriptor, permissive: false }, pattern)
}

/**
 * Validate the optional run options coming from HTTP or a tool call.
 * @param options - candidate options.
 * @param settings - resolved plugin config.
 * @returns normalized options, or throws with a readable message.
 */
export function normalizeRunOptions(options, settings) {
  const input = isPlainObject(options) ? options : {}
  const requested = normalizeRunnerChoice(input.runner, 'run option')
  const rule = validationRule(requested, settings)
  const explicit = []
  const listed = Array.isArray(input.targets) ? input.targets : Array.isArray(input.packages) ? input.packages : []
  for (const candidate of listed) explicit.push(String(candidate))
  if (rule.permissive) {
    // `auto` has no descriptor yet: accept the union of the runner shapes.
    for (const target of explicit) {
      const accepted =
        validateTarget(RUNNERS.go, target) ||
        validateTarget(RUNNERS.vitest, target) ||
        validateTarget(RUNNERS.pytest, target)
      if (!accepted) throw targetError(rule, target)
    }
  } else {
    assertTargets(rule.descriptor, explicit)
  }
  let pattern = ''
  if (typeof input.pattern === 'string') pattern = input.pattern.trim()
  if (pattern !== '') {
    if (rule.permissive) {
      if (!validatePattern(RUNNERS.go, pattern) && !validatePattern(RUNNERS.vitest, pattern)) {
        throw patternError(rule, pattern)
      }
    } else {
      assertPattern(rule.descriptor, pattern)
    }
  }
  const timeoutSec = positiveInt(input.timeoutSec, settings.defaultTimeoutSec, 1, 24 * 3600)
  // Flag ids are the descriptor's; `verbose`/`race`/`count` remain the legacy
  // spelling of the same three switches (`-v`, `-race`, `-count=1`).
  const flags = {}
  if (isPlainObject(input.flags)) {
    for (const [id, value] of Object.entries(input.flags)) flags[id] = value === true
  }
  for (const id of ['verbose', 'race', 'count']) {
    if (typeof input[id] === 'boolean') flags[id] = input[id]
  }
  const targets = explicit.length > 0 ? explicit : rule.descriptor.selection.default.slice()
  return {
    // An empty list means "the whole module", the same default the panel shows.
    targets,
    // Transitional alias: the name this field had before multiple runners.
    packages: targets.slice(),
    targetsExplicit: explicit.length > 0,
    // null = follow the configured runner; 'auto' = detect it in the hub.
    runner: requested,
    pattern,
    flags,
    timeoutSec,
  }
}

/**
 * Build the argv (without the executable) of one Go run.
 *
 * Kept as the compatibility entry point for callers that predate descriptors;
 * it delegates to the `go` descriptor, which is where the flag order
 * (-v -race -count=1 -run=X -timeout=Ns <packages>) now lives.
 * @param options - normalized run options (old or new shape).
 * @param kind - 'go-test' or 'command'.
 * @returns argument list.
 */
export function buildArgs(options, kind = DEFAULTS.kind) {
  if (kind === 'command') return []
  const flags = isPlainObject(options?.flags) ? options.flags : {}
  return buildRunArgv(RUNNERS.go, {
    targets: options?.targets ?? options?.packages ?? [],
    pattern: options?.pattern,
    flags: {
      verbose: flags.verbose === true || options?.verbose === true,
      race: flags.race === true || options?.race === true,
      count: flags.count === true || options?.count === true,
    },
    timeoutSec: options?.timeoutSec,
  })
}

