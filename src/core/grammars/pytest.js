/**
 * pytest output (the `-v` form the runner descriptor defaults to).
 *
 * pytest prints one line per test and never a per-file line, so a suite is
 * discovered from the node ids: the file starts in `ok` and *moves* to `fail`
 * the moment one of its cases fails. Collection errors (`ERROR file.py`, the
 * `1 error in …` tail) are build errors — nothing ran, and calling that "0
 * passed" would hide the reason.
 * @module dsh-test-live/grammars/pytest
 */

import {
  fillPendingWhere,
  focusFailure,
  grammarState,
  markSuite,
  pickCounts,
  pushBuildError,
  pushFailure,
  setTestCounts,
} from './state.js'

const CASE = /^(\S+?\.py)::(\S+?)\s+(PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS)(?:\s*\((.*?)\))?\s*(?:\[\s*\d+%\]\s*)?$/
const FAILED_SHORT = /^FAILED\s+(\S+)(?:\s+-\s+.*)?$/
const ERROR_SHORT = /^ERROR\s+(\S+?\.py)(?:\s+-\s+.*)?$/
const SECTION = /^=+\s+(.+?)\s+=+$/
const SUMMARY = /^=+\s+(.+?)\s+in\s+[\d.]+s\s+=+$/
const COLLECTED = /^collecting \.\.\. collected (\d+) items?(?:\s*\/\s*(\d+) errors?)?/
const FAILURE_HEADER = /^_+\s+(\S+)\s+_+$/
const ERROR_SECTION = /^_+\s+ERROR\b/
const TRACEBACK_LOCATION = /^(\S+?\.py):(\d+):\s*\S/
const ASSERTION_DETAIL = /^E\s\s+\S/

export const pytest = {
  id: 'pytest',
  label: 'pytest',
  units: { one: 'test file', many: 'test files' },
  labels: { suite: '用例' },

  /**
   * @param text - one output line.
   * @returns line kind.
   */
  classify(text) {
    if (SUMMARY.test(text) || SECTION.test(text) || COLLECTED.test(text)) return 'result'
    if (ERROR_SECTION.test(text)) return 'error'
    if (FAILED_SHORT.test(text)) return 'fail'
    if (ERROR_SHORT.test(text)) return 'error'
    const match = CASE.exec(text)
    if (match) {
      if (match[3] === 'FAILED') return 'fail'
      if (match[3] === 'SKIPPED' || match[3] === 'XFAIL') return 'skip'
      if (match[3] === 'ERROR') return 'error'
      return 'pass'
    }
    if (ASSERTION_DETAIL.test(text)) return 'error'
    return 'plain'
  },

  /**
   * @param summary - summary state (mutated).
   * @param text - one output line.
   */
  observe(summary, text) {
    const state = grammarState(summary)
    let match
    if ((match = SUMMARY.exec(text))) {
      const counts = pickCounts(match[1])
      setTestCounts(summary, { pass: counts.passed ?? 0, fail: counts.failed ?? 0, skip: counts.skipped ?? 0 })
      return
    }
    if ((match = CASE.exec(text))) {
      const [file, test] = [match[1], match[2]]
      switch (match[3]) {
        case 'PASSED':
        case 'XPASS':
          summary.tests.pass++
          markSuite(summary, file, 'ok')
          return
        case 'SKIPPED':
        case 'XFAIL':
          summary.tests.skip++
          markSuite(summary, file, 'ok')
          return
        case 'FAILED':
          summary.tests.fail++
          markSuite(summary, file, 'fail')
          // The location arrives later, in the traceback; leave `where` empty so
          // fillPendingWhere can set the precise `file:line`.
          pushFailure(summary, test, null, `${file}::${test}`)
          return
        case 'ERROR':
          markSuite(summary, file, 'fail')
          pushBuildError(summary, file)
          return
        default:
          return
      }
    }
    if ((match = FAILED_SHORT.exec(text))) {
      const nodeid = match[1]
      const split = nodeid.lastIndexOf('::')
      const file = split > 0 ? nodeid.slice(0, split) : ''
      const test = split > 0 ? nodeid.slice(split + 2) : nodeid
      pushFailure(summary, test, state.whereByTest.get(test) ?? file, `${file}::${test}`)
      if (file !== '') markSuite(summary, file, 'fail')
      return
    }
    if ((match = ERROR_SHORT.exec(text))) {
      pushBuildError(summary, match[1])
      return
    }
    if ((match = FAILURE_HEADER.exec(text))) {
      state.currentTest = match[1]
      focusFailure(summary, match[1])
      return
    }
    if ((match = TRACEBACK_LOCATION.exec(text))) {
      const where = `${match[1]}:${match[2]}`
      if (state.currentTest !== null) state.whereByTest.set(state.currentTest, where)
      fillPendingWhere(summary, where)
    }
  },
}
