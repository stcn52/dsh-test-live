/**
 * Fallback grammar. Unknown ids (`generic`, `script`, `cargo`, a typo) are
 * deliberately dumb: they colour a line and never invent a suite or a test.
 * A wrong number on the panel is worse than no number, and a generic run has
 * no vocabulary we could honestly count.
 * @module dsh-test-live/grammars/generic
 */

export const generic = {
  id: 'generic',
  label: 'Unknown runner',
  // No unit means summarize() prints no suite clause at all.
  units: null,
  labels: { suite: '用例' },

  /**
   * @param text - one output line.
   * @returns 'result' | 'panic' | 'plain' only.
   */
  classify(text) {
    // `PASS`/`FAIL` are the only totals-shaped words every test tool shares.
    if (text === 'PASS' || text === 'FAIL') return 'result'
    if (text.startsWith('panic:') || text.startsWith('fatal error:')) return 'panic'
    return 'plain'
  },

  /**
   * Intentionally empty: no counters for a runner we cannot read.
   */
  observe() {},
}
