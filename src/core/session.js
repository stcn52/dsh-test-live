/**
 * Which conversation a run belongs to.
 *
 * A run is owned by a *session* (one chat with the model), not by a project
 * directory: the same repository is visited from several conversations, and one
 * conversation may touch several directories. The host already holds that
 * identity (`ctx.sessions`, `ctx.workingDirectory`, `ctx.sessionTitle`), so the
 * resolver only reads it — it never creates or mutates a session.
 *
 * Every source is optional. A profile without those services (headless, SDK, an
 * older host) gets `null` fields and the panel keeps working; a broken service
 * must never fail a test run, so every probe is guarded and downgraded.
 * @module dsh-test-live/core/session
 */

/** The shape every entry has; a missing value is `null`, never `undefined`. */
const EMPTY = Object.freeze({ sessionId: null, sessionLabel: null, cwd: null })

/**
 * Call a host service without letting it break the caller.
 * @param probe - zero-argument function.
 * @returns its value, or undefined when it threw.
 */
function attempt(probe) {
  try {
    return probe()
  } catch {
    return undefined
  }
}

/**
 * @param value - candidate.
 * @returns the trimmed non-empty string, else null.
 */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * @param value - candidate path.
 * @returns the path when it is absolute, else null (a relative cwd would make
 * spawn resolve against the host's directory, i.e. the wrong project).
 */
function absolutePath(value) {
  const candidate = text(value)
  return candidate !== null && candidate.startsWith('/') ? candidate : null
}

/**
 * Read the identifier the host puts on a Session object.
 * @param session - Session-like object.
 * @returns the id, or null.
 */
function idOf(session) {
  if (session === null || typeof session !== 'object') return null
  return text(session.id) ?? text(session.sessionId) ?? text(session.header?.id)
}

/**
 * Read the directory the session runs in.
 * @param session - Session-like object.
 * @returns absolute path, or null.
 */
function cwdOf(session) {
  if (session === null || typeof session !== 'object') return null
  return (
    absolutePath(session.header?.cwd) ??
    absolutePath(session.cwd) ??
    absolutePath(session.workingDirectory) ??
    absolutePath(session.header?.workingDirectory)
  )
}

/**
 * Read the human title the host shows for the session.
 * @param session - Session-like object.
 * @returns the label, or null.
 */
function labelOf(session) {
  if (session === null || typeof session !== 'object') return null
  return text(session.header?.title) ?? text(session.title) ?? text(session.label)
}

/**
 * Build the session resolver for one host context.
 *
 * `describe(input)` accepts either a Session object (what a tool's `exec.agent`
 * hands over) or a bare session id (what the panel posts); `list()` enumerates
 * the sessions the host knows about, for the panel's filter.
 * @param ctx - Cordis context (may be undefined in a bare deployment).
 * @returns {{ describe: (input: any) => { sessionId: string|null, sessionLabel: string|null, cwd: string|null }, list: () => Array<{ sessionId: string|null, sessionLabel: string|null, cwd: string|null }> }}
 */
export function createSessionResolver(ctx) {
  const sessions = () => {
    const service = ctx?.sessions
    return service !== null && typeof service === 'object' ? service : null
  }

  /**
   * Look one session up by id on the host, tolerating every missing seam.
   * @param id - session id.
   * @returns Session-like object, or null.
   */
  function byId(id) {
    const service = sessions()
    if (service === null || typeof service.get !== 'function') return null
    const found = attempt(() => service.get(id))
    return found !== null && typeof found === 'object' ? found : null
  }

  /**
   * Fill the identity of one session from both the object and host services.
   * @param session - Session-like object (may be null).
   * @param fallbackId - id already known from the call site.
   * @returns { sessionId, sessionLabel, cwd }.
   */
  function describeSession(session, fallbackId) {
    const id = idOf(session) ?? text(fallbackId)
    const workingDirectory = attempt(() =>
      typeof ctx?.workingDirectory?.get === 'function' ? ctx.workingDirectory.get(session) : undefined,
    )
    const title = attempt(() =>
      typeof ctx?.sessionTitle?.get === 'function' ? ctx.sessionTitle.get(session) : undefined,
    )
    return {
      sessionId: id,
      // The host returns `{ title }` for a session title; tolerate a raw string.
      sessionLabel: text(title !== null && typeof title === 'object' ? title.title : title) ?? labelOf(session),
      cwd: absolutePath(workingDirectory) ?? cwdOf(session),
    }
  }

  /**
   * Describe the run's owner.
   * @param input - a Session object, a session id string, or nothing.
   * @returns the three-field identity; never throws.
   */
  function describe(input) {
    try {
      if (input === null || input === undefined) return { ...EMPTY }
      if (typeof input === 'string') {
        const id = text(input)
        if (id === null) return { ...EMPTY }
        return describeSession(byId(id), id)
      }
      if (typeof input !== 'object') return { ...EMPTY }
      // A panel may post a plain `{ sessionId }` object rather than an id string.
      const id = idOf(input)
      const session = id !== null ? (input.header !== undefined || input.title !== undefined ? input : byId(id) ?? input) : input
      return describeSession(session, id)
    } catch {
      return { ...EMPTY }
    }
  }

  /**
   * Enumerate the host's sessions, deduplicated by id.
   * @returns entries; empty when the host has no session service.
   */
  function list() {
    try {
      const service = sessions()
      if (service === null || typeof service.list !== 'function') return []
      const found = attempt(() => service.list())
      if (!Array.isArray(found)) return []
      const seen = new Set()
      const entries = []
      for (const candidate of found) {
        const described = describe(candidate)
        if (described.sessionId === null || seen.has(described.sessionId)) continue
        seen.add(described.sessionId)
        entries.push(described)
      }
      return entries
    } catch {
      return []
    }
  }

  return { describe, list }
}

export default createSessionResolver
