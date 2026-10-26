/**
 * jest output.
 *
 * Like vitest, the authoritative totals are the `Test Suites:` / `Tests:`
 * summary lines; the per-case `✓`/`✕` marks are counted while streaming and
 * then overwritten. The failure list is keyed by test name so `● suite › test`
 * and the `✕ test (3 ms)` line collapse into one entry, with the location taken
 * from the first `at … (file:line:col)` line that follows.
 * @module dsh-test-live/grammars/jest
 */

import { fillPendingWhere, pickCounts, pushFailure, pushSuite, setSuiteTotals, setTestCounts } from './state.js'

const FILE_OK = /^PASS\s+(\S+)\s*$/
const FILE_FAIL = /^FAIL\s+(\S+)\s*$/
const SUITES_SUMMARY = /^Test Suites:\s*(.+?)\s*$/
const TESTS_SUMMARY = /^Tests:\s*(.+?)\s*$/
const FAILURE_TITLE = /^\s*\u25cf\s+(.+?)\s*$/
const AT_LINE = /^\s*at\s+.+?\((\S+):(\d+):(\d+)\)\s*$/
const CASE_PASS = /^\s*[\u2713\u2714]\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*ms\))?\s*$/
const CASE_FAIL = /^\s*[\u2715\u2716\u00d7\u2717]\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*ms\))?\s*$/
const META_LINE = /^(?:Time|Snapshots):\s|^Ran all test suites/

export const jest = {
  id: 'jest',
  label: 'Jest',
  units: { one: 'suite', many: 'suites' },
  labels: { suite: '文件' },

  /**
   * @param text - one output line.
   * @returns line kind.
   */
  classify(text) {
    if (SUITES_SUMMARY.test(text) || TESTS_SUMMARY.test(text) || META_LINE.test(text)) return 'result'
    if (FILE_OK.test(text)) return 'suite'
    if (FILE_FAIL.test(text)) return 'fail'
    if (AT_LINE.test(text)) return 'plain'
    if (FAILURE_TITLE.test(text)) return 'fail'
    if (CASE_PASS.test(text)) return 'pass'
    if (CASE_FAIL.test(text)) return 'fail'
    return 'plain'
  },

  /**
   * @param summary - summary state (mutated).
   * @param text - one output line.
   */
  observe(summary, text) {
    let match
    if ((match = SUITES_SUMMARY.exec(text))) {
      const counts = pickCounts(match[1])
      setSuiteTotals(summary, { ok: counts.passed ?? 0, fail: counts.failed ?? 0 })
      return
    }
    if ((match = TESTS_SUMMARY.exec(text))) {
      const counts = pickCounts(match[1])
      setTestCounts(summary, { pass: counts.passed ?? 0, fail: counts.failed ?? 0, skip: counts.skipped ?? 0 })
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
    if ((match = AT_LINE.exec(text))) {
      fillPendingWhere(summary, `${match[1]}:${match[2]}`)
      return
    }
    if ((match = FAILURE_TITLE.exec(text))) {
      // `● calc add › fails on purpose` — the test name is the last segment.
      const segments = match[1].split('\u203a').map(part => part.trim()).filter(Boolean)
      pushFailure(summary, segments.at(-1) ?? match[1])
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
