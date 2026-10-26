/**
 * `go test` output. This is the grammar the panel shipped with, kept byte for
 * byte: with no runner id the parser must still behave exactly like 0.2.0, and
 * `tests/core.test.js` pins every marker below.
 * @module dsh-test-live/grammars/go
 */

const RUN_LINE = /^=== (?:RUN|PAUSE|CONT)\s+(.+)$/
const PASS_LINE = /^--- PASS:\s+(\S+)/
const FAIL_LINE = /^--- FAIL:\s+(\S+)/
const SKIP_LINE = /^--- SKIP:\s+(\S+)/
const PACKAGE_OK = /^ok\s+(\S+)\s+/
const PACKAGE_FAIL = /^FAIL\s+(\S+)\s+/
const PACKAGE_EMPTY = /^\?\s+(\S+)\s+\[no test files\]/
const BUILD_ERROR = /^#\s+(\S+)/

export const go = {
  id: 'go',
  label: 'Go test',
  // `packages` for both numbers keeps the 0.2.0 sentence "2 packages ok" verbatim.
  units: { one: 'packages', many: 'packages' },
  labels: { suite: '包' },

  /**
   * @param text - one output line.
   * @returns line kind.
   */
  classify(text) {
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
  },

  /**
   * @param summary - summary state (mutated).
   * @param text - one output line.
   */
  observe(summary, text) {
    let match
    if ((match = PASS_LINE.exec(text))) {
      summary.tests.pass++
      return
    }
    if ((match = FAIL_LINE.exec(text))) {
      summary.tests.fail++
      // Bare strings are the 0.2.0 shape of this array; other grammars push
      // {name, where}. failureName()/failureWhere() paper over the difference.
      summary.failures.push(match[1])
      return
    }
    if ((match = SKIP_LINE.exec(text))) {
      summary.tests.skip++
      return
    }
    if ((match = PACKAGE_OK.exec(text))) {
      summary.suites.ok.push(match[1])
      return
    }
    if ((match = PACKAGE_FAIL.exec(text))) {
      summary.suites.fail.push(match[1])
      return
    }
    if ((match = PACKAGE_EMPTY.exec(text))) {
      summary.suites.noTest.push(match[1])
      return
    }
    if ((match = BUILD_ERROR.exec(text))) {
      if (!summary.buildErrors.includes(match[1])) summary.buildErrors.push(match[1])
      return
    }
    if (text.startsWith('coverage: ')) summary.coverage.push(text.slice('coverage: '.length))
  },
}
