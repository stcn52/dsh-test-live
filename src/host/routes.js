/**
 * Host HTTP surface for the live test panel.
 *
 * The client bundle runs in the browser and cannot spawn a process, so these
 * routes are the only data channel:
 *
 *   GET  /test-live/runs                recent runs, newest first
 *                                       ?scope=all|session&sessionId=…&limit=…
 *   GET  /test-live/sessions            conversations that own runs + defaultScope
 *   GET  /test-live/roots               configured follow roots + run cwd
 *   GET  /test-live/status?id=…         one run's meta (latest when id is absent)
 *   POST /test-live/run                 start a run (JSON options) → 202 + meta
 *   POST /test-live/cancel              stop a run {id}
 *   GET  /test-live/log?id=…            plain-text log (?download=1 as attachment)
 *   GET  /test-live/stream?id=…&since=… Server-Sent Events: backlog, then live lines
 *
 * A run belongs to a conversation, not to a directory: the panel sends the
 * session it is shown in, `sessionId` is resolved to {sessionLabel, cwd} through
 * the session resolver, and the run is spawned in that conversation's cwd. Every
 * session-aware parameter is optional — a client written before conversations
 * existed still gets exactly the host-wide view it always got.
 *
 * The run options are validated by the runner (`normalizeRunOptions`): a caller
 * can pick package patterns and a `-run` filter, never a command.
 * @module dsh-test-live/host/routes
 */

import { isAbsolute, resolve, sep } from 'node:path'

/** Route prefix claimed by this plugin. */
export const ROUTE_PREFIX = '/test-live'

/** Scope value meaning "every conversation on this host". */
const SCOPE_ALL = 'all'

/** Scope value meaning "only the conversation named by sessionId". */
const SCOPE_SESSION = 'session'

/** Scope values a client may ask for. */
const SCOPES = new Set([SCOPE_ALL, SCOPE_SESSION])

/** Upper bound on `limit`, so one request cannot ask for an unbounded list. */
const MAX_LIMIT = 500

/**
 * Trim a string parameter into an id, or null when it carries no value.
 * @param value - query parameter or body field.
 * @returns the trimmed string, or null.
 */
function trimId(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * The scope a host-wide client gets when it names none.
 *
 * `defaultScope` is a host setting (older hosts shipped 'all'): read it off the
 * hub when it exposes one and fall back to 'all', which is exactly the view a
 * pre-conversation client always saw.
 * @param hub - run registry.
 * @returns 'all' or 'session'.
 */
function defaultScopeOf(hub) {
  const candidates = [hub?.defaultScope, hub?.settings?.defaultScope]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && SCOPES.has(candidate)) return candidate
  }
  return SCOPE_ALL
}

/**
 * Turn a requested session id into the run-ownership context the hub expects.
 *
 * Every field stays nullable: an unknown id (the panel was opened on a stale
 * page), a missing resolver (a profile without the session service) or a
 * resolver that throws must degrade to "no conversation", never fail a request.
 * @param resolver - session resolver ({describe, list}) or undefined.
 * @param rawSessionId - requested session id.
 * @param origin - 'panel' for anything that came in over HTTP.
 * @returns {{sessionId: string|null, sessionLabel: string|null, cwd: string|null, origin: string}}
 */
function sessionContext(resolver, rawSessionId, origin) {
  const requested = trimId(rawSessionId)
  const context = { sessionId: requested, sessionLabel: null, cwd: null, origin }
  if (requested === null) return context
  let described = null
  try {
    if (resolver !== null && typeof resolver === 'object' && typeof resolver.describe === 'function') {
      described = resolver.describe(requested)
    }
  } catch {
    described = null
  }
  if (described === null || typeof described !== 'object') return context
  // An unknown id describes to all-null fields; the requested id is still the
  // honest answer for "which conversation did this come from".
  const id = trimId(described.sessionId)
  if (id !== null) context.sessionId = id
  const label = trimId(described.sessionLabel)
  if (label !== null) context.sessionLabel = label
  const cwd = trimId(described.cwd)
  if (cwd !== null) context.cwd = cwd
  return context
}

/**
 * Read the list filter out of a query string.
 *
 * `scope=session` without a session id cannot filter anything, so it degrades to
 * the host-wide view instead of answering a silently empty list; `limit` is
 * clamped and dropped when it is not a positive integer, letting the hub apply
 * its own default.
 * @param url - parsed request URL.
 * @param hub - run registry.
 * @returns {{scope: string, sessionId: string|null, limit: number|undefined}}
 */
function listQuery(url, hub) {
  const requested = url.searchParams.get('scope')
  const sessionId = trimId(url.searchParams.get('sessionId'))
  let scope = typeof requested === 'string' && SCOPES.has(requested) ? requested : defaultScopeOf(hub)
  if (scope === SCOPE_SESSION && sessionId === null) scope = SCOPE_ALL
  const rawLimit = url.searchParams.get('limit')
  const parsedLimit = rawLimit === null || rawLimit.trim() === '' ? Number.NaN : Number(rawLimit)
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, MAX_LIMIT) : undefined
  return { scope, sessionId, limit }
}

/**
 * The `latest` filter for a request whose id is absent.
 *
 * `scope=all` (or no scope at all) keeps the host-wide behaviour every older
 * client relies on; a named session without a conflicting scope narrows the
 * fallback to that conversation.
 * @param url - parsed request URL.
 * @returns {{sessionId?: string}} filter for `hub.latest`.
 */
function sessionFilter(url) {
  const sessionId = trimId(url.searchParams.get('sessionId'))
  if (sessionId === null) return {}
  const scope = url.searchParams.get('scope')
  if (scope !== null && SCOPES.has(scope) && scope !== SCOPE_SESSION) return {}
  return { sessionId }
}

/**
 * Normalize one conversation entry for the wire.
 * @param entry - {id,label,cwd,…} from the hub or from a run.
 * @param described - resolver's {sessionLabel, cwd} for the same id, or null.
 * @returns conversation summary.
 */
function sessionEntry(entry, described) {
  const id = trimId(entry.id) ?? trimId(entry.sessionId)
  // The resolver is the authority on a conversation's label and cwd; the run
  // only carries what was true when it was started (and a run from before
  // conversations existed carries the host cwd).
  const label = trimId(described?.sessionLabel) ?? trimId(entry.label) ?? trimId(entry.sessionLabel)
  const cwd = trimId(described?.cwd) ?? trimId(entry.cwd)
  return {
    id,
    label,
    cwd,
    count: Number.isInteger(entry.count) ? entry.count : 0,
    running: entry.running === true,
    lastAt: Number.isFinite(entry.lastAt) ? entry.lastAt : null,
    // Alias pair for renderers that read the resolver's field names.
    sessionId: id,
    sessionLabel: label,
  }
}

/**
 * Conversations that own at least one run, newest activity first.
 *
 * The hub keeps the authoritative counts; the resolver only fills in the label
 * and cwd the runs themselves may not carry (a run started before the
 * conversation fields existed). Without `hub.sessions` the same shape is derived
 * from the runs, so an older hub still answers /sessions.
 * @param hub - run registry.
 * @param resolver - session resolver or undefined.
 * @param allRuns - every run meta, unfiltered.
 * @returns {Array<object>} conversation summaries.
 */
function sessionsOf(hub, resolver, allRuns) {
  const described = new Map()
  try {
    if (resolver !== null && typeof resolver === 'object' && typeof resolver.list === 'function') {
      for (const item of resolver.list() ?? []) {
        const id = trimId(item?.sessionId)
        if (id !== null) described.set(id, item)
      }
    }
  } catch {
    // A session service that is going away must not empty the dropdown.
  }
  let listed = null
  try {
    if (typeof hub.sessions === 'function') listed = hub.sessions()
  } catch {
    listed = null
  }
  if (!Array.isArray(listed)) {
    const derived = new Map()
    for (const run of allRuns) {
      const id = trimId(run?.sessionId)
      if (id === null) continue
      const known = derived.get(id)
      if (known === undefined) {
        derived.set(id, { id, label: run.sessionLabel, cwd: run.cwd, count: 1, running: run.status === 'running', lastAt: run.startedAt })
        continue
      }
      known.count += 1
      known.running = known.running || run.status === 'running'
      if (Number.isFinite(run.startedAt) && run.startedAt > (known.lastAt ?? 0)) known.lastAt = run.startedAt
    }
    listed = [...derived.values()]
  }
  return listed
    .map(entry => sessionEntry(entry, described.get(trimId(entry.id) ?? trimId(entry.sessionId)) ?? null))
    .filter(entry => entry.id !== null)
    .sort((left, right) => (right.lastAt ?? 0) - (left.lastAt ?? 0))
}

/**
 * Pick the root a follow call should be resolved against.
 *
 * The hub validates the followed path against one root at a time, so the caller
 * has to say which root it means — and only ever one of the roots the hub
 * already allows for this conversation (`hub.followRootsFor`). A relative path
 * means "inside this conversation", an absolute path means the root that
 * contains it, and a path outside every root is passed through untouched so the
 * hub refuses it with its own wording (never silently re-rooted).
 *
 * Shared with the tools: both surfaces would otherwise pass no root and make the
 * conversation's own directory unreachable.
 * @param hub - run registry.
 * @param context - {sessionId, sessionLabel, cwd, origin}.
 * @param inputPath - requested follow path.
 * @param explicit - root the caller named, if any.
 * @returns a root string, or undefined to keep the hub's configured default.
 */
export function selectFollowRoot(hub, context, inputPath, explicit) {
  if (typeof explicit === 'string' && explicit !== '') return explicit
  const cwd = trimId(context?.cwd)
  if (cwd === null) return undefined
  const wanted = typeof inputPath === 'string' ? inputPath.trim() : ''
  if (wanted === '' || !isAbsolute(wanted)) return cwd
  let roots = []
  try {
    if (typeof hub.followRootsFor === 'function') roots = hub.followRootsFor(context) ?? []
  } catch {
    roots = []
  }
  const target = resolve(wanted)
  const matches = roots
    .filter(root => typeof root === 'string' && root !== '')
    .map(root => resolve(root))
    .filter(root => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep))
    .sort((left, right) => right.length - left.length)
  // No allowed root contains it: hand the path over unchanged and let the hub
  // produce the refusal, so the 400 wording stays the hub's.
  return matches[0]
}

/**
 * The run id a request without an explicit `id` means.
 *
 * An explicit id always wins. Otherwise the newest run of the named conversation
 * is used when there is one, and the newest run of the host when there is not —
 * which is the behaviour a client that never heard of conversations expects.
 * @param hub - run registry.
 * @param url - parsed request URL (query id/sessionId/scope).
 * @returns the run id, or undefined when the host has no run at all.
 */
function targetId(hub, url) {
  const explicit = trimId(url.searchParams.get('id'))
  if (explicit !== null) return explicit
  const sessionId = trimId(url.searchParams.get('sessionId'))
  if (sessionId !== null) {
    const scoped = typeof hub.latest === 'function' ? hub.latest({ sessionId }) : null
    if (scoped !== null && scoped !== undefined) return scoped.id
    return undefined
  }
  return hub.latest()?.id
}

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
 * @param resolver - session resolver ({describe, list}); optional, so a profile
 *   without the session service keeps serving host-wide state.
 * @returns true when the routes were handed to the injection scope.
 */
export function registerRoutes(ctx, hub, resolver) {
  if (typeof ctx.inject !== 'function') return false
  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => {
        handle(req, res, hub, resolver).catch(error => {
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
  const id = targetId(hub, url)
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
 * @param resolver - session resolver or undefined.
 * @returns nothing.
 */
async function handle(req, res, hub, resolver) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const method = req.method ?? 'GET'

  if (path === `${ROUTE_PREFIX}/runs`) {
    if (method !== 'GET') return sendJson(res, 405, { error: 'GET required' })
    const { scope, sessionId, limit } = listQuery(url, hub)
    const allRuns = hub.list({})
    const filter = scope === SCOPE_SESSION ? { sessionId, limit } : { limit }
    // The host-wide view without a limit is exactly `allRuns`: no second scan.
    const runs = scope === SCOPE_SESSION || limit !== undefined ? hub.list(filter) : allRuns
    return sendJson(res, 200, {
      runs,
      // The dropdown must offer every conversation, not only those in the
      // filtered list — otherwise picking one would erase the other options.
      sessions: sessionsOf(hub, resolver, allRuns),
      scope,
      defaultScope: defaultScopeOf(hub),
    })
  }

  if (path === `${ROUTE_PREFIX}/sessions`) {
    if (method !== 'GET') return sendJson(res, 405, { error: 'GET required' })
    return sendJson(res, 200, {
      sessions: sessionsOf(hub, resolver, hub.list({})),
      defaultScope: defaultScopeOf(hub),
    })
  }

  if (path === `${ROUTE_PREFIX}/status`) {
    if (method !== 'GET') return sendJson(res, 405, { error: 'GET required' })
    const id = url.searchParams.get('id')
    if (id !== null && id !== '') {
      const run = hub.get(id)
      if (run === null) return sendJson(res, 404, { error: `run "${id}" is not known` })
      return sendJson(res, 200, run)
    }
    const latest = hub.latest(sessionFilter(url))
    return sendJson(res, 200, latest === null || latest === undefined ? { run: null } : latest)
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
      // The conversation, not the host's cwd, owns the run: resolve it to a
      // label + cwd so the run is spawned where the user was working and the
      // panel can group it under that conversation.
      const context = sessionContext(resolver, body.sessionId, 'panel')
      const options = { ...body }
      delete options.sessionId
      const run = hub.start(options, context)
      return sendJson(res, 202, run)
    } catch (error) {
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  if (path === `${ROUTE_PREFIX}/roots`) {
    if (method !== 'GET') return sendJson(res, 405, { error: 'GET required' })
    // Configuration only: the panel needs the picker's options, not a directory
    // listing of the host (that would be a file browser, a much wider surface).
    return sendJson(res, 200, { roots: hub.roots(), cwd: hub.cwd() })
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
      // tails it with the same SSE stream as a spawned run. `root` may only
      // narrow to a root the hub allows, never widen the allow-list; the run's
      // conversation adds its own cwd to those roots, so a log inside the
      // conversation's directory is reachable while anything outside every root
      // is still refused (the hub throws, this becomes the 400).
      const namedRoot = typeof body.root === 'string' && body.root.trim() !== '' ? body.root.trim() : undefined
      const context = sessionContext(resolver, body.sessionId, 'panel')
      const root = selectFollowRoot(hub, context, body.path, namedRoot)
      return sendJson(res, 202, hub.follow(body.path, root, context))
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
    const requested = typeof body.id === 'string' ? body.id : null
    const sessionId = trimId(body.sessionId)
    const fallback = sessionId === null ? hub.latest() : hub.latest({ sessionId })
    const id = requested === null ? fallback?.id : requested
    if (id === undefined) return sendJson(res, 404, { error: 'there is no run to cancel' })
    const canceled = hub.cancel(id)
    return sendJson(res, canceled ? 200 : 409, { canceled, id, run: hub.get(id) })
  }

  if (path === `${ROUTE_PREFIX}/log`) {
    if (method !== 'GET') return sendJson(res, 405, { error: 'GET required' })
    const id = targetId(hub, url)
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
