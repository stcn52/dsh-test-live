/**
 * One pass over the child's output: classify each line for the panel and fold
 * the Go test result markers into a summary.
 *
 * The classification is deliberately textual (`go test` output, not `-json`):
 * the panel streams raw lines, and `-json` would make the log unreadable for a
 * human while adding a second encoding to keep in sync.
 * @module dsh-test-live/parse
 */

/** Line kinds the panel knows how to colour. */
export const LINE_KINDS = Object.freeze([
  'plain',
  'run',
  'pass',
  'fail',
  'skip',
  'package-ok',
  'package-fail',
  'package-empty',
  'build',
  'result',
  'panic',
])

const RUN_LINE = /^=== (?:RUN|PAUSE|CONT)\s+(.+)$/
const PASS_LINE = /^--- PASS:\s+(\S+)/
const FAIL_LINE = /^--- FAIL:\s+(\S+)/
const SKIP_LINE = /^--- SKIP:\s+(\S+)/
const PACKAGE_OK = /^ok\s+(\S+)\s+/
const PACKAGE_FAIL = /^FAIL\s+(\S+)\s+/
const PACKAGE_EMPTY = /^\?\s+(\S+)\s+\[no test files\]/
const BUILD_ERROR = /^#\s+(\S+)/

/**
 * @param text - one output line (no trailing newline).
 * @returns the line kind used for colouring.
 */
export function classifyLine(text) {
  if (RUN_LINE.test(text)) return 'run'
  if (PASS_LINE.test(text)) return 'pass'
  if (FAIL_LINE.test(text)) return 'fail'
  if (SKIP_LINE.test(text)) return 'skip'
  if (PACKAGE_OK.test(text)) return 'package-ok'
  if (PACKAGE_FAIL.test(text)) return 'package-fail'
  if (PACKAGE_EMPTY.test(text)) return 'package-empty'
  if (BUILD_ERROR.test(text)) return 'build'
  if (text === 'PASS' || text === 'FAIL') return 'result'
  if (text.startsWith('panic:') || text.startsWith('fatal error:')) return 'panic'
  return 'plain'
}

/**
 * Create the empty summary of one run.
 * @returns summary state.
 */
export function createSummary() {
  return {
    packages: { ok: [], fail: [], noTest: [] },
    tests: { pass: 0, fail: 0, skip: 0 },
    failures: [],
    buildErrors: [],
    coverage: [],
  }
}

/**
 * Fold one line into the summary.
 * @param summary - summary state (mutated).
 * @param text - one output line.
 */
export function observeLine(summary, text) {
  let match
  if ((match = PASS_LINE.exec(text))) {
    summary.tests.pass++
    return
  }
  if ((match = FAIL_LINE.exec(text))) {
    summary.tests.fail++
    summary.failures.push(match[1])
    return
  }
  if ((match = SKIP_LINE.exec(text))) {
    summary.tests.skip++
    return
  }
  if ((match = PACKAGE_OK.exec(text))) {
    summary.packages.ok.push(match[1])
    return
  }
  if ((match = PACKAGE_FAIL.exec(text))) {
    summary.packages.fail.push(match[1])
    return
  }
  if ((match = PACKAGE_EMPTY.exec(text))) {
    summary.packages.noTest.push(match[1])
    return
  }
  if ((match = BUILD_ERROR.exec(text))) {
    if (!summary.buildErrors.includes(match[1])) summary.buildErrors.push(match[1])
    return
  }
  if (text.startsWith('coverage: ')) summary.coverage.push(text.slice('coverage: '.length))
}

/**
 * Derive the final status from the process result and the observed markers.
 * @param exitCode - process exit code (null when killed by a signal).
 * @param killedByUser - true when cancel() stopped it.
 * @param timedOut - true when the wall-clock cap fired.
 * @param summary - observed summary.
 * @returns 'passed' | 'failed' | 'canceled'.
 */
export function deriveStatus(exitCode, killedByUser, timedOut, summary) {
  if (killedByUser || (exitCode === null && !timedOut)) return 'canceled'
  if (exitCode !== 0 || timedOut) return 'failed'
  if (summary.packages.fail.length > 0 || summary.tests.fail > 0) return 'failed'
  return 'passed'
}

/**
 * Human summary of one run, for the model-facing tool output.
 * @param meta - run meta.
 * @returns one line.
 */
export function summarize(meta) {
  const parts = []
  const summary = meta.summary
  if (summary) {
    parts.push(`${summary.packages.ok.length} packages ok`)
    if (summary.packages.fail.length > 0) parts.push(`${summary.packages.fail.length} packages failed`)
    if (summary.packages.noTest.length > 0) parts.push(`${summary.packages.noTest.length} without tests`)
    if (summary.tests.pass + summary.tests.fail + summary.tests.skip > 0) {
      parts.push(`${summary.tests.pass} passed / ${summary.tests.fail} failed / ${summary.tests.skip} skipped`)
    }
    if (summary.buildErrors.length > 0) parts.push(`${summary.buildErrors.length} build errors`)
  }
  const seconds = typeof meta.durationMs === 'number' ? `${(meta.durationMs / 1000).toFixed(1)}s` : 'n/a'
  return `${meta.status} in ${seconds}` + (parts.length > 0 ? ` · ${parts.join(' · ')}` : '')
}
