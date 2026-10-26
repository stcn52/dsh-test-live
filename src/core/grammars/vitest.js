/**
 * vitest output (`--reporter=verbose`, the runner descriptor's default).
 *
 * Two things make this grammar non-obvious, both visible in
 * `tests/fixtures/vitest/`:
 *   - the authoritative totals are the ` Test Files` / ` Tests` summary lines,
 *     which keep their own counts; the `✓`/`×` lines are counted while
 *     streaming and then overwritten by the summary, so nothing doubles;
 *   - a failed *file* line (`❯ tests/fail.test.js (2 tests | 1 failed)`) and the
 *     failing test detail (`FAIL  file > suite > test`) both describe the same
 *     failure, so the failure list is keyed by test name.
 * @module dsh-test-live/grammars/vitest
 */

import { fillPendingWhere, pickCounts, pushFailure, pushSuite, setSuiteTotals, setTestCounts } from './state.js'

const TEST_FILE = String.raw`\S+\.(?:test|spec)\.[cm]?[jt]sx?`
const RUN_HEADER = /^\s*RUN\s+v\d/
const LOC_LINE = /^\s*\u276f\s+(\S+):(\d+):(\d+)\s*$/
const FILE_OK = new RegExp(String.raw`^\s*[\u2713\u2714]\s+(${TEST_FILE})(.*)$`)
const FILE_FAIL = new RegExp(String.raw`^\s*[\u276f\u00d7\u2717]\s+(${TEST_FILE})(.*)$`)
const GROUP_HEADER = /^\s*[\u276f\u2713\u2714\u00d7]\s+(.+?)\s+\((\d+)\)\s*$/
const CASE_PASS = /^\s*[\u2713\u2714]\s+(.+?)\s+\d+(?:\.\d+)?(?:ms|s)\s*$/
const CASE_FAIL = /^\s*[\u00d7\u2717\u2715]\s+(.+?)\s+\d+(?:\.\d+)?(?:ms|s)\s*$/
const CASE_SKIP = /^\s*\u2193\s+(.+?)(?:\s+\d+(?:\.\d+)?(?:ms|s))?\s*$/
const FAIL_DETAIL = new RegExp(String.raw`^\s*FAIL\s+(${TEST_FILE})\s*>\s*(.+?)\s*$`)
const TEST_FILES_SUMMARY = /^\s*Test Files\s+(.+?)\s*$/
const TESTS_SUMMARY = /^\s*Tests\s+(.+?)\s*$/
const DURATION_LINE = /^\s*(?:Start at|Duration)\s+\d/
const ASSERTION_LINE = /^\s*(?:AssertionError|TypeError|RangeError|ReferenceError|EvalError)\b/

export const vitest = {
  id: 'vitest',
  label: 'Vitest',
  units: { one: 'file', many: 'files' },
  labels: { suite: '文件' },

  /**
   * @param text - one output line.
   * @returns line kind.
   */
  classify(text) {
    if (RUN_HEADER.test(text)) return 'run'
    if (TEST_FILES_SUMMARY.test(text) || TESTS_SUMMARY.test(text) || DURATION_LINE.test(text)) return 'result'
    if (LOC_LINE.test(text)) return 'plain'
    if (FILE_OK.test(text)) return 'suite'
    if (FILE_FAIL.test(text)) return 'fail'
    if (FAIL_DETAIL.test(text)) return 'fail'
    if (GROUP_HEADER.test(text)) return 'suite'
    if (CASE_PASS.test(text)) return 'pass'
    if (CASE_FAIL.test(text)) return 'fail'
    if (CASE_SKIP.test(text)) return 'skip'
    if (ASSERTION_LINE.test(text)) return 'error'
    return 'plain'
  },

  /**
   * @param summary - summary state (mutated).
   * @param text - one output line.
   */
  observe(summary, text) {
    let match
    // The `❯ file:line:col` line must be read before the `❯ file` line shape.
    if ((match = LOC_LINE.exec(text))) {
      fillPendingWhere(summary, `${match[1]}:${match[2]}`)
      return
    }
    if ((match = FILE_OK.exec(text))) {
      pushSuite(summary, 'ok', match[1])
      return
    }
    if ((match = FILE_FAIL.exec(text))) {
      pushSuite(summary, 'fail', match[1])
      return
    }
    if ((match = FAIL_DETAIL.exec(text))) {
      const segments = match[2].split('>').map(part => part.trim()).filter(Boolean)
      // The `❯ file:line:col` line right below carries the precise location.
      pushFailure(summary, segments.at(-1) ?? match[2].trim(), null)
      return
    }
    if ((match = TEST_FILES_SUMMARY.exec(text))) {
      const counts = pickCounts(match[1])
      setSuiteTotals(summary, { ok: counts.passed ?? 0, fail: counts.failed ?? 0 })
      return
    }
    if ((match = TESTS_SUMMARY.exec(text))) {
      const counts = pickCounts(match[1])
      setTestCounts(summary, { pass: counts.passed ?? 0, fail: counts.failed ?? 0, skip: counts.skipped ?? 0 })
      return
    }
    if (GROUP_HEADER.test(text)) return
    if ((match = CASE_SKIP.exec(text))) {
      summary.tests.skip++
      return
    }
    if ((match = CASE_PASS.exec(text))) {
      summary.tests.pass++
      return
    }
    if ((match = CASE_FAIL.exec(text))) {
      summary.tests.fail++
      pushFailure(summary, match[1])
    }
  },
}
