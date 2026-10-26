/**
 * `node --test`, in both shapes it prints:
 *
 *   - **spec** (`--test-reporter=spec`, the runner descriptor's default):
 *     `✔ name (1.0ms)` / `✖ name (1.0ms)` and `ℹ tests 3` / `ℹ pass 2` / …
 *     A suite is opened by `▶ name` and closed by a line with the same name at
 *     the same indentation — which is why the parser keeps a suite stack: a
 *     flush-left `✔ calc (2.5ms)` is a *suite* closing, while a flush-left
 *     `✔ adds two numbers (1.0ms)` in a run without describes is a *test*.
 *   - **TAP** (when no reporter is configured, or an older node): `ok 1 - name`
 *     / `not ok 1 - name` / `1..3` / `# tests 3`. None of those `#` lines is a
 *     build error — they are the runner's own bookkeeping — and `ok 1 - name` is
 *     a test, not a package.
 *
 * The authoritative counters are whichever summary block the shape printed, so
 * a per-test tally can never drift from what node itself counted.
 * @module dsh-test-live/grammars/node-test
 */

import {
  fillPendingWhere,
  grammarState,
  pushBuildError,
  pushFailure,
  pushSuite,
  setTestCounts,
} from './state.js'

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/

const TAP_VERSION = /^TAP version \d+$/
const TAP_SUBTEST = /^# Subtest:\s+(.+?)\s*$/
const TAP_OK = /^ok\s+(\d+)\s+-\s+(.+?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/i
const TAP_NOT_OK = /^not ok\s+(\d+)\s+-\s+(.+?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/i
const TAP_PLAN = /^1\.\.(\d+)$/
const TAP_SUMMARY = /^#\s+(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)$/
const TAP_DURATION = /^#\s+duration_ms\s/
const TAP_LOCATION = /^\s+location:\s+'(.*):(\d+):(\d+)'\s*$/
const TAP_ERROR_HEADER = /^#\s+(?:SyntaxError|TypeError|RangeError|ReferenceError|EvalError|URIError|Error)(?:\s|:|\[)/

const SPEC_SUITE = /^(\s*)\u25b6\s+(.+?)\s*$/
const SPEC_ENTRY = /^(\s*)[\u2714\u2716]\s+(.+?)(?:\s+\((\d+(?:\.\d+)?)\s*ms\))?\s*$/
const SPEC_FAILED_HEADER = /^\u2716\s+failing tests:\s*$/
const SPEC_AT = /^test at (\S+):(\d+):(\d+)$/
const SPEC_SUMMARY = /^\u2139\s+(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)$/
const SPEC_DURATION = /^\u2139\s+duration_ms\s/
const SPEC_ERROR_HEADER = /^(?:SyntaxError|TypeError|RangeError|ReferenceError|EvalError|URIError|Error)(?:\s|:|\[)/

/** Hand a file-level failure (the file itself did not load) to buildErrors. */
function attributeLoadError(summary, name) {
  const state = grammarState(summary)
  if (!state.loadErrorPending) return
  if (!TEST_FILE.test(name)) return
  pushBuildError(summary, name)
  state.loadErrorPending = false
}

export const nodeTest = {
  id: 'nodeTest',
  label: 'node --test',
  units: { one: 'test file', many: 'test files' },
  labels: { suite: '用例' },

  /**
   * @param text - one output line.
   * @returns line kind.
   */
  classify(text) {
    if (SPEC_FAILED_HEADER.test(text)) return 'result'
    if (SPEC_SUMMARY.test(text) || SPEC_DURATION.test(text) || TAP_SUMMARY.test(text) || TAP_DURATION.test(text)) return 'result'
    if (SPEC_AT.test(text)) return 'plain'
    if (SPEC_SUITE.test(text)) return 'suite'
    if (TAP_VERSION.test(text) || TAP_PLAN.test(text)) return 'result'
    if (TAP_SUBTEST.test(text)) return 'test'
    if (TAP_ERROR_HEADER.test(text) || SPEC_ERROR_HEADER.test(text)) return 'error'
    if (SPEC_ENTRY.test(text)) return text.includes('\u2716') ? 'fail' : 'pass'
    const tapOk = TAP_OK.exec(text)
    if (tapOk) return tapOk[3] ? 'skip' : 'pass'
    if (TAP_NOT_OK.test(text)) return 'fail'
    return 'plain'
  },

  /**
   * @param summary - summary state (mutated).
   * @param text - one output line.
   */
  observe(summary, text) {
    const state = grammarState(summary)
    let match
    if (SPEC_FAILED_HEADER.test(text)) {
      // Everything below this header re-lists failures already counted above.
      state.inFailuresSection = true
      return
    }
    if ((match = TAP_LOCATION.exec(text))) {
      fillPendingWhere(summary, `${match[1]}:${match[2]}`)
      return
    }
    if ((match = SPEC_AT.exec(text))) {
      fillPendingWhere(summary, `${match[1]}:${match[2]}`)
      return
    }
    if ((match = SPEC_SUMMARY.exec(text))) {
      applyCounter(summary, match[1], Number(match[2]))
      return
    }
    if ((match = SPEC_SUITE.exec(text))) {
      state.suiteStack.push({ name: match[2], depth: match[1].length })
      return
    }
    if ((match = SPEC_ENTRY.exec(text))) {
      const depth = match[1].length
      const name = match[2]
      const failed = text.includes('\u2716')
      const top = state.suiteStack.at(-1)
      if (top !== undefined && top.name === name && top.depth === depth) {
        state.suiteStack.pop()
        pushSuite(summary, failed ? 'fail' : 'ok', name)
        return
      }
      if (state.inFailuresSection) return
      if (failed) {
        summary.tests.fail++
        pushFailure(summary, name)
        attributeLoadError(summary, name)
      } else {
        summary.tests.pass++
      }
      return
    }
    if (TAP_ERROR_HEADER.test(text) || SPEC_ERROR_HEADER.test(text)) {
      // node prints the load/syntax diagnostic *before* the file it belongs to;
      // the next file-level failing entry takes the blame.
      state.loadErrorPending = true
      return
    }
    if ((match = TAP_SUMMARY.exec(text))) {
      applyCounter(summary, match[1], Number(match[2]))
      return
    }
    if ((match = TAP_NOT_OK.exec(text))) {
      const name = match[2]
      if (match[3]) {
        summary.tests.skip++
        return
      }
      summary.tests.fail++
      pushFailure(summary, name)
      attributeLoadError(summary, name)
      return
    }
    if ((match = TAP_OK.exec(text))) {
      if (match[3]) summary.tests.skip++
      else summary.tests.pass++
      return
    }
    // Everything else (`# Subtest:`, `1..3`, `# duration_ms`, diagnostics) is
    // bookkeeping: no counters, and above all no build error.
  },
}

/** Fold one `# pass 2` / `ℹ pass 2` counter in as an absolute value. */
function applyCounter(summary, key, value) {
  if (key === 'pass') setTestCounts(summary, { pass: value })
  else if (key === 'fail') setTestCounts(summary, { fail: value })
  else if (key === 'skipped' || key === 'todo') setTestCounts(summary, { skip: value })
  // `tests` is the total including skipped ones and `suites` counts describes;
  // neither is a counter of its own, so they are deliberately ignored here.
}
