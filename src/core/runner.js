/**
 * Run registry: one child process per run, a bounded line buffer, and subscriber
 * fan-out for the SSE endpoint and the tools.
 *
 * Why in-process instead of a background job: the panel must see lines while the
 * process is still running, which means the host has to hold the pipe. Nothing
 * is persisted — a host restart drops finished runs, which is the honest
 * lifetime for "what is happening in this test run right now".
 * @module dsh-test-live/runner
 */

import { randomUUID } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { open, stat } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { buildArgs, normalizeRunOptions } from './config.js'
import { classifyLine, createSummary, deriveStatus, observeLine, summarize } from './parse.js'

/** Synthetic line emitted when the child cannot even start. */
const SPAWN_FAILURE_PREFIX = 'cannot start '

/** Largest chunk read from a followed file per tick (keeps one read bounded). */
const MAX_FOLLOW_CHUNK = 1 << 20

/**
 * Resolve a follow path against the allowed root and refuse anything outside it.
 * The panel is reachable over the LAN, so following an arbitrary host path would
 * turn it into a file reader.
 * @param inputPath - caller-supplied path (absolute or relative to the root).
 * @param settings - resolved plugin config.
 * @returns absolute path inside the root.
 */
export function resolveFollowPath(inputPath, settings) {
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new Error('follow path is required')
  }
  const base = resolve(settings.followRoot ?? settings.cwd ?? process.cwd())
  const target = resolve(base, inputPath.trim())
  const prefix = base.endsWith(sep) ? base : base + sep
  if (target !== base && !target.startsWith(prefix)) {
    throw new Error(`follow path "${inputPath}" is outside ${base}`)
  }
  return target
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
 * and `signalProcess` (defaults to process.kill; the group-kill seam).
 * @returns hub API used by routes and tools.
 */
export function createHub(settings, deps = {}) {
  const spawn = deps.spawn ?? nodeSpawn
  const now = deps.now ?? (() => Date.now())
  const signalProcess = deps.signalProcess ?? ((pid, signal) => process.kill(pid, signal))
  /** @type {Map<string, object>} */
  const runs = new Map()
  /** insertion order of ids, oldest first */
  const order = []

  /**
   * Register a run and start its child process.
   * @param options - raw run options from HTTP or a tool.
   * @returns the run meta (the panel binds to its id).
   */
  /**
   * Register one run in the history and return it.
   * @param fields - overrides of the defaults (kind, command, args, cwd, ...).
   * @returns run state.
   */
  function createRun(fields) {
    const run = {
      id: `run_${randomUUID().slice(0, 8)}`,
      kind: 'command',
      status: 'running',
      command: settings.command,
      args: [],
      cwd: settings.cwd ?? process.cwd(),
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
      ...fields,
    }
    runs.set(run.id, run)
    order.push(run.id)
    trimHistory()
    return run
  }

  /**
   * Register a run and start its child process.
   * @param options - raw run options from HTTP or a tool.
   * @returns the run meta (the panel binds to its id).
   */
  function start(options) {
    const normalized = normalizeRunOptions(options, settings)
    const run = createRun({
      kind: 'command',
      command: settings.command,
      args: [...settings.baseArgs, ...buildArgs(normalized, settings.kind)],
      cwd: settings.cwd ?? process.cwd(),
      timeoutSec: normalized.timeoutSec,
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
    if (normalized.timeoutSec > 0) {
      run.timer = setTimeout(() => {
        run.timedOut = true
        run.error = `timeout after ${normalized.timeoutSec}s`
        kill(run)
      }, normalized.timeoutSec * 1000)
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
   * @param inputPath - path inside the configured root.
   * @returns run meta.
   */
  function follow(inputPath) {
    const file = resolveFollowPath(inputPath, settings)
    const run = createRun({ kind: 'file', command: file, cwd: dirname(file), file })
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
   * @returns metas, newest first.
   */
  function list() {
    return order.slice().reverse().map(id => metaOf(runs.get(id))).filter(Boolean)
  }

  /**
   * @returns the newest run meta, or null.
   */
  function latest() {
    const id = order[order.length - 1]
    return id ? metaOf(runs.get(id)) : null
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
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      exitCode: run.exitCode,
      signal: run.signal,
      error: run.error,
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
  }

  return { start, follow, cancel, get, list, latest, linesSince, waitFor, subscribe, dispose }
}
