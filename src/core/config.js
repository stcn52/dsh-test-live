/**
 * Plugin configuration: defaults, validation, and the command building rules.
 *
 * Everything that reaches `child_process.spawn` is derived here from a small
 * closed set of options. The HTTP surface never accepts a command string, only
 * package patterns and a test-name regex, so a remote caller cannot turn the
 * panel into a shell.
 * @module dsh-test-live/config
 */

/** Defaults; the patch file mirrors these values so a deployment edit is obvious. */
export const DEFAULTS = {
  // 'go-test' derives -v/-race/-run/-timeout and package patterns; 'command'
  // runs exactly `command + baseArgs` and ignores those options.
  kind: 'go-test',
  cwd: null,
  command: 'go',
  baseArgs: ['test'],
  env: {},
  maxRuns: 8,
  maxLines: 20000,
  defaultTimeoutSec: 900,
  // The file-follow mode: an external writer (terminal, bash, CI) tees into a
  // file; the panel tails it. followRoot bounds which files may be read.
  followRoot: null,
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
  const settings = {
    kind,
    cwd: typeof config.cwd === 'string' && config.cwd.trim() !== '' ? config.cwd.trim() : null,
    command: typeof config.command === 'string' && config.command.trim() !== '' ? config.command.trim() : DEFAULTS.command,
    baseArgs: Array.isArray(config.baseArgs) ? config.baseArgs.map(String) : DEFAULTS.baseArgs.slice(),
    env: isPlainObject(config.env) ? normalizeEnv(config.env) : {},
    maxRuns: positiveInt(config.maxRuns, DEFAULTS.maxRuns, 1, 100),
    maxLines: positiveInt(config.maxLines, DEFAULTS.maxLines, 100, 200000),
    defaultTimeoutSec: positiveInt(config.defaultTimeoutSec, DEFAULTS.defaultTimeoutSec, 1, 24 * 3600),
    followRoot: typeof config.followRoot === 'string' && config.followRoot.trim() !== '' ? config.followRoot.trim() : null,
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
  return Object.freeze(settings)
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

/** Package patterns accepted from the panel: relative Go patterns only. */
const PACKAGE_PATTERN = /^\.{0,2}\/?[A-Za-z0-9_.\-/]*$/

/** Test-name regexes accepted from the panel (`-run`). */
const TEST_PATTERN = /^[A-Za-z0-9_./|()[\]*+?^$-]+$/

/**
 * Validate the optional run options coming from HTTP or a tool call.
 * @param options - candidate options.
 * @param settings - resolved plugin config.
 * @returns normalized options, or throws with a readable message.
 */
export function normalizeRunOptions(options, settings) {
  const input = isPlainObject(options) ? options : {}
  const packages = Array.isArray(input.packages) ? input.packages.map(String) : []
  for (const pattern of packages) {
    if (!PACKAGE_PATTERN.test(pattern) || pattern.startsWith('/')) {
      throw new Error(`package pattern "${pattern}" is not allowed; use relative patterns such as ./... or ./database/kdb`)
    }
  }
  let pattern = ''
  if (typeof input.pattern === 'string') pattern = input.pattern.trim()
  if (pattern !== '' && !TEST_PATTERN.test(pattern)) {
    throw new Error(`test pattern "${pattern}" contains unsupported characters`)
  }
  const timeoutSec = positiveInt(input.timeoutSec, settings.defaultTimeoutSec, 1, 24 * 3600)
  return {
    // An empty list means "the whole module", the same default the panel shows.
    packages: packages.length > 0 ? packages : settings.kind === 'go-test' ? ['./...'] : [],
    pattern,
    verbose: input.verbose === true,
    race: input.race === true,
    count: input.count === true,
    timeoutSec,
  }
}

/**
 * Build the argv (without the executable) for one run.
 * @param options - normalized run options.
 * @param kind - 'go-test' or 'command'.
 * @returns argument list.
 */
export function buildArgs(options, kind = DEFAULTS.kind) {
  if (kind === 'command') return []
  const args = []
  if (options.verbose) args.push('-v')
  if (options.race) args.push('-race')
  if (options.count) args.push('-count=1')
  if (options.pattern !== '') args.push(`-run=${options.pattern}`)
  args.push(`-timeout=${options.timeoutSec}s`)
  for (const pattern of options.packages) args.push(pattern)
  return args
}
