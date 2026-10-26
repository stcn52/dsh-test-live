/**
 * Run registry: one child process per run, a bounded line buffer, and subscriber
 * fan-out for the SSE endpoint and the tools.
 *
 * Why in-process instead of a background job: the panel must see lines while the
 * process is still running, which means the host has to hold the pipe.
 *
 * Lifetime: a run is owned by the **conversation** that started it (not by a
 * project directory) and outlives the host process — finished runs are written
 * through `core/store.js` and replayed into the same registry at startup, marked
 * `archived`. A run that was still `running` when the host died is replayed as
 * `canceled`, because its child is gone and pretending otherwise would leave a
 * spinner nobody can stop.
 * @module dsh-test-live/runner
 */

import { randomUUID } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { buildArgs, normalizeRunOptions } from './config.js'
import { classifyLine, createSummary, deriveStatus, observeLine, summarize } from './parse.js'
import { createRunStore } from './store.js'

/** Synthetic line emitted when the child cannot even start. */
const SPAWN_FAILURE_PREFIX = 'cannot start '

/** Error recorded on a run that was alive when the host restarted. */
export const INTERRUPTED_ERROR = '宿主重启，运行被中断'

/** Statuses a stored run may carry; anything else is treated as failed. */
const STORED_STATUSES = new Set(['running', 'passed', 'failed', 'canceled'])

/** Largest chunk read from a followed file per tick (keeps one read bounded). */
const MAX_FOLLOW_CHUNK = 1 << 20

/**
 * @param value - candidate.
 * @returns the absolute path, or null (a relative cwd would silently resolve
 * against the host's directory and run the tests in the wrong project).
 */
function absolutePathOrNull(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.startsWith('/') ? trimmed : null
}

/**
 * @param value - candidate.
 * @returns the trimmed non-empty string, else null.
 */
function textOrNull(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Normalize the caller-supplied run ownership.
 *
 * `context` is what the routes/tools learned from the session resolver; every
 * field is optional so an old client that knows nothing about conversations
 * still starts a run (it just gets no owner).
 * @param context - `{ sessionId, sessionLabel, cwd, origin }` or anything.
 * @returns the four normalized fields, null/false when absent.
 */
export function normalizeContext(context) {
  const input = context !== null && typeof context === 'object' ? context : {}
  return {
    sessionId: textOrNull(input.sessionId),
    sessionLabel: textOrNull(input.sessionLabel),
    cwd: absolutePathOrNull(input.cwd),
    origin: input.origin === 'tool' || input.origin === 'panel' ? input.origin : null,
  }
}

/**
 * A run id that does not collide across restarts.
 *
 * The old id was eight hex characters of a random UUID: unique inside one
 * process, but 32 bits is not enough once ids are replayed from disk and the
 * panel links to a run by id alone. The base-36 millisecond stamp pins the order
 * and two random bytes break ties within the same millisecond.
 * @returns run id.
 */
function makeRunId() {
  return `run_${Date.now().toString(36)}${randomUUID().slice(0, 4)}`
}

/**
 * The roots this deployment allows a follow to read, in panel order.
 *
 * `followRoots` is the allow-list; an empty list falls back to the historical
 * single root (`followRoot`, else `cwd`, else the process directory), so a
 * profile written before the list existed behaves exactly as it did.
 * @param settings - resolved plugin config.
 * @returns absolute root strings.
 */
export function allowedFollowRoots(settings) {
  const roots = Array.isArray(settings.followRoots)
    ? settings.followRoots.filter(root => typeof root === 'string' && root.trim() !== '')
    : []
  if (roots.length > 0) return roots.slice()
  return [settings.followRoot ?? settings.cwd ?? process.cwd()]
}

/**
 * The root a relative path is resolved against when the caller names none.
 * @param settings - resolved plugin config.
 * @returns absolute root.
 */
function defaultFollowRoot(settings) {
  const listed = Array.isArray(settings.followRoots) && settings.followRoots.length > 0 ? settings.followRoots[0] : null
  return settings.followRoot ?? listed ?? settings.cwd ?? process.cwd()
}

/**
 * Resolve a path to its real location without requiring the tail to exist.
 *
 * `realpathSync` refuses a path whose last component is missing yet, and a
 * followed log legitimately appears after the follow starts (`tail -F`). So the
 * deepest existing ancestor is resolved and the missing tail is re-appended.
 * @param target - absolute path.
 * @returns the real path, or null for a dangling symlink (it would name a file
 * outside the tree the moment a writer created the target).
 */
function realPathLenient(target) {
  let current = target
  const missing = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return missing.length === 0 ? real : join(real, ...missing)
    } catch (error) {
      if (error === null || typeof error !== 'object' || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) {
        return target
      }
      try {
        if (lstatSync(current).isSymbolicLink()) return null
      } catch {
        // Not there at all: an ordinary missing component, keep walking up.
      }
      const parent = dirname(current)
      if (parent === current) return target
      missing.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * Resolve a follow path against the allowed roots and refuse anything outside
 * them. The panel is reachable over the LAN, so following an arbitrary host
 * path would turn it into a file reader.
 *
 * The prefix test runs on real paths, not on the literal string: a symlink
 * planted inside a root must not become a window onto `/etc`.
 * @param inputPath - caller-supplied path (absolute or relative to the root).
 * @param settings - resolved plugin config.
 * @param root - optional explicit root; must be one of {@link allowedFollowRoots}.
 * @returns absolute path inside the root.
 */
export function resolveFollowPath(inputPath, settings, root) {
  return resolveFollowPathIn(inputPath, allowedFollowRoots(settings), defaultFollowRoot(settings), root)
}

/**
 * Resolve a follow path against an explicit allow-list.
 *
 * The list is a parameter because the hub validates against
 * {@link followRootsFor}: the deployment roots *plus* the calling session's own
 * working directory, so a conversation may follow a log in the project it is
 * working in without that path having to be in the static profile.
 * @param inputPath - caller-supplied path.
 * @param roots - absolute allow-list (first entry is the default root).
 * @param fallbackRoot - root to use when the list is empty.
 * @param root - optional explicit root; must be in `roots`.
 * @returns absolute path inside one of the roots.
 */
function resolveFollowPathIn(inputPath, roots, fallbackRoot, root) {
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new Error('follow path is required')
  }
  if (root !== undefined && root !== null) assertConfiguredRoot(root, roots)
  const base = resolve(root ?? roots[0] ?? fallbackRoot ?? process.cwd())
  const target = resolve(base, inputPath.trim())
  const baseReal = realPathLenient(base) ?? base
  const targetReal = realPathLenient(target)
  if (targetReal === null) {
    throw new Error(`follow path "${inputPath}" is a dangling symbolic link`)
  }
  const prefix = baseReal.endsWith(sep) ? baseReal : baseReal + sep
  if (targetReal !== baseReal && !targetReal.startsWith(prefix)) {
    throw new Error(`follow path "${inputPath}" is outside ${base}`)
  }
  return target
}

/**
 * Refuse a root the deployment never configured: the panel may pick among the
 * configured roots but may not widen the allow-list from a request.
 * @param root - candidate root from HTTP or a tool call.
 * @param roots - the allow-list for this call.
 */
function assertConfiguredRoot(root, roots) {
  const wanted = resolve(String(root).trim())
  const known = roots.some(candidate => resolve(candidate) === wanted)
  if (!known) {
    throw new Error(`follow root "${root}" is not one of the configured follow roots`)
  }
}

/**
 * Split a chunk into complete lines.
 * @param text - chunk of stdout/stderr.
 * @param carry - unfinished trailing line from the previous chunk.
 * @returns the complete lines plus the new carry.
 */
export function drainLines(text, carry) {
  const buffer = carry + text
  const parts = buffer.split('\n')
  const nextCarry = parts.pop() ?? ''
  const lines = []
  for (const part of parts) {
    // Windows pipes and progress bars may leave a CR; it would render as a box.
    lines.push(part.endsWith('\r') ? part.slice(0, -1) : part)
  }
  return { lines, carry: nextCarry }
}

/**
 * Create the run hub.
 * @param settings - resolved plugin config.
 * @param deps - test seams: `spawn` (defaults to child_process.spawn), `now`,
 * `signalProcess` (defaults to process.kill; the group-kill seam), and `store`
 * (defaults to one built from `settings.stateFile`; pass null to keep runs in
 * memory only).
 * @returns hub API used by routes and tools.
 */
export function createHub(settings, deps = {}) {
  const spawn = deps.spawn ?? nodeSpawn
  const now = deps.now ?? (() => Date.now())
  const signalProcess = deps.signalProcess ?? ((pid, signal) => process.kill(pid, signal))
  // `'store' in deps` (not `deps.store ?? …`) so an explicit null really means
  // "no persistence", which is what the tests rely on.
  const store =
    'store' in deps
      ? deps.store
      : settings.stateFile === null || settings.stateFile === undefined
        ? null
        : createRunStore({
            stateFile: settings.stateFile,
            historyRuns: settings.historyRuns,
            historyLines: settings.historyLines,
          })
  /** @type {Map<string, object>} */
  const runs = new Map()
  /** insertion order of ids, oldest first */
  const order = []

  /**
   * Directory the next spawned run starts in.
   *
   * Precedence: the session's own cwd (the run happens where the conversation
   * is), then the deployment hook, then `config.cwd`, then the host directory.
   * `config.cwd` is a fallback, not the owner: a fleet-wide log must not stamp
   * every run with one project.
   * @param context - normalized run ownership.
   * @returns absolute directory.
   */
  function spawnCwd(context) {
    const provided = typeof deps.cwdFor === 'function' ? deps.cwdFor(context) : undefined
    return absolutePathOrNull(context?.cwd) ?? absolutePathOrNull(provided) ?? settings.cwd ?? process.cwd()
  }

  /**
   * @returns the configured follow roots, in panel order.
   */
  function roots() {
    return allowedFollowRoots(settings)
  }

  /**
   * @returns the configured run directory, for the panel's root picker label.
   */
  function cwd() {
    return settings.cwd ?? process.cwd()
  }

  /**
   * The roots a call from `context` may follow files in: the deployment's
   * allow-list plus the session's working directory.
   *
   * This is what keeps a follow useful without turning the panel into a file
   * reader: a conversation may read its own project, not the whole disk.
   * @param context - run ownership (raw or normalized; may be undefined).
   * @returns absolute root strings, config order first.
   */
  function followRootsFor(context) {
    const normalized = normalizeContext(context)
    const list = allowedFollowRoots(settings).map(root => resolve(root))
    if (normalized.cwd !== null && !list.includes(resolve(normalized.cwd))) list.push(resolve(normalized.cwd))
    return list
  }

  /**
   * The in-memory shape of one run.
   *
   * Separated from {@link createRun} so history replay can build a run without
   * registering it (and without trimming, which would evict the very records
   * being loaded).
   * @param fields - overrides of the defaults (kind, command, args, cwd, ...).
   * @returns run state (not yet in the registry).
   */
  function baseRun(fields) {
    const input = fields ?? {}
    let id = textOrNull(input.id) ?? makeRunId()
    // A restored id must not collide with a live one; a fresh id is cheap and
    // keeps the panel's id links unambiguous.
    while (runs.has(id)) id = makeRunId()
    return {
      kind: 'command',
      status: 'running',
      command: settings.command,
      args: [],
      cwd: settings.cwd ?? process.cwd(),
      // Ownership: which conversation started it, under which label, from which
      // surface, and whether it came back from disk rather than from this process.
      sessionId: null,
      sessionLabel: null,
      origin: null,
      archived: false,
      startedAt: now(),
      finishedAt: null,
      durationMs: null,
      exitCode: null,
      signal: null,
      error: null,
      timedOut: false,
      canceled: false,
      timeoutSec: settings.defaultTimeoutSec,
      truncated: false,
      lines: [],
      seq: 0,
      carry: '',
      provisional: null,
      summary: createSummary(),
      listeners: new Set(),
      child: null,
      timer: null,
      // True when the child owns a fresh process group, so a group signal
      // reaches `go test` and every test binary it forked.
      detached: false,
      // File-follow mode: the path being tailed and the read offset.
      file: null,
      offset: 0,
      followTimer: null,
      ...input,
      id,
    }
  }

  /**
   * Register one run in the history and return it.
   * @param fields - overrides of the defaults (kind, command, args, cwd, ...).
   * @returns run state.
   */
  function createRun(fields) {
    const run = baseRun(fields)
    runs.set(run.id, run)
    order.push(run.id)
    trimHistory()
    persist()
    return run
  }

  /**
   * The registry as the store wants it: oldest first, with the run's line
   * counter exposed as `lastSeq` (the store trims the tail to `historyLines`).
   * @returns run records.
   */
  function snapshot() {
    return order
      .map(id => runs.get(id))
      .filter(Boolean)
      .map(run => ({ ...run, lastSeq: run.seq }))
  }

  /**
   * Hand the current registry to the store. The store throttles and never
   * throws; a persistence problem degrades to "history is shorter after a
   * restart", not to a failed run.
   */
  function persist() {
    if (store === null) return
    try {
      store.save(snapshot())
    } catch {
      // The store is written defensively; this only guards a caller-supplied one.
    }
  }

  /**
   * Rebuild one run from a stored record.
   *
   * A run that was `running` when the host died is reported as `canceled` with
   * {@link INTERRUPTED_ERROR}: its child is gone, and a permanent spinner would
   * look cancellable but never stop.
   * @param record - stored run record.
   * @returns run state marked archived.
   */
  function restoreRun(record) {
    const startedAt = typeof record.startedAt === 'number' ? record.startedAt : now()
    const wasRunning = record.status === 'running'
    const status = wasRunning ? 'canceled' : STORED_STATUSES.has(record.status) ? record.status : 'failed'
    const finishedAt = wasRunning ? now() : typeof record.finishedAt === 'number' ? record.finishedAt : null
    const lines = []
    if (Array.isArray(record.lines)) {
      for (const entry of record.lines) {
        if (entry === null || typeof entry !== 'object') continue
        const seq = Number.isInteger(entry.seq) && entry.seq > 0 ? entry.seq : lines.length + 1
        const text = typeof entry.text === 'string' ? entry.text : String(entry.text ?? '')
        lines.push({ seq, text, kind: textOrNull(entry.kind) ?? classifyLine(text), provisional: false })
      }
    }
    const lastSeq = Number.isInteger(record.lastSeq) ? record.lastSeq : lines.length > 0 ? lines[lines.length - 1].seq : 0
    const fresh = createSummary()
    const stored = record.summary !== null && typeof record.summary === 'object' ? record.summary : null
    const summary =
      stored === null
        ? fresh
        : {
            tests: { ...fresh.tests, ...(stored.tests ?? {}) },
            packages: { ...fresh.packages, ...(stored.packages ?? {}) },
            failures: Array.isArray(stored.failures) ? stored.failures.slice() : fresh.failures,
            buildErrors: Array.isArray(stored.buildErrors) ? stored.buildErrors.slice() : fresh.buildErrors,
            coverage: Array.isArray(stored.coverage) ? stored.coverage.slice() : fresh.coverage,
          }
    return baseRun({
      id: record.id,
      kind: record.kind === 'file' ? 'file' : 'command',
      file: textOrNull(record.file),
      status,
      command: typeof record.command === 'string' ? record.command : settings.command,
      args: Array.isArray(record.args) ? record.args.map(String) : [],
      cwd: absolutePathOrNull(record.cwd) ?? settings.cwd ?? process.cwd(),
      sessionId: textOrNull(record.sessionId),
      sessionLabel: textOrNull(record.sessionLabel),
      origin: record.origin === 'tool' || record.origin === 'panel' ? record.origin : null,
      archived: true,
      startedAt,
      finishedAt,
      durationMs: wasRunning ? finishedAt - startedAt : typeof record.durationMs === 'number' ? record.durationMs : null,
      exitCode: Number.isInteger(record.exitCode) ? record.exitCode : null,
      signal: textOrNull(record.signal),
      error: wasRunning ? INTERRUPTED_ERROR : textOrNull(record.error),
      timedOut: record.timedOut === true,
      canceled: wasRunning || record.canceled === true,
      timeoutSec: settings.defaultTimeoutSec,
      truncated: record.truncated === true,
      lines,
      seq: Math.max(lastSeq, lines.length > 0 ? lines[lines.length - 1].seq : 0),
      summary,
    })
  }

  // Replay the stored history into the same registry before the first request.
  if (store !== null) {
    let restored = []
    try {
      restored = store.load()
    } catch {
      restored = []
    }
    for (const record of Array.isArray(restored) ? restored : []) {
      if (record === null || typeof record !== 'object' || textOrNull(record.id) === null) continue
      if (runs.has(record.id)) continue
      const run = restoreRun(record)
      runs.set(run.id, run)
      order.push(run.id)
    }
  }

  /**
   * Register a run and start its child process.
   * @param options - raw run options from HTTP or a tool.
   * @param context - run ownership from the session resolver.
   * @returns the run meta (the panel binds to its id).
   */
  function start(options, context) {
    const normalizedOptions = normalizeRunOptions(options, settings)
    const owner = normalizeContext(context)
    const run = createRun({
      // `...owner` first: its `cwd` is the *session's* directory, which
      // `spawnCwd` may well have rejected (relative) or overridden.
      ...owner,
      kind: 'command',
      command: settings.command,
      args: [...settings.baseArgs, ...buildArgs(normalizedOptions, settings.kind)],
      cwd: spawnCwd(owner),
      timeoutSec: normalizedOptions.timeoutSec,
    })

    let child
    const detached = process.platform !== 'win32'
    try {
      child = spawn(settings.command, run.args, {
        cwd: run.cwd,
        env: { ...process.env, ...settings.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group. A signal to the group then hits `go test` and the
        // test binaries it forked, and never the host's group.
        detached,
      })
    } catch (error) {
      failToStart(run, error)
      return metaOf(run)
    }
    run.detached = detached
    run.child = child
    child.on('error', error => failToStart(run, error))
    for (const stream of [child.stdout, child.stderr]) {
      if (stream === null || stream === undefined) continue
      stream.setEncoding('utf8')
      stream.on('data', chunk => appendChunk(run, chunk))
    }
    child.on('close', (code, signal) => finish(run, code, signal))
    if (normalizedOptions.timeoutSec > 0) {
      run.timer = setTimeout(() => {
        run.timedOut = true
        run.error = `timeout after ${normalizedOptions.timeoutSec}s`
        kill(run)
      }, normalizedOptions.timeoutSec * 1000)
      if (typeof run.timer.unref === 'function') run.timer.unref()
    }
    return metaOf(run)
  }

  /**
   * Append a chunk, splitting it into lines and notifying subscribers.
   * @param run - run state.
   * @param chunk - decoded text.
   */
  function appendChunk(run, chunk) {
    const { lines, carry } = drainLines(chunk, run.carry)
    run.carry = carry
    for (const text of lines) completeLine(run, text)
    if (carry !== '') partialLine(run, carry)
  }

  /**
   * Push (or complete) a newline-terminated line.
   * @param run - run state.
   * @param text - the line.
   */
  function completeLine(run, text) {
    if (run.provisional !== null) {
      // The partial line was the beginning of this one: replace it in place so
      // the panel updates a line instead of appending a duplicate.
      const entry = run.provisional
      run.provisional = null
      entry.text = text
      entry.kind = classifyLine(text)
      entry.provisional = false
      observeLine(run.summary, text)
      notifyLine(run, entry)
      return
    }
    pushNewLine(run, text, false)
  }

  /**
   * Push (or refresh) the not-yet-terminated tail line.
   * @param run - run state.
   * @param text - current tail text.
   */
  function partialLine(run, text) {
    if (run.provisional !== null) {
      run.provisional.text = text
      run.provisional.kind = classifyLine(text)
      notifyLine(run, run.provisional)
      return
    }
    run.provisional = pushNewLine(run, text, true)
  }

  /**
   * @param run - run state.
   * @param text - the line.
   * @param provisional - true while the line has no newline yet.
   * @returns the buffered entry.
   */
  function pushNewLine(run, text, provisional) {
    run.seq++
    const entry = { seq: run.seq, text, kind: classifyLine(text), provisional }
    if (!provisional) observeLine(run.summary, text)
    run.lines.push(entry)
    if (run.lines.length > settings.maxLines) {
      run.lines.splice(0, run.lines.length - settings.maxLines)
      run.truncated = true
      if (!run.lines.includes(run.provisional)) run.provisional = null
    }
    notifyLine(run, entry)
    return entry
  }

  /**
   * @param run - run state.
   * @param entry - buffered line.
   */
  function notifyLine(run, entry) {
    for (const listener of run.listeners) {
      try {
        listener.onLine?.(entry)
      } catch {
        // A dead browser tab must not kill the run.
      }
    }
  }

  /**
   * Mark the run finished and notify subscribers once.
   * @param run - run state.
   * @param code - exit code.
   * @param signal - termination signal.
   */
  function finish(run, code, signal) {
    if (run.status !== 'running') return
    run.exitCode = typeof code === 'number' ? code : null
    run.signal = signal ?? null
    if (run.carry !== '') {
      completeLine(run, run.carry)
      run.carry = ''
    }
    run.finishedAt = now()
    run.durationMs = run.finishedAt - run.startedAt
    run.status = deriveStatus(run.exitCode, run.canceled, run.timedOut, run.summary)
    clearTimer(run)
    notifyStatus(run)
    persist()
  }

  /**
   * Record a spawn-level failure (command missing, cwd gone, ...).
   * @param run - run state.
   * @param error - the thrown error.
   */
  function failToStart(run, error) {
    if (run.status !== 'running') return
    run.error = error instanceof Error ? error.message : String(error)
    completeLine(run, SPAWN_FAILURE_PREFIX + run.command + ': ' + run.error)
    run.finishedAt = now()
    run.durationMs = run.finishedAt - run.startedAt
    run.status = 'failed'
    clearTimer(run)
    notifyStatus(run)
    persist()
  }

  /**
   * @param run - run state.
   */
  function clearTimer(run) {
    if (run.timer !== null) {
      clearTimeout(run.timer)
      run.timer = null
    }
  }

  /**
   * @param run - run state.
   */
  function notifyStatus(run) {
    const meta = metaOf(run)
    for (const listener of run.listeners) {
      try {
        listener.onStatus?.(meta)
      } catch {
        // Same rationale as onLine.
      }
    }
  }

  /**
   * Send one termination signal to a run's whole tree: its process group when
   * the child owns one, otherwise the child itself.
   * @param run - run state.
   * @param signal - termination signal.
   */
  function signalRun(run, signal) {
    const child = run.child
    if (child === null || child === undefined) return
    const pid = child.pid
    if (run.detached && Number.isInteger(pid) && pid > 0) {
      try {
        // Negative pid = the group led by the child, so forked test binaries die
        // with `go test` instead of surviving as orphans.
        signalProcess(-pid, signal)
        return
      } catch {
        // Group already gone, or no permission: fall through to the child.
      }
    }
    try {
      child.kill(signal)
    } catch {
      // Already gone.
    }
  }

  /**
   * Ask the child to stop (TERM, then KILL).
   * @param run - run state.
   * @returns true when a running child was signalled.
   */
  function kill(run) {
    const child = run.child
    if (child === null || child === undefined || run.status !== 'running') return false
    if (run.error === null) run.canceled = true
    signalRun(run, 'SIGTERM')
    const escalate = setTimeout(() => {
      signalRun(run, 'SIGKILL')
    }, 3000)
    if (typeof escalate.unref === 'function') escalate.unref()
    return true
  }

  /**
   * Follow a log file written by someone else (terminal, bash, CI).
   *
   * The file is polled; every complete line goes through the same buffer,
   * classifier and SSE fan-out as a spawned run, so the panel behaves the same.
   * There is no exit code to observe: the run stays `running` until cancelled.
   * @param inputPath - path inside one of the roots this call is allowed to read.
   * @param root - optional root to resolve against; must be allowed.
   * @param context - run ownership; its cwd widens the allow-list for this call.
   * @returns run meta.
   */
  function follow(inputPath, root, context) {
    const owner = normalizeContext(context)
    const file = resolveFollowPathIn(inputPath, followRootsFor(owner), defaultFollowRoot(settings), root)
    const run = createRun({
      ...owner,
      kind: 'file',
      command: file,
      // A followed log lives where the file is, whatever the session cwd is.
      cwd: dirname(file),
      file,
    })
    pumpFile(run)
    return metaOf(run)
  }

  /**
   * Read new bytes of a followed file, then schedule the next tick.
   * @param run - run state.
   */
  async function pumpFile(run) {
    if (run.status !== 'running') return
    try {
      const info = await stat(run.file)
      if (info.size < run.offset) {
        // Truncated or replaced (`> file` again): start over from the beginning.
        run.offset = 0
        completeLine(run, '(file truncated, re-reading from the start)')
      }
      run.waitingForFile = false
      if (info.size > run.offset) {
        const length = Math.min(info.size - run.offset, MAX_FOLLOW_CHUNK)
        const handle = await open(run.file, 'r')
        try {
          const buffer = Buffer.alloc(length)
          const { bytesRead } = await handle.read(buffer, 0, length, run.offset)
          run.offset += bytesRead
          if (bytesRead > 0) appendChunk(run, buffer.subarray(0, bytesRead).toString('utf8'))
        } finally {
          await handle.close()
        }
      }
    } catch (error) {
      if (run.status !== 'running') return
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        // `tail -F` semantics: the writer (tee) may not have created the file yet,
        // so wait for it instead of failing the follow.
        if (run.waitingForFile !== true) {
          run.waitingForFile = true
          completeLine(run, `waiting for ${run.file} to appear…`)
        }
      } else {
        completeLine(run, `cannot read ${run.file}: ${error instanceof Error ? error.message : String(error)}`)
        run.status = 'failed'
        run.finishedAt = now()
        run.durationMs = run.finishedAt - run.startedAt
        notifyStatus(run)
        persist()
        return
      }
    }
    if (run.status !== 'running') return
    run.followTimer = setTimeout(() => { pumpFile(run) }, settings.followIntervalMs)
    if (typeof run.followTimer.unref === 'function') run.followTimer.unref()
  }

  /**
   * Stop following a file (the writer keeps running; we only stop reading).
   * @param run - file run state.
   * @returns true when the run was still active.
   */
  function stopFollowing(run) {
    if (run.status !== 'running') return false
    if (run.followTimer !== null) {
      clearTimeout(run.followTimer)
      run.followTimer = null
    }
    run.canceled = true
    run.status = 'canceled'
    run.finishedAt = now()
    run.durationMs = run.finishedAt - run.startedAt
    notifyStatus(run)
    persist()
    return true
  }

  /**
   * Cancel one run by id: signal a child, or stop following a file.
   * @param id - run id.
   * @returns true when something was stopped.
   */
  function cancel(id) {
    const run = runs.get(id)
    if (!run) return false
    if (run.kind === 'file') return stopFollowing(run)
    return kill(run)
  }

  /**
   * @param id - run id.
   * @returns run meta or null.
   */
  function get(id) {
    const run = runs.get(id)
    return run ? metaOf(run) : null
  }

  /**
   * @param filter - optional `{ sessionId?, limit? }`; a sessionId keeps only
   * runs started from that conversation.
   * @returns metas, newest first.
   */
  function list(filter) {
    const input = filter !== null && typeof filter === 'object' ? filter : {}
    const sessionId = textOrNull(input.sessionId)
    let metas = order
      .slice()
      .reverse()
      .map(id => metaOf(runs.get(id)))
      .filter(Boolean)
    if (sessionId !== null) metas = metas.filter(meta => meta.sessionId === sessionId)
    const limit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : null
    return limit === null ? metas : metas.slice(0, limit)
  }

  /**
   * @param filter - optional `{ sessionId? }`.
   * @returns the newest run meta (of that conversation), or null.
   */
  function latest(filter) {
    const found = list(filter !== null && typeof filter === 'object' ? { ...filter, limit: 1 } : { limit: 1 })
    return found.length > 0 ? found[0] : null
  }

  /**
   * One row per conversation that owns at least one run, newest activity first.
   *
   * The panel's filter needs this: the host's session list may not include a
   * session whose runs are all that is left of it (the conversation ended, the
   * history remains), so the registry is the authority for run ownership.
   * @returns `[{ id, label, cwd, count, running, lastAt }]`, newest first.
   */
  function sessions() {
    /** @type {Map<string, object>} */
    const byId = new Map()
    for (const id of order) {
      const run = runs.get(id)
      if (!run || run.sessionId === null) continue
      const row = byId.get(run.sessionId) ?? {
        id: run.sessionId,
        label: null,
        cwd: null,
        count: 0,
        running: false,
        lastAt: null,
      }
      row.count++
      if (run.status === 'running') row.running = true
      // The newest label/cwd wins: a session may be renamed or change directory.
      if (run.sessionLabel !== null) row.label = run.sessionLabel
      if (run.cwd !== null) row.cwd = run.cwd
      if (row.lastAt === null || run.startedAt >= row.lastAt) row.lastAt = run.startedAt
      byId.set(run.sessionId, row)
    }
    return [...byId.values()].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
  }

  /**
   * Lines of one run with seq greater than `since`.
   * @param id - run id.
   * @param since - last seq the caller already has.
   * @returns entries (empty when the run is unknown).
   */
  function linesSince(id, since) {
    const run = runs.get(id)
    if (!run) return []
    if (!Number.isInteger(since) || since < 0) return run.lines.slice()
    return run.lines.filter(entry => entry.seq > since)
  }

  /**
   * Wait until a run finishes (or the wait budget expires, or the caller aborts).
   * The wait is the host's only link to a run: abandoning it must be possible at
   * any moment, so an aborted signal settles at once without touching the run.
   * @param id - run id.
   * @param timeoutMs - maximum wait.
   * @param signal - optional AbortSignal (the tool call's cancellation).
   * @returns the meta at the end of the wait.
   */
  function waitFor(id, timeoutMs, signal) {
    const run = runs.get(id)
    if (!run) return Promise.resolve(null)
    if (run.status !== 'running') return Promise.resolve(metaOf(run))
    if (signal !== undefined && signal !== null && signal.aborted) return Promise.resolve(metaOf(run))
    return new Promise(resolve => {
      let settled = false
      const settle = value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        run.listeners.delete(listener)
        if (signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const listener = {
        onStatus(meta) {
          settle(meta)
        },
      }
      const onAbort = () => settle(metaOf(run))
      const timer = setTimeout(() => settle(metaOf(run)), timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      run.listeners.add(listener)
      if (signal !== undefined && signal !== null) signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Subscribe to a run's live events. Replays nothing: the caller sends its
   * backlog first and then streams.
   * @param id - run id.
   * @param listener - { onLine(entry), onStatus(meta) }.
   * @returns unsubscribe function, or null for an unknown run.
   */
  function subscribe(id, listener) {
    const run = runs.get(id)
    if (!run) return null
    run.listeners.add(listener)
    return () => run.listeners.delete(listener)
  }

  /** Keep only the newest `maxRuns` finished runs. */
  function trimHistory() {
    while (order.length > settings.maxRuns) {
      const id = order[0]
      const run = runs.get(id)
      if (run && run.status === 'running') break
      order.shift()
      runs.delete(id)
    }
  }

  /**
   * @param run - run state.
   * @returns the HTTP/tool-facing meta (no child, no listeners).
   */
  function metaOf(run) {
    const meta = {
      id: run.id,
      kind: run.kind,
      file: run.file,
      status: run.status,
      command: run.command,
      args: run.args,
      cwd: run.cwd,
      // Ownership, so a fleet-wide panel can group and filter by conversation.
      sessionId: run.sessionId,
      sessionLabel: run.sessionLabel,
      origin: run.origin,
      archived: run.archived === true,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      exitCode: run.exitCode,
      signal: run.signal,
      error: run.error,
      // Kept in the meta because the panel shows "已取消/超时" for a run whose
      // exit code alone does not say why it stopped.
      canceled: run.canceled === true,
      timedOut: run.timedOut === true,
      timeoutSec: run.timeoutSec,
      truncated: run.truncated,
      buffered: run.lines.length,
      lastSeq: run.seq,
      summary: run.summary,
      coverage: run.summary.coverage,
    }
    meta.summaryText = summarize(meta)
    return meta
  }

  /** Stop every running child (plugin disposal). */
  function dispose() {
    for (const id of order) {
      const run = runs.get(id)
      if (!run) continue
      if (run.followTimer !== null) {
        clearTimeout(run.followTimer)
        run.followTimer = null
      }
      if (run.status === 'running') {
        run.canceled = true
        if (run.kind === 'file') {
          run.status = 'canceled'
          run.finishedAt = now()
          run.durationMs = run.finishedAt - run.startedAt
        } else {
          kill(run)
        }
      }
      run.listeners.clear()
    }
    // Last chance to land the history: the plugin is unloading, no timer will
    // survive it. `flush` is a no-op on a disabled store and never throws.
    try {
      store?.flush?.()
    } catch {
      // Persistence is best-effort by contract.
    }
  }

  return {
    start,
    follow,
    cancel,
    get,
    list,
    latest,
    sessions,
    linesSince,
    waitFor,
    subscribe,
    dispose,
    roots,
    cwd,
    followRootsFor,
    persist,
    // The panel's opening scope, read by the routes as `hub.defaultScope`.
    defaultScope: settings.defaultScope === 'session' ? 'session' : 'all',
  }
}
