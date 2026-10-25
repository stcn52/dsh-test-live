/**
 * Three tools over the same run registry the panel uses.
 *
 * They exist so the model can start a run and read the result without a second
 * log channel: everything the tool reports is also what the panel shows live.
 * @module dsh-test-live/tools
 */

/** How many trailing lines a tool output carries by default. */
const DEFAULT_TAIL = 120
/** Default budget for a caller that explicitly asked to wait. */
const DEFAULT_WAIT_SEC = 60
/** Ceiling for `waitSec`: a tool call may not pin the host for longer. */
const MAX_WAIT_SEC = 300
/** How long a canceled call waits for the kill to be observed. */
const SETTLE_MS = 5000

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
  return [
    `${meta.command} ${meta.args.join(' ')}`,
    `cwd: ${meta.cwd}`,
    meta.summaryText,
    omitted > 0 ? `(last ${slice.length} of ${lines.length} lines)` : '',
    body,
  ].filter(line => line !== '').join('\n')
}

/**
 * Register the tools on the calling plugin's fiber.
 * @param ctx - Cordis context with the `tools` service injected.
 * @param hub - run registry.
 */
export function registerTools(ctx, hub) {
  ctx.tools.register({
    name: 'test_live_run',
    description: [
      'Start the configured test command and stream its output into the dsh-test-live sidebar panel.',
      'Returns immediately: the run is detached from the call and keeps streaming, so a slow or hung test',
      'never holds the host — read progress with test_live_status and stop it with test_live_cancel.',
      'Pass wait=true only when the run is known to be short; such a wait is abandoned as soon as the',
      'call is canceled, and it is capped.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        packages: {
          type: 'array',
          items: { type: 'string' },
          description: 'Relative Go package patterns, e.g. ["./..."]. Defaults to ["./..."].',
        },
        pattern: {
          type: 'string',
          description: 'Value for -run (a test-name regex such as "TestApplyMigrations").',
        },
        verbose: { type: 'boolean', description: 'Pass -v so every test name is streamed.' },
        race: { type: 'boolean', description: 'Pass -race.' },
        count: { type: 'boolean', description: 'Pass -count=1 (disable the test result cache).' },
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
      const meta = hub.start(options)
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
      'Read one dsh-test-live run (the latest by default): status, per-package counters, failures and the tail of the log.',
      'Use it to follow a run started by test_live_run or from the sidebar panel, and to see whether it is still running.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Run id; defaults to the most recent run.' },
        tail: { type: 'integer', description: 'Trailing log lines to include (default 120).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args) {
      const options = args && typeof args === 'object' ? args : {}
      const meta = typeof options.id === 'string' && options.id !== '' ? hub.get(options.id) : hub.latest()
      if (meta === null) return { status: 'none', text: 'no test run has started yet' }
      return { id: meta.id, status: meta.status, text: report(hub, meta, options.tail) }
    },
  })

  ctx.tools.register({
    name: 'test_live_follow',
    description: [
      'Follow a log file in the dsh-test-live panel: an external writer (a terminal, a bash call, CI)',
      'tees its output into the file and the panel streams it line by line with the same colouring and summary.',
      'The path must stay inside the configured follow root (config.followRoot, else config.cwd).',
      'Follow runs stay "running" until test_live_cancel stops them.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Log file to follow, absolute or relative to the follow root (e.g. "fulltest.log").',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args) {
      const options = args && typeof args === 'object' ? args : {}
      const meta = hub.follow(options.path)
      return {
        id: meta.id,
        status: meta.status,
        text: `following ${meta.file} as ${meta.id}\n` +
          'write with: go test ./... 2>&1 | tee ' + meta.file,
      }
    },
  })

  ctx.tools.register({
    name: 'test_live_cancel',
    description: 'Stop a running dsh-test-live test run (the latest running one by default).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Run id; defaults to the most recent run.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args) {
      const options = args && typeof args === 'object' ? args : {}
      const id = typeof options.id === 'string' && options.id !== '' ? options.id : hub.latest()?.id
      if (id === undefined) return { canceled: false, text: 'there is no run to cancel' }
      const canceled = hub.cancel(id)
      const run = hub.get(id)
      return {
        id,
        canceled,
        status: run?.status ?? 'unknown',
        text: canceled ? `canceled ${id}` : `could not cancel ${id} (status ${run?.status ?? 'unknown'})`,
      }
    },
  })
}
