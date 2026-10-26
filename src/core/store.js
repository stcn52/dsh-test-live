/**
 * Durable run history.
 *
 * The panel is a fleet-wide test log: a run started from conversation A in
 * directory X must still be there after the host restarts, and must not vanish
 * when a conversation ends. So finished runs are written to one JSON file under
 * the DSH home, and replayed into the live registry at load.
 *
 * Two rules keep this file from becoming a liability:
 *   - persistence is *throttled* — a busy run finishing in a burst of lines
 *     costs one write, not one per line;
 *   - nothing here may throw at the caller — a read-only home, a full disk or a
 *     corrupt file degrades to "no history", never to a failed test run.
 * @module dsh-test-live/core/store
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** File format version; a different version is discarded rather than guessed at. */
const VERSION = 1

/** Default throttle: enough to coalesce a burst, short enough to survive a crash. */
const DEFAULT_DELAY_MS = 100

/**
 * Create the run store.
 * @param options - `{ stateFile, historyRuns, historyLines, delayMs, logger }`.
 *   `stateFile === null` disables persistence entirely (tests, privacy setups).
 * @returns `{ load, save, flush, enabled, stateFile }`.
 */
export function createRunStore(options = {}) {
  const stateFile = typeof options.stateFile === 'string' && options.stateFile !== '' ? options.stateFile : null
  const historyRuns = Number.isInteger(options.historyRuns) && options.historyRuns > 0 ? options.historyRuns : 100
  const historyLines = Number.isInteger(options.historyLines) && options.historyLines > 0 ? options.historyLines : 200
  const delayMs = Number.isInteger(options.delayMs) && options.delayMs >= 0 ? options.delayMs : DEFAULT_DELAY_MS
  const logger = options.logger ?? null
  /** Path of the pending write, so a temp file cannot outlive a failed rename. */
  const tempFile = stateFile === null ? null : `${stateFile}.${process.pid}.tmp`
  /** Serialized payload waiting for the throttle to expire, or null. */
  let pending = null
  let timer = null
  let lastError = null

  /**
   * Record a persistence problem where a human can see it, without throwing.
   * @param where - 'read' or 'write'.
   * @param error - the thrown value.
   */
  function warn(where, error) {
    lastError = error instanceof Error ? error.message : String(error)
    try {
      logger?.warn?.(`dsh-test-live: cannot ${where} ${stateFile}: ${lastError}`)
    } catch {
      // A logging service that throws is not worth failing a write over.
    }
  }

  /**
   * Keep the newest `limit` lines of one run.
   * @param lines - buffered lines.
   * @returns serializable lines `{seq,text,kind}`.
   */
  function tailLines(lines) {
    if (!Array.isArray(lines)) return []
    const start = Math.max(0, lines.length - historyLines)
    const out = []
    for (const entry of lines.slice(start)) {
      if (entry === null || typeof entry !== 'object') continue
      out.push({ seq: entry.seq, text: entry.text, kind: entry.kind })
    }
    return out
  }

  /**
   * Serialize the registry for the disk.
   * @param runs - run records, oldest first.
   * @returns the JSON payload.
   */
  function payload(runs) {
    const list = Array.isArray(runs) ? runs : []
    const kept = list.slice(Math.max(0, list.length - historyRuns))
    return {
      version: VERSION,
      savedAt: Date.now(),
      runs: kept.map(run => ({
        id: run.id,
        kind: run.kind,
        file: run.file ?? null,
        // Which runner produced the run, so restored history still labels and
        // summarises itself the way it did when it finished.
        runner: run.runner ?? null,
        runnerLabel: run.runnerLabel ?? null,
        detectReason: run.detectReason ?? null,
        status: run.status,
        command: run.command,
        args: Array.isArray(run.args) ? run.args.map(String) : [],
        cwd: run.cwd,
        sessionId: run.sessionId ?? null,
        sessionLabel: run.sessionLabel ?? null,
        origin: run.origin ?? null,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt ?? null,
        durationMs: run.durationMs ?? null,
        exitCode: run.exitCode ?? null,
        signal: run.signal ?? null,
        error: run.error ?? null,
        timedOut: run.timedOut === true,
        canceled: run.canceled === true,
        timeoutSec: run.timeoutSec,
        truncated: run.truncated === true,
        lastSeq: Number.isInteger(run.lastSeq) ? run.lastSeq : Array.isArray(run.lines) ? run.lines.length : 0,
        summary: run.summary ?? null,
        lines: tailLines(run.lines),
      })),
    }
  }

  /**
   * Write the pending payload now.
   * @returns true when a write happened.
   */
  function writeNow() {
    if (stateFile === null || pending === null) return false
    const body = pending
    pending = null
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(tempFile, body, 'utf8')
      // Rename, so a crash mid-write leaves the previous good file in place.
      renameSync(tempFile, stateFile)
      return true
    } catch (error) {
      try {
        unlinkSync(tempFile)
      } catch {
        // Nothing there: the write failed before creating it.
      }
      warn('write', error)
      return false
    }
  }

  /**
   * Read the stored runs.
   * @returns run records oldest first; `[]` when the file is missing, corrupt or
   * written by a newer version.
   */
  function load() {
    if (stateFile === null) return []
    let raw
    try {
      raw = readFileSync(stateFile, 'utf8')
    } catch (error) {
      // ENOENT is the normal first start; anything else is worth a log line.
      if (error === null || typeof error !== 'object' || error.code !== 'ENOENT') warn('read', error)
      return []
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      warn('read', error)
      return []
    }
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== VERSION) return []
    if (!Array.isArray(parsed.runs)) return []
    const runs = []
    for (const record of parsed.runs) {
      if (record === null || typeof record !== 'object') continue
      if (typeof record.id !== 'string' || record.id === '') continue
      runs.push(record)
    }
    return runs.slice(Math.max(0, runs.length - historyRuns))
  }

  /**
   * Queue the registry for writing. Coalesces bursts into one write.
   * @param runs - run records, oldest first.
   */
  function save(runs) {
    if (stateFile === null) return
    try {
      pending = JSON.stringify(payload(runs))
    } catch (error) {
      // A summary containing a cycle is a bug, but not one that may fail a run.
      warn('write', error)
      return
    }
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      writeNow()
    }, delayMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  /**
   * Write immediately (plugin disposal, tests). Safe to call on a disabled store.
   * @returns true when a write happened.
   */
  function flush() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    return writeNow()
  }

  return { load, save, flush, enabled: stateFile !== null, stateFile, lastError: () => lastError }
}

export default createRunStore
