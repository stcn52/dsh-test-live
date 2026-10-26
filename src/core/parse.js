/**
 * One pass over the child's output: classify each line for the panel and fold
 * the result markers of the selected runner into a summary.
 *
 * The classification is deliberately textual (not `-json`): the panel streams
 * raw lines, and a JSON stream would make the log unreadable for a human while
 * adding a second encoding to keep in sync. The per-runner regular expressions
 * live in `grammars/`; this module is only the dispatching surface, and with no
 * runner id it behaves exactly like the Go-only 0.2.0 parser.
 * @module dsh-test-live/parse
 */

import { GRAMMARS, getGrammar, grammarLabels } from './grammars/index.js'
import { grammarState, setStoredRunnerId, storedRunnerId } from './grammars/state.js'

export { GRAMMARS, getGrammar, grammarLabels }

/** Line kinds the panel knows how to colour. */
export const LINE_KINDS = Object.freeze([
  // Runner-neutral kinds every grammar may emit.
  'plain',
  'run',
  'suite',
  'test',
  'pass',
  'fail',
  'skip',
  'error',
  'result',
  'panic',
  // Go kinds kept in the graph so existing stylesheets and stored history
  // keep rendering after the rename.
  'package-ok',
  'package-fail',
  'package-empty',
  'build',
])

/** Runner id used when a caller passes none: the 0.2.0 Go behaviour. */
export const DEFAULT_RUNNER_ID = 'go'

const BUCKETS = ['ok', 'fail', 'noTest']

function grammarFor(summary, runnerId) {
  if (typeof runnerId === 'string' && runnerId !== '') return getGrammar(runnerId)
  const stored = storedRunnerId(summary)
  return getGrammar(stored ?? DEFAULT_RUNNER_ID)
}

/** The suite buckets of a summary, accepting pre-rename records. */
function suiteBuckets(summary) {
  if (!summary || typeof summary !== 'object') return { ok: [], fail: [], noTest: [] }
  if (summary.suites && typeof summary.suites === 'object') {
    return {
      ok: Array.isArray(summary.suites.ok) ? summary.suites.ok : [],
      fail: Array.isArray(summary.suites.fail) ? summary.suites.fail : [],
      noTest: Array.isArray(summary.suites.noTest) ? summary.suites.noTest : [],
    }
  }
  if (summary.packages && typeof summary.packages === 'object') {
    return {
      ok: Array.isArray(summary.packages.ok) ? summary.packages.ok : [],
      fail: Array.isArray(summary.packages.fail) ? summary.packages.fail : [],
      noTest: Array.isArray(summary.packages.noTest) ? summary.packages.noTest : [],
    }
  }
  return { ok: [], fail: [], noTest: [] }
}

/**
 * Build the empty summary of one run.
 * @param runnerId - runner id; omitted means Go.
 * @returns summary state.
 */
export function createSummary(runnerId) {
  const grammar = getGrammar(runnerId === undefined ? DEFAULT_RUNNER_ID : runnerId)
  const summary = {
    suites: { ok: [], fail: [], noTest: [] },
    tests: { pass: 0, fail: 0, skip: 0 },
    failures: [],
    buildErrors: [],
    coverage: [],
  }
  // Pre-rename readers (and the 0.2.0 tests) still say summary.packages.
  // Non-enumerable, so the state file and the HTTP payload only carry `suites`.
  Object.defineProperty(summary, 'packages', {
    get() {
      return this.suites
    },
    enumerable: false,
    configurable: true,
  })
  setStoredRunnerId(summary, grammar.id)
  return summary
}

/**
 * Bring a persisted summary (possibly written before the rename) up to shape.
 * `packages` -> `suites`, missing fields filled, hidden indexes rebuilt so
 * further observeLine calls still merge into the right entries.
 * @param summary - a summary read from the state file; null is tolerated.
 * @param runnerId - runner id of that record, when known.
 * @returns a fresh summary object.
 */
export function migrateSummary(summary, runnerId) {
  const out = createSummary(runnerId)
  if (!summary || typeof summary !== 'object') return out
  const source = suiteBuckets(summary)
  for (const bucket of BUCKETS) {
    out.suites[bucket] = source[bucket].filter(name => typeof name === 'string')
  }
  if (summary.tests && typeof summary.tests === 'object') {
    for (const key of ['pass', 'fail', 'skip']) {
      if (Number.isFinite(summary.tests[key])) out.tests[key] = summary.tests[key]
    }
  }
  if (Array.isArray(summary.failures)) out.failures = summary.failures.slice()
  if (Array.isArray(summary.buildErrors)) out.buildErrors = summary.buildErrors.filter(item => typeof item === 'string')
  if (Array.isArray(summary.coverage)) out.coverage = summary.coverage.filter(item => typeof item === 'string')
  const state = grammarState(out)
  out.failures.forEach((entry, index) => state.failureIndexes.set(failureName(entry), index))
  for (const bucket of BUCKETS) for (const name of out.suites[bucket]) state.suiteNames[bucket].add(name)
  return out
}

/**
 * The name of one failure entry, whether it is the legacy bare string or the
 * `{name, where}` object the newer grammars push.
 * @param entry - failure entry.
 * @returns the test name, or ''.
 */
export function failureName(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object' && typeof entry.name === 'string') return entry.name
  return ''
}

/**
 * The location of one failure entry, when the grammar managed to find it.
 * @param entry - failure entry.
 * @returns `file:line` or ''.
 */
export function failureWhere(entry) {
  if (entry && typeof entry === 'object' && typeof entry.where === 'string') return entry.where
  return ''
}

/**
 * Counters of one summary, for the tool output and the panel chips.
 *
 * Suite counts prefer what the runner printed itself (`Test Files 1 failed (1)`)
 * over the length of the name lists: a reporter that does not name every file
 * must not look like it ran fewer of them.
 * @param summary - summary state.
 * @returns { suites, tests, failures, buildErrors }.
 */
export function summaryCounts(summary) {
  const buckets = suiteBuckets(summary)
  const totals = summary && typeof summary === 'object' ? grammarState(summary).suiteTotals : null
  const ok = Math.max(buckets.ok.length, totals?.ok ?? 0)
  const fail = Math.max(buckets.fail.length, totals?.fail ?? 0)
  const noTest = Math.max(buckets.noTest.length, totals?.noTest ?? 0)
  const tests = summary && typeof summary === 'object' && summary.tests ? summary.tests : { pass: 0, fail: 0, skip: 0 }
  return {
    suites: { ok, fail, noTest, total: ok + fail },
    tests: { pass: tests.pass ?? 0, fail: tests.fail ?? 0, skip: tests.skip ?? 0 },
    failures: summary && typeof summary === 'object' && Array.isArray(summary.failures) ? summary.failures.length : 0,
    buildErrors:
      summary && typeof summary === 'object' && Array.isArray(summary.buildErrors) ? summary.buildErrors.length : 0,
  }
}

/**
 * @param text - one output line (no trailing newline).
 * @param runnerId - runner id; omitted means Go.
 * @returns the line kind used for colouring.
 */
export function classifyLine(text, runnerId) {
  return getGrammar(runnerId === undefined ? DEFAULT_RUNNER_ID : runnerId).classify(text)
}

/**
 * Fold one line into the summary.
 * @param summary - summary state (mutated).
 * @param text - one output line.
 * @param runnerId - runner id; omitted falls back to the id the summary was
 *   created with, and to Go for a foreign summary.
 */
export function observeLine(summary, text, runnerId) {
  if (!summary || typeof summary !== 'object') return
  grammarFor(summary, runnerId).observe(summary, text)
}

/**
 * Derive the final status from the process result and the observed markers.
 * @param exitCode - process exit code (null when killed by a signal).
 * @param killedByUser - true when cancel() stopped it.
 * @param timedOut - true when the wall-clock cap fired.
 * @param summary - observed summary.
 * @param runnerId - runner id, accepted for symmetry; the rule is the same for
 *   every runner because the exit code always has the final word.
 * @returns 'passed' | 'failed' | 'canceled'.
 */
export function deriveStatus(exitCode, killedByUser, timedOut, summary, runnerId) {
  void runnerId
  if (killedByUser || (exitCode === null && !timedOut)) return 'canceled'
  if (exitCode !== 0 || timedOut) return 'failed'
  // suiteTotals counts a failed file even when the reporter never named it,
  // so this reads the counters rather than the name lists.
  const counts = summaryCounts(summary)
  if (counts.suites.fail > 0 || counts.tests.fail > 0) return 'failed'
  return 'passed'
}

/**
 * Human summary of one run, for the model-facing tool output.
 *
 * The noun comes from the grammar (packages / files / suites / test files), so
 * the sentence keeps saying what the runner actually ran. Go keeps `packages`
 * for both numbers to stay byte-identical to 0.2.0.
 * @param meta - run meta.
 * @param runnerId - runner id; defaults to meta.runner, then Go.
 * @returns one line.
 */
export function summarize(meta, runnerId) {
  const id = runnerId ?? meta?.runner ?? DEFAULT_RUNNER_ID
  const grammar = getGrammar(id)
  const parts = []
  const summary = meta?.summary
  if (summary) {
    const counts = summaryCounts(summary)
    // A runner that only reports test names (node --test with the spec reporter)
    // has no suite rows at all: saying "0 files ok" there would be noise, and the
    // tool text is read by a model that has no way to tell noise from a finding.
    if (grammar.units && counts.suites.total > 0) {
      const noun = counts.suites.total === 1 ? grammar.units.one : grammar.units.many
      parts.push(`${counts.suites.ok} ${noun} ok`)
      if (counts.suites.fail > 0) parts.push(`${counts.suites.fail} ${noun} failed`)
      if (counts.suites.noTest > 0) parts.push(`${counts.suites.noTest} without tests`)
    }
    const { pass, fail, skip } = counts.tests
    if (pass + fail + skip > 0) parts.push(`${pass} passed / ${fail} failed / ${skip} skipped`)
    if (counts.buildErrors > 0) parts.push(`${counts.buildErrors} build errors`)
  }
  const seconds = typeof meta?.durationMs === 'number' ? `${(meta.durationMs / 1000).toFixed(1)}s` : 'n/a'
  return `${meta?.status} in ${seconds}` + (parts.length > 0 ? ` · ${parts.join(' · ')}` : '')
}
