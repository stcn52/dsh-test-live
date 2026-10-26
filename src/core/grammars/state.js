/**
 * Per-summary bookkeeping the grammars need but the summary shape must not
 * carry: dedupe indexes, an authoritative "the runner told us the totals"
 * record, and the little stacks/cursors a streaming parser needs.
 *
 * It lives behind a Symbol, so JSON.stringify (the state file), the HTTP
 * payload and assert.deepEqual never see it, while one grammar pass can still
 * merge a failure reported twice (once per test line, once in the detail
 * section) into a single entry.
 * @module dsh-test-live/grammars/state
 */

const STATE = Symbol.for('dsh-test-live.parse.state')

/**
 * Fetch (creating on first use) the hidden bookkeeping of one summary.
 * @param summary - summary state.
 * @returns the hidden state object.
 */
export function grammarState(summary) {
  let state = summary[STATE]
  if (state === undefined) {
    state = {
      runnerId: null,
      /** failure name -> index in summary.failures */
      failureIndexes: new Map(),
      /** bucket -> Set of suite names already pushed */
      suiteNames: { ok: new Set(), fail: new Set(), noTest: new Set() },
      /** suite counts a runner printed itself, when they exist */
      suiteTotals: null,
      /** a load/build error header was seen and is waiting for its file name */
      loadErrorPending: false,
      /** key of the failure a following `at file:line` line belongs to */
      pendingFailureKey: null,
      /** open `▶ suite` entries of the node spec reporter */
      suiteStack: [],
      /** node spec: we are inside the `✖ failing tests:` re-listing */
      inFailuresSection: false,
      /** pytest: test name whose traceback we are inside */
      currentTest: null,
      /** pytest: test name -> `file:line` of its assertion */
      whereByTest: new Map(),
    }
    Object.defineProperty(summary, STATE, { value: state, enumerable: false, configurable: true })
  }
  return state
}

/**
 * Which grammar a summary was created with, without creating fresh state.
 * @param summary - summary state.
 * @returns the runner id, or null.
 */
export function storedRunnerId(summary) {
  if (!summary || typeof summary !== 'object') return null
  const state = summary[STATE]
  return state && typeof state.runnerId === 'string' ? state.runnerId : null
}

/**
 * Remember the runner a summary belongs to.
 * @param summary - summary state.
 * @param runnerId - resolved grammar id.
 */
export function setStoredRunnerId(summary, runnerId) {
  grammarState(summary).runnerId = runnerId
}

/**
 * Push a suite name once. Duplicate output (the same package reported twice)
 * is a no-op instead of a double count.
 * @param summary - summary state.
 * @param bucket - 'ok' | 'fail' | 'noTest'.
 * @param name - suite name.
 */
export function pushSuite(summary, bucket, name) {
  if (typeof name !== 'string' || name === '') return
  const state = grammarState(summary)
  const names = state.suiteNames[bucket]
  if (!names || names.has(name)) return
  names.add(name)
  summary.suites[bucket].push(name)
}

/**
 * Move a suite between buckets (pytest discovers a file test by test: the file
 * is ok until one of its cases fails, then it must not stay in `ok`).
 * @param summary - summary state.
 * @param name - suite name.
 * @param bucket - target bucket.
 */
export function markSuite(summary, name, bucket) {
  if (typeof name !== 'string' || name === '') return
  const state = grammarState(summary)
  const current = ['ok', 'fail', 'noTest'].find(other => state.suiteNames[other].has(name))
  if (current === bucket) return
  if (current) {
    state.suiteNames[current].delete(name)
    const list = summary.suites[current]
    const index = list.indexOf(name)
    if (index >= 0) list.splice(index, 1)
  }
  pushSuite(summary, bucket, name)
}

/**
 * Record the suite counts a runner printed itself (`Test Files  1 failed (1)`).
 * @param summary - summary state.
 * @param totals - { ok, fail, noTest } numbers; missing keys keep 0.
 */
export function setSuiteTotals(summary, totals) {
  const state = grammarState(summary)
  state.suiteTotals = state.suiteTotals ?? { ok: 0, fail: 0, noTest: 0 }
  for (const key of ['ok', 'fail', 'noTest']) {
    if (Number.isFinite(totals?.[key])) state.suiteTotals[key] = totals[key]
  }
}

/**
 * Overwrite the test counters with the numbers the runner printed itself. This
 * is what keeps a per-case tally from drifting: the authoritative summary line
 * arrives last and simply wins.
 * @param summary - summary state.
 * @param counts - { pass, fail, skip }; missing keys are left untouched.
 */
export function setTestCounts(summary, counts) {
  for (const key of ['pass', 'fail', 'skip']) {
    if (Number.isFinite(counts?.[key])) summary.tests[key] = counts[key]
  }
}

/**
 * Record one failing test, merging the second sighting (a per-case marker and
 * the detail section both report it) into the same entry.
 * @param summary - summary state.
 * @param name - test name shown to the user.
 * @param where - `file:line` when known.
 * @param key - dedupe key; defaults to the name, pytest uses `file::name`.
 * @returns the entry now holding that key, or null.
 */
export function pushFailure(summary, name, where = null, key = name) {
  if (typeof name !== 'string' || name === '') return null
  const state = grammarState(summary)
  const existing = state.failureIndexes.get(key)
  state.pendingFailureKey = key
  if (existing !== undefined) {
    const entry = summary.failures[existing]
    if (entry && typeof entry === 'object' && where && !entry.where) entry.where = where
    return entry ?? null
  }
  const entry = where ? { name, where } : { name }
  summary.failures.push(entry)
  state.failureIndexes.set(key, summary.failures.length - 1)
  return entry
}

/**
 * Point the following `at file:line` line at an already recorded failure.
 * @param summary - summary state.
 * @param name - test name as the failure section prints it.
 * @returns true when a matching entry was found.
 */
export function focusFailure(summary, name) {
  if (typeof name !== 'string' || name === '') return false
  const state = grammarState(summary)
  for (const key of state.failureIndexes.keys()) {
    if (key === name || key.endsWith(`::${name}`)) {
      state.pendingFailureKey = key
      return true
    }
  }
  return false
}

/**
 * Fill the location of the failure the previous line made current.
 * @param summary - summary state.
 * @param where - `file:line` or `file:line:column`.
 */
export function fillPendingWhere(summary, where) {
  if (typeof where !== 'string' || where === '') return
  const state = grammarState(summary)
  const key = state.pendingFailureKey
  if (key === null) return
  const index = state.failureIndexes.get(key)
  const entry = index === undefined ? null : summary.failures[index]
  if (entry && typeof entry === 'object' && !entry.where) entry.where = where
}

/**
 * Record a build/load error once.
 * @param summary - summary state.
 * @param name - package, file or module that failed to build.
 */
export function pushBuildError(summary, name) {
  if (typeof name !== 'string' || name === '') return
  if (!summary.buildErrors.includes(name)) summary.buildErrors.push(name)
}

/** Pick `N passed/failed/skipped/deselected` pairs out of a summary line. */
export function pickCounts(text) {
  const counts = {}
  const pattern = /(\d+)\s+(passed|failed|skipped|deselected|todo|pending|error|errors)/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const key = match[2]
    counts[key] = (counts[key] ?? 0) + Number(match[1])
  }
  return counts
}
