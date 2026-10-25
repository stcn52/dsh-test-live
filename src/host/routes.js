/**
 * Host HTTP surface for the live test panel.
 *
 * The client bundle runs in the browser and cannot spawn a process, so these
 * routes are the only data channel:
 *
 *   GET  /test-live/runs                recent runs, newest first
 *   GET  /test-live/status?id=…         one run's meta (latest when id is absent)
 *   POST /test-live/run                 start a run (JSON options) → 202 + meta
 *   POST /test-live/cancel              stop a run {id}
 *   GET  /test-live/log?id=…            plain-text log (?download=1 as attachment)
 *   GET  /test-live/stream?id=…&since=… Server-Sent Events: backlog, then live lines
 *
 * The run options are validated by the runner (`normalizeRunOptions`): a caller
 * can pick package patterns and a `-run` filter, never a command.
 * @module dsh-test-live/host/routes
 */

/** Route prefix claimed by this plugin. */
export const ROUTE_PREFIX = '/test-live'

/** Upper bound for a JSON request body; the panel sends a few dozen bytes. */
const MAX_BODY_BYTES = 64 * 1024

/** Heartbeat interval: proxies drop an idle SSE connection otherwise. */
const PING_INTERVAL_MS = 15000

/**
 * Send one JSON response.
 * @param res - server response.
 * @param status - HTTP status code.
 * @param value - JSON-serializable body.
 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Send plain text.
 * @param res - server response.
 * @param status - HTTP status code.
 * @param type - media type.
 * @param body - response body.
 */
function sendText(res, status, type, body) {
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Read a small JSON object body.
 * @param req - server request.
 * @returns the parsed object ({} when empty).
 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  const parsed = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed
}

/**
 * Mount the HTTP surface.
 *
 * Services are reached through cordis injection, not a name lookup: `ctx.get()`
 * takes a plugin, so `ctx.get('webServer')` quietly returns undefined and every
 * route 404s (which is exactly how the panel showed "Unexpected end of JSON
 * input"). Injecting also covers the two legitimate ordering cases — a web server
 * that loads after this plugin, and a headless profile that has none at all, where
 * the callback simply never runs and the tools keep working.
 * @param ctx - Cordis context.
 * @param hub - run registry.
 * @returns true when the routes were handed to the injection scope.
 */
export function registerRoutes(ctx, hub) {
  if (typeof ctx.inject !== 'function') return false
  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => {
        handle(req, res, hub).catch(error => {
          if (res.writableEnded) return
          try {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          } catch {
            res.end()
          }
        })
      },
    }))
  })
  return true
}

/**
 * Write one SSE data event carrying a log line.
 * @param res - server response.
 * @param entry - buffered line.
 */
function writeLine(res, entry) {
  res.write(`data: ${JSON.stringify({
    seq: entry.seq,
    text: entry.text,
    kind: entry.kind,
    provisional: entry.provisional === true,
  })}\n\n`)
}

/**
 * Write one SSE named event.
 * @param res - server response.
 * @param name - event name.
 * @param value - JSON payload.
 */
function writeEvent(res, name, value) {
  res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`)
}

/**
 * Stream a run: replay the backlog after `since`, then follow live lines.
 * @param req - server request.
 * @param res - server response.
 * @param hub - run registry.
 * @param url - parsed request URL.
 */
function streamRun(req, res, hub, url) {
  const requested = url.searchParams.get('id')
  const id = requested !== null && requested !== '' ? requested : hub.latest()?.id
  if (id === undefined) {
    sendJson(res, 404, { error: 'there is no run yet' })
    return
  }
  const run = hub.get(id)
  if (run === null) {
    sendJson(res, 404, { error: `run "${id}" is not known (a host restart clears finished runs)` })
    return
  }
  const sinceRaw = url.searchParams.get('since')
  const since = sinceRaw === null ? -1 : Number(sinceRaw)
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')
  for (const entry of hub.linesSince(id, Number.isFinite(since) ? since : -1)) writeLine(res, entry)
  if (run.status !== 'running') {
    writeEvent(res, 'status', run)
    res.end()
    return
  }
  const unsubscribe = hub.subscribe(id, {
    onLine(entry) {
      writeLine(res, entry)
    },
    onStatus(meta) {
      writeEvent(res, 'status', meta)
      res.end()
    },
  })
  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n')
  }, PING_INTERVAL_MS)
  ping.unref?.()
  req.on('close', () => {
    clearInterval(ping)
    if (typeof unsubscribe === 'function') unsubscribe()
  })
}

/**
 * Route one request.
 * @param req - server request.
 * @param res - server response.
 * @param hub - run registry.
 * @returns nothing.
 */
async function handle(req, res, hub) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const method = req.method ?? 'GET'

  if (path === `${ROUTE_PREFIX}/runs`) {
    if (method !== 'GET') return sendJson(res, 405, { error: 'GET required' })
    return sendJson(res, 200, { runs: hub.list() })
  }

  if (path === `${ROUTE_PREFIX}/status`) {
    if (method !== 'GET') return sendJson(res, 405, { error: 'GET required' })
    const id = url.searchParams.get('id')
    if (id !== null && id !== '') {
      const run = hub.get(id)
      if (run === null) return sendJson(res, 404, { error: `run "${id}" is not known` })
      return sendJson(res, 200, run)
    }
    const latest = hub.latest()
    return sendJson(res, 200, latest === null ? { run: null } : latest)
  }

  if (path === `${ROUTE_PREFIX}/run`) {
    if (method !== 'POST') return sendJson(res, 405, { error: 'POST required' })
    let body
    try {
      body = await readJson(req)
    } catch (error) {
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    try {
      const run = hub.start(body)
      return sendJson(res, 202, run)
    } catch (error) {
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  if (path === `${ROUTE_PREFIX}/follow`) {
    if (method !== 'POST') return sendJson(res, 405, { error: 'POST required' })
    let body
    try {
      body = await readJson(req)
    } catch (error) {
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    try {
      // An external writer (terminal, bash, CI) tees into this file; the panel
      // tails it with the same SSE stream as a spawned run.
      return sendJson(res, 202, hub.follow(body.path))
    } catch (error) {
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  if (path === `${ROUTE_PREFIX}/cancel`) {
    if (method !== 'POST') return sendJson(res, 405, { error: 'POST required' })
    let body
    try {
      body = await readJson(req)
    } catch (error) {
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    const id = typeof body.id === 'string' ? body.id : hub.latest()?.id
    if (id === undefined) return sendJson(res, 404, { error: 'there is no run to cancel' })
    const canceled = hub.cancel(id)
    return sendJson(res, canceled ? 200 : 409, { canceled, id, run: hub.get(id) })
  }

  if (path === `${ROUTE_PREFIX}/log`) {
    if (method !== 'GET') return sendJson(res, 405, { error: 'GET required' })
    const requested = url.searchParams.get('id')
    const id = requested !== null && requested !== '' ? requested : hub.latest()?.id
    if (id === undefined) return sendJson(res, 404, { error: 'there is no run yet' })
    const run = hub.get(id)
    if (run === null) return sendJson(res, 404, { error: `run "${id}" is not known` })
    const text = hub.linesSince(id, -1).map(entry => entry.text).join('\n') + '\n'
    const attachment = url.searchParams.get('download') === '1'
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
      ...(attachment ? { 'content-disposition': `attachment; filename="${id}.log"` } : {}),
    })
    res.end(text)
    return
  }

  if (path === `${ROUTE_PREFIX}/stream`) {
    if (method !== 'GET') return sendJson(res, 405, { error: 'GET required' })
    return streamRun(req, res, hub, url)
  }

  return sendJson(res, 404, { error: `unknown route ${method} ${path}` })
}
