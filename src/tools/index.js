/**
 * Four tools over the same run registry the panel uses.
 *
 * They exist so the model can start a run and read the result without a second
 * log channel: everything the tool reports is also what the panel shows live.
 * A run started from a tool belongs to the conversation the call came from, so
 * the panel groups it with that conversation and spawns it in its cwd.
 * @module dsh-test-live/tools
 */

import { dirname, isAbsolute, resolve } from 'node:path'

import { detectRunner, RUNNERS } from '../core/runners.js'
import { AUTO_RUNNER, checkRunRequest, selectFollowRoot } from '../host/routes.js'

/** How many trailing lines a tool output carries by default. */
const DEFAULT_TAIL = 120
/** Default budget for a caller that explicitly asked to wait. */
const DEFAULT_WAIT_SEC = 60
/** Ceiling for `waitSec`: a tool call may not pin the host for longer. */
const MAX_WAIT_SEC = 300
/** How long a canceled call waits for the kill to be observed. */
const SETTLE_MS = 5000
/** Rows `test_live_runs` lists when the caller names no limit. */
const DEFAULT_LIST_LIMIT = 10
/** Cap on `test_live_runs` rows, so one call cannot dump the whole history. */
const MAX_LIST_LIMIT = 100
/** Cap on the trailing lines `test_live_runs` may append in total. */
const MAX_LIST_TAIL_LINES = 200

/**
 * How each runner's own documentation spells "run the tests and write the log".
 *
 * The follow hint used to be hard-coded to `go test ./...`, which was wrong on
 * every project that is not a Go module; the id here is the resolved runner, so
 * the hint matches the grammar the panel will parse the file with.
 */
const WRITE_WITH = {
  go: 'go test ./...',
  pytest: 'pytest -v',
  vitest: 'pnpm exec vitest run',
  jest: 'pnpm exec jest --verbose',
  nodeTest: 'node --test',
}


/**
 * @param value - any value.
 * @returns the trimmed string, or null when it carries nothing.
 */
function textOf(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * The `runner:` line of a report.
 *
 * A run records the runner that resolved from `auto`, so the model never has to
 * guess which grammar produced the counters it is reading. A run restored from
 * history written before runners existed honestly says so instead of pretending
 * it ran the Go pipeline.
 * @param meta - run meta.
 * @returns the report line.
 */
function runnerLine(meta) {
  const id = textOf(meta?.runner)
  if (id === null) {
    // A run can legitimately have no runner (a followed file executes nothing,
    // and an older stored run predates the field). Say so and, when the host
    // knows why, say why — "not recorded" alone reads like a defect.
    const reason = textOf(meta?.detectReason)
    return reason === null ? 'runner: not recorded' : `runner: not recorded (${reason})`
  }
  const label = textOf(meta.runnerLabel)
  return label === null || label === id ? `runner: ${id}` : `runner: ${id} (${label})`
}

/**
 * The command that writes a log for one runner.
 *
 * Runners with a documented invocation get their own spelling; anything else
 * (a `generic` host with a configured command, a script runner) falls back to
 * its descriptor's executable and base args, and only when that is absent too to
 * the historical Go command.
 * @param runnerId - resolved runner id.
 * @returns a shell fragment to append `2>&1 | tee <file>` to.
 */
function writeWith(runnerId) {
  const documented = WRITE_WITH[runnerId]
  if (documented !== undefined) return documented
  const descriptor = RUNNERS[runnerId]
  const executable = textOf(descriptor?.executable)
  if (executable !== null) {
    const args = Array.isArray(descriptor.baseArgs) ? descriptor.baseArgs.map(String) : []
    return [executable, ...args].join(' ')
  }
  return WRITE_WITH.go
}

/**
 * The directory the followed log lives in.
 *
 * Resolved the way `hub.follow` resolves the path: against the root the call
 * settled on (for a relative path that root is the conversation directory;
 * `resolve` collapses an absolute path back to itself). Classification only: an
 * unknown base or an unusable path returns null and the inference falls through
 * to the next level, because a hint must never be the reason a follow fails.
 * @param follow - `{ path, root }` of the call.
 * @returns an absolute directory, or null when it cannot be computed.
 */
function followDirectory(follow) {
  const wanted = textOf(follow?.path)
  if (wanted === null) return null
  const root = textOf(follow?.root)
  // A relative path with no conversation cwd is resolved by the hub against the
  // deployment's first follow root, which this layer does not know: do not guess.
  if (root === null && !isAbsolute(wanted)) return null
  try {
    return dirname(root === null ? resolve(wanted) : resolve(root, wanted))
  } catch {
    return null
  }
}

/**
 * The runner a directory proves, if it proves one.
 *
 * `generic` is the detector's answer for "nothing recognizable here", not
 * evidence about the log; its grammar counts nothing (src/core/grammars/
 * index.js), so a log written to a bare directory must not outvote the project
 * the conversation is actually in. Anything unreadable proves nothing either.
 * @param dir - absolute directory.
 * @returns a runner id, or null when the directory is no evidence.
 */
function detectedRunnerIn(dir) {
  try {
    const id = textOf(detectRunner(dir)?.id)
    return id === null || id === 'generic' ? null : id
  } catch {
    return null
  }
}

/**
 * The runner a follow call belongs to.
 *
 * An explicit id wins. Otherwise, in order: the newest run of the same
 * conversation (what this project was last run as); the directory of the log
 * itself (a log belongs to the project that wrote it, which is not necessarily
 * the directory the conversation runs in — a teammate's log under another
 * checkout was inferred with the conversation's grammar before); the
 * conversation's own directory; and the historical Go wording. Detection is a
 * hint, never a reason to refuse a follow, so every step degrades to the next.
 * @param hub - run registry.
 * @param context - conversation ownership.
 * @param requested - `runner` argument of the call, if any.
 * @param follow - `{ path, root }` of the file being followed.
 * @returns a runner id.
 */
function followRunner(hub, context, requested, follow = {}) {
  const explicit = textOf(requested)
  if (explicit !== null && explicit !== AUTO_RUNNER) return { id: explicit, reason: null }
  const sessionId = context?.sessionId ?? null
  let latest = null
  try {
    latest = (sessionId === null ? hub.latest?.() : hub.latest?.({ sessionId })) ?? null
  } catch {
    latest = null
  }
  const fromRun = textOf(latest?.runner)
  if (fromRun !== null) return { id: fromRun, reason: '沿用本对话最近一次运行的 runner' }
  const logDir = followDirectory(follow)
  if (logDir !== null) {
    const fromLogDir = detectedRunnerIn(logDir)
    if (fromLogDir !== null) return { id: fromLogDir, reason: '按日志所在目录探测到的 runner' }
  }
  const cwd = textOf(context?.cwd)
  if (cwd !== null) {
    try {
      const detected = textOf(detectRunner(cwd)?.id)
      if (detected !== null) return { id: detected, reason: '按对话目录探测到的 runner' }
    } catch {
      // A directory the detector cannot read is not a reason to refuse the follow.
    }
  }
  return { id: 'go', reason: '没有任何证据，沿用默认 runner' }
}

/**
 * The conversation a tool call belongs to.
 *
 * `exec.agent.session` is the platform's own session object; the resolver turns
 * it into the id/label/cwd triple the hub stores. Everything degrades to nulls:
 * a host without a session service, or a resolver that throws, must still let
 * the tool run.
 * @param exec - tool execution context.
 * @param resolver - session resolver ({describe, list}) or undefined.
 * @param origin - 'tool' for anything a model called.
 * @returns {{sessionId: string|null, sessionLabel: string|null, cwd: string|null, origin: string}}
 */
function callContext(exec, resolver, origin) {
  const context = { sessionId: null, sessionLabel: null, cwd: null, origin }
  const session = exec?.agent?.session
  if (session === null || session === undefined) return context
  let described = null
  try {
    if (resolver !== null && typeof resolver === 'object' && typeof resolver.describe === 'function') {
      described = resolver.describe(session)
    }
  } catch {
    described = null
  }
  if (described === null || typeof described !== 'object') return context
  context.sessionId = textOf(described.sessionId)
  context.sessionLabel = textOf(described.sessionLabel)
  context.cwd = textOf(described.cwd)
  return context
}

/**
 * The run a status/cancel call means.
 *
 * An explicit id wins. Otherwise an explicit `sessionId` scopes the lookup, and
 * with neither the call is scoped to the conversation that made it — a status
 * read should describe this conversation's run, and a cancel must never stop a
 * run another conversation owns just because it is the newest on the host. A
 * call that arrives without a conversation (an older host, a direct API caller)
 * still gets the host-wide newest run it always got.
 * @param hub - run registry.
 * @param options - tool arguments.
 * @param exec - tool execution context.
 * @param resolver - session resolver or undefined.
 * @returns {{meta: object|null, sessionId: string|null, scoped: boolean}}
 */
function targetRun(hub, options, exec, resolver) {
  const explicit = textOf(options.id)
  if (explicit !== null) return { meta: hub.get(explicit) ?? null, sessionId: null, scoped: false }
  const fromCall = textOf(options.sessionId) ?? callContext(exec, resolver, 'tool').sessionId
  if (fromCall !== null) {
    return { meta: hub.latest({ sessionId: fromCall }) ?? null, sessionId: fromCall, scoped: true }
  }
  return { meta: hub.latest() ?? null, sessionId: null, scoped: false }
}

/**
 * Format one list row: id, status, duration, conversation, cwd, summary.
 * @param meta - run meta.
 * @returns one line of text.
 */
function runLine(meta) {
  const duration = Number.isFinite(meta.durationMs) ? `${(meta.durationMs / 1000).toFixed(1)}s` : '-'
  const parts = [meta.id, meta.status, duration]
  if (meta.kind === 'file') parts.push('file')
  const who = textOf(meta.sessionLabel) ?? textOf(meta.sessionId)
  if (who !== null) parts.push(`对话 ${who}`)
  if (textOf(meta.cwd) !== null) parts.push(meta.cwd)
  if (meta.origin === 'tool' || meta.origin === 'panel') parts.push(meta.origin)
  if (meta.archived === true) parts.push('历史')
  const summary = typeof meta.summaryText === 'string' ? (meta.summaryText.split('\n')[0] ?? '').trim() : ''
  const line = parts.filter(part => part !== null && part !== undefined && part !== '').join(' · ')
  return summary === '' ? line : `${line} · ${summary}`
}

/**
 * @param hub - run registry.
 * @param meta - run meta.
 * @param tail - trailing line count.
 * @returns model-facing text.
 */
function report(hub, meta, tail) {
  const lines = hub.linesSince(meta.id, -1)
  const visible = Number.isInteger(tail) && tail > 0 ? tail : DEFAULT_TAIL
  const slice = lines.slice(-visible)
  const body = slice.map(entry => entry.text).join('\n')
  const omitted = lines.length - slice.length
  const who = textOf(meta.sessionLabel) ?? textOf(meta.sessionId)
  return [
    `${meta.command} ${meta.args.join(' ')}`,
    `cwd: ${meta.cwd}`,
    runnerLine(meta),
    who === null ? '' : `session: ${who}`,
    meta.summaryText,
    omitted > 0 ? `(last ${slice.length} of ${lines.length} lines)` : '',
    body,
  ].filter(line => line !== '').join('\n')
}

/**
 * Register the tools on the calling plugin's fiber.
 * @param ctx - Cordis context with the `tools` service injected.
 * @param hub - run registry.
 * @param resolver - session resolver ({describe, list}); optional.
 */
export function registerTools(ctx, hub, resolver) {
  ctx.tools.register({
    name: 'test_live_run',
    description: [
      'Start the configured test command and stream its output into the dsh-test-live sidebar panel.',
      'Pick the runner with runner ("go", "pytest", "vitest", …; "auto" detects it from the project).',
      'Returns immediately: the run is detached from the call and keeps streaming, so a slow or hung test',
      'never holds the host — read progress with test_live_status and stop it with test_live_cancel.',
      'Pass wait=true only when the run is known to be short; such a wait is abandoned as soon as the',
      'call is canceled, and it is capped.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        runner: {
          type: 'string',
          enum: [AUTO_RUNNER, ...Object.keys(RUNNERS)],
          description:
            'Runner id ("go", "vitest", "jest", "nodeTest", "pytest", "script", "generic") or "auto" ' +
            'to detect it from the project (the host default). test_live_status reports which runner a run used.',
        },
        targets: {
          type: 'array',
          items: { type: 'string' },
          description:
            'What to run: package patterns for Go, file patterns for vitest/jest/node --test, ' +
            'node ids for pytest. Defaults to the runner\'s own default.',
        },
        packages: {
          type: 'array',
          items: { type: 'string' },
          description: 'Legacy alias of targets (Go package patterns), e.g. ["./..."].',
        },
        pattern: {
          type: 'string',
          description: 'Test-name filter for the runner (Go -run, pytest -k, vitest -t, …).',
        },
        flags: {
          type: 'object',
          description: 'Runner switches by descriptor id, e.g. {"verbose": true, "race": true}.',
        },
        verbose: { type: 'boolean', description: 'Legacy alias of flags.verbose: stream every test name.' },
        race: { type: 'boolean', description: 'Legacy alias of flags.race: pass -race (Go).' },
        count: { type: 'boolean', description: 'Legacy alias of flags.count: pass -count=1 (Go).' },
        timeoutSec: { type: 'integer', description: 'Per-run wall-clock cap in seconds.' },
        wait: { type: 'boolean', description: 'Wait for the run to finish before returning (default false).' },
        waitSec: {
          type: 'integer',
          description: `Maximum wait in seconds when wait=true (default ${DEFAULT_WAIT_SEC}, capped at ${MAX_WAIT_SEC}).`,
        },
        tail: { type: 'integer', description: 'Trailing log lines to include (default 120).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const options = args && typeof args === 'object' ? args : {}
      // Refused before anything is spawned: an unknown runner, a disabled script
      // runner, a target/pattern/flag the descriptor cannot express. The argv
      // itself still comes from the runner's own normalization inside the hub.
      checkRunRequest(hub, options)
      // Ownership comes from the call, never from the arguments: the run belongs
      // to the conversation that asked for it and is spawned in that cwd.
      const meta = hub.start(options, callContext(exec, resolver, 'tool'))
      if (options.wait !== true) {
        return {
          id: meta.id,
          status: meta.status,
          text: [
            report(hub, meta, options.tail),
            `run ${meta.id} is detached from this call; poll it with test_live_status`,
          ].join('\n'),
        }
      }
      const asked = Number.isInteger(options.waitSec) && options.waitSec > 0 ? options.waitSec : DEFAULT_WAIT_SEC
      const waitSec = Math.min(asked, MAX_WAIT_SEC)
      const signal = exec?.signal
      const waited = (await hub.waitFor(meta.id, waitSec * 1000, signal)) ?? hub.get(meta.id) ?? meta
      if (waited.status !== 'running') {
        return { id: waited.id, status: waited.status, text: report(hub, waited, options.tail) }
      }
      if (signal?.aborted === true) {
        // The caller lost interest (turn canceled, timeout policy): the run must
        // not outlive the call that owns it.
        hub.cancel(meta.id)
        // Let the kill settle so the answer says canceled rather than running.
        const stopped = (await hub.waitFor(meta.id, SETTLE_MS)) ?? hub.get(meta.id) ?? waited
        return {
          id: stopped.id,
          status: stopped.status,
          text: [report(hub, stopped, options.tail), `call canceled; stopped ${stopped.id}`].join('\n'),
        }
      }
      return {
        id: waited.id,
        status: waited.status,
        text: [
          report(hub, waited, options.tail),
          `still running after ${waitSec}s; it keeps streaming — poll it with test_live_status`,
        ].join('\n'),
      }
    },
  })

  ctx.tools.register({
    name: 'test_live_status',
    description: [
      'Read one dsh-test-live run: status, the runner that produced it, per-suite counters, failures and the tail of the log.',
      'Defaults to the newest run of the current conversation; pass sessionId to read another conversation,',
      'or id for one exact run. Use test_live_runs to see what other conversations are running.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Run id; defaults to the newest run of this conversation.' },
        sessionId: { type: 'string', description: 'Read the newest run of this conversation id instead.' },
        tail: { type: 'integer', description: 'Trailing log lines to include (default 120).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args, exec) {
      const options = args && typeof args === 'object' ? args : {}
      const { meta, scoped } = targetRun(hub, options, exec, resolver)
      if (meta === null) {
        return {
          status: 'none',
          text: scoped
            ? 'this conversation has no test run yet; test_live_runs lists every conversation'
            : 'no test run has started yet',
        }
      }
      return { id: meta.id, status: meta.status, text: report(hub, meta, options.tail) }
    },
  })

  ctx.tools.register({
    name: 'test_live_follow',
    description: [
      'Follow a log file in the dsh-test-live panel: an external writer (a terminal, a bash call, CI)',
      'tees its output into the file and the panel streams it line by line with the same colouring and summary.',
      'The path must stay inside an allowed root: the configured follow roots (config.followRoots, else followRoot or cwd),',
      'plus the calling conversation\u2019s own working directory. Anything outside every root is refused.',
      'Follow runs stay "running" until test_live_cancel stops them.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Log file to follow, absolute or relative to the follow root (e.g. "fulltest.log").',
        },
        runner: {
          type: 'string',
          enum: [AUTO_RUNNER, ...Object.keys(RUNNERS)],
          description:
            'Runner whose grammar parses the file. Defaults to the newest run of this conversation, ' +
            'else what the log\u2019s own directory detects, else what the conversation directory detects.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args, exec) {
      const options = args && typeof args === 'object' ? args : {}
      // A named runner is checked like a run would be, so a typo fails here with
      // a readable message instead of producing a hint for a runner that does not
      // exist.
      if (options.runner !== undefined && options.runner !== null) checkRunRequest(hub, { runner: options.runner })
      // The conversation's cwd joins the allowed roots for this follow, so a log
      // inside the conversation's directory is reachable; anything outside every
      // root still throws and surfaces as a tool error.
      const context = callContext(exec, resolver, 'tool')
      // The hub records the runner the caller asked the file to be parsed with.
      // Only an explicit request travels: a follow without one keeps the
      // historical runner-less record, and the hint computed below stays a
      // presentation detail (which command to write the log with).
      const requestedRunner = textOf(options.runner)
      const root = selectFollowRoot(hub, context, options.path, undefined)
      // Read the hint *before* the follow registers its own file run, or the
      // newest run of the conversation would be the very run this call is
      // creating. The hint also reads the log's own directory, so it needs the
      // path and the root the follow is about to use.
      const hinted = followRunner(hub, context, options.runner, { path: options.path, root })
      // The hub records what parses the file: an explicit id as-is, `auto` as the
      // inference above (with its reason), so the counters match the log.
      if (requestedRunner === null || requestedRunner === AUTO_RUNNER) {
        // Both "auto" and "the caller named nothing" infer: the record has to
        // name the grammar the lines are parsed with, or a vitest/pytest log
        // would be counted by the Go grammar. The inference and its source go to
        // the hub together, so the record explains itself.
        context.runner = AUTO_RUNNER
        context.runnerHint = hinted.id
        context.runnerHintReason = hinted.reason
      } else {
        context.runner = requestedRunner
      }
      const meta = hub.follow(options.path, root, context)
      // The hint explains which command to write the log with; only the id the
      // hub actually recorded may be presented as the run's runner. Printing the
      // hint in the runner line claimed a provenance the run does not have (an
      // `auto` follow records none, by design).
      const recorded = textOf(meta.runner)
      const reason = textOf(meta.detectReason)
      const runnerText = `runner: ${recorded === null ? 'not recorded' : recorded}`
      return {
        id: meta.id,
        status: meta.status,
        runner: recorded,
        text: `following ${meta.file} as ${meta.id}\n` +
          `${runnerText}${recorded === null || reason === null ? '' : ` (${reason})`}\n` +
          `write with: ${writeWith(recorded ?? hinted.id)} 2>&1 | tee ${meta.file}`,
      }
    },
  })

  ctx.tools.register({
    name: 'test_live_runs',
    description: [
      'List recent dsh-test-live runs, newest first: status, duration, the conversation that owns it, its cwd and',
      'the run summary. Lists every conversation on the host by default; pass sessionId to list one conversation.',
      'Use it before test_live_status to find the run id you want, or to see what other conversations are running.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Only list runs owned by this conversation id.' },
        limit: {
          type: 'integer',
          description: `How many runs to list (default ${DEFAULT_LIST_LIMIT}, capped at ${MAX_LIST_LIMIT}).`,
        },
        tail: {
          type: 'integer',
          description: `Trailing log lines to append for each listed run (default 0, ${MAX_LIST_TAIL_LINES} lines in total).`,
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args) {
      const options = args && typeof args === 'object' ? args : {}
      const sessionId = textOf(options.sessionId)
      const askedLimit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_LIST_LIMIT
      const limit = Math.min(askedLimit, MAX_LIST_LIMIT)
      const runs = hub.list(sessionId === null ? { limit } : { sessionId, limit }) ?? []
      if (runs.length === 0) {
        return {
          count: 0,
          text: sessionId === null
            ? 'no test run has started yet'
            : `conversation ${sessionId} has no test run yet`,
        }
      }
      const where = sessionId === null ? 'every conversation' : `conversation ${sessionId}`
      const tail = Number.isInteger(options.tail) && options.tail > 0 ? options.tail : 0
      const body = []
      let budget = MAX_LIST_TAIL_LINES
      for (const meta of runs) {
        body.push(runLine(meta))
        if (tail === 0 || budget <= 0) continue
        const lines = (hub.linesSince(meta.id, -1) ?? []).slice(-Math.min(tail, budget))
        if (lines.length === 0) continue
        budget -= lines.length
        for (const entry of lines) body.push(`  | ${entry.text}`)
      }
      return {
        count: runs.length,
        text: [`${runs.length} run(s) (${where}), newest first`, ...body].join('\n'),
      }
    },
  })

  ctx.tools.register({
    name: 'test_live_cancel',
    description: [
      'Stop a running dsh-test-live test run: the newest running run of the current conversation,',
      'or one exact run by id (pass sessionId to target another conversation).',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Run id; defaults to the newest run of this conversation.' },
        sessionId: { type: 'string', description: 'Cancel the newest run of this conversation id instead.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args, exec) {
      const options = args && typeof args === 'object' ? args : {}
      const { meta, scoped } = targetRun(hub, options, exec, resolver)
      if (meta === null) {
        return {
          canceled: false,
          text: scoped ? 'this conversation has no run to cancel' : 'there is no run to cancel',
        }
      }
      const canceled = hub.cancel(meta.id)
      const run = hub.get(meta.id)
      return {
        id: meta.id,
        canceled,
        status: run?.status ?? 'unknown',
        text: canceled ? `canceled ${meta.id}` : `could not cancel ${meta.id} (status ${run?.status ?? 'unknown'})`,
      }
    },
  })
}
