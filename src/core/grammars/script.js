/**
 * `package.json` script output (`pnpm test` / `npm test`).
 *
 * A script is a black box: it may run `node --test`, vitest, jest, or a shell
 * pipeline of all three. There is no per-case vocabulary we can trust, so this
 * grammar counts only the aggregate lines those tools all print — and it counts
 * nothing at all when none of them appear. Wrong numbers on the panel are worse
 * than no numbers, so a "0 passed" is never invented.
 * @module dsh-test-live/grammars/script
 */

import { pickCounts, pushFailure, setTestCounts } from './state.js'

// `node --test` TAP tail: `# pass 2`, `# fail 1`, `# skipped 0`.
const TAP_COUNT = /^#\s*(pass|fail|skipped)\s+(\d+)\s*$/
// `node --test --test-reporter=spec` tail: `ℹ pass 2`, `ℹ fail 1`, `ℹ skipped 0`.
const SPEC_COUNT = /^ℹ\s*(pass|fail|skipped)\s+(\d+)\s*$/
// vitest: `Tests  1 failed | 2 passed (3)` and `Test Files  1 failed (1)`.
const VITEST_TESTS = /^\s*Tests\s+(.+)$/
// jest: `Tests:       1 failed, 2 passed, 3 total` (and `Test Suites:`).
const JEST_TESTS = /^\s*Tests:\s+(.+)$/
// pytest: `===== 2 passed, 1 skipped in 0.00s =====`.
const PYTEST_SUMMARY = /^=+\s+(.+?)\s+in\s+[\d.]+s\s+=+\s*$/
// cargo: `test result: ok. 3 passed; 0 failed; 0 ignored`.
const CARGO_SUMMARY = /^test result:\s*\w+\.\s*(\d+)\s+passed;\s*(\d+)\s+failed;\s*(\d+)\s+ignored/
// Per-case lines worth colouring (never counted: the aggregate line wins).
const CASE_FAIL = /^(?:not ok\s+\d+\s+-\s+(\S.*)|\s*[✖×●]\s+(\S.*?)(?:\s+\d+(?:\.\d+)?\s*m?s)?\s*$)/
const CASE_PASS = /^(?:ok\s+\d+\s+-\s+(\S.*)|\s*[✔✓]\s+(\S.*?)(?:\s+\d+(?:\.\d+)?\s*m?s)?\s*$)/

/**
 * @param name - `{ passed, failed, skipped }` from pickCounts.
 * @returns the test-counter patch.
 */
function patchFrom(name) {
  const patch = {}
  if (Number.isFinite(name.passed)) patch.pass = name.passed
  if (Number.isFinite(name.failed)) patch.fail = name.failed
  if (Number.isFinite(name.skipped)) patch.skip = name.skipped
  return patch
}

export const script = {
  id: 'script',
  label: 'package.json script',
  // No unit: a script has no notion of "files" we can observe, and summarize()
  // prints no suite clause when units is null.
  units: null,
  labels: { suite: '用例' },

  /**
   * @param text - one output line.
   * @returns the colour kind.
   */
  classify(text) {
    if (
      TAP_COUNT.test(text) ||
      SPEC_COUNT.test(text) ||
      VITEST_TESTS.test(text) ||
      JEST_TESTS.test(text) ||
      PYTEST_SUMMARY.test(text) ||
      CARGO_SUMMARY.test(text) ||
      text === 'PASS' ||
      text === 'FAIL'
    ) {
      return 'result'
    }
    if (text.startsWith('panic:') || text.startsWith('fatal error:') || text.startsWith('Traceback (most recent call last)')) {
      return 'panic'
    }
    if (CASE_FAIL.test(text)) return 'fail'
    if (CASE_PASS.test(text)) return 'pass'
    return 'plain'
  },

  /**
   * Fold one line into the summary. Aggregate lines overwrite the counters;
   * per-case lines only record which test failed.
   * @param summary - summary state.
   * @param text - one output line.
   */
  observe(summary, text) {
    let match
    if ((match = TAP_COUNT.exec(text)) ?? (match = SPEC_COUNT.exec(text))) {
      const value = Number(match[2])
      setTestCounts(summary, { [match[1] === 'pass' ? 'pass' : match[1] === 'fail' ? 'fail' : 'skip']: value })
      return
    }
    if ((match = CARGO_SUMMARY.exec(text))) {
      setTestCounts(summary, { pass: Number(match[1]), fail: Number(match[2]), skip: Number(match[3]) })
      return
    }
    const sentence =
      (match = PYTEST_SUMMARY.exec(text))?.[1] ??
      (match = VITEST_TESTS.exec(text))?.[1] ??
      (match = JEST_TESTS.exec(text))?.[1]
    if (sentence !== undefined) {
      const patch = patchFrom(pickCounts(sentence))
      if (Object.keys(patch).length > 0) setTestCounts(summary, patch)
      return
    }
    const failed = CASE_FAIL.exec(text)
    if (failed !== null) {
      const name = (failed[1] ?? failed[2] ?? '').trim()
      if (name !== '') pushFailure(summary, name)
    }
  },
}
