window.__ModuleLoader__.load({
  id: 'dsh-test-live',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement

    var TAB_ID = 'dsh-test-live'
    var KIND = 'test-live'
    var STYLE_ID = 'dsh-test-live-style'
    var ROUTE = '/test-live'
    var MAX_RENDERED = 2500

    // localStorage keys. The target text used to be "packages"; the old key is
    // still read so an upgrading install keeps its patterns.
    var PREF_RUNNER = 'dsh-test-live:runner'
    var PREF_TARGETS = 'dsh-test-live:targets'
    var PREF_PACKAGES = 'dsh-test-live:packages'
    var PREF_VERBOSE = 'dsh-test-live:verbose'

    // Command prefixes for the empty-state example. GET /test-live/runners does
    // not project executable/baseArgs, so the client mirrors them here; an id it
    // does not know falls back to the pre-runner Go wording.
    var RUNNER_PREFIX = {
      go: 'go test',
      vitest: 'pnpm exec vitest run',
      jest: 'pnpm exec jest',
      nodeTest: 'node --test',
      pytest: 'pytest',
      script: 'pnpm test',
    }

    var CSS = [
      '.dtl-root { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--fg, #e6e9ef); font-size: 13px; }',
      '.dtl-bar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--border, #2a2f3a); flex-wrap: wrap; flex: 0 0 auto; }',
      '.dtl-bar button { font: inherit; font-size: 12px; color: inherit; background: var(--surface-2, #1b202a); border: 1px solid var(--border, #2a2f3a); border-radius: 7px; padding: 4px 10px; cursor: pointer; }',
      '.dtl-bar button:hover:not(:disabled) { border-color: var(--accent, #6ea8fe); color: var(--accent, #6ea8fe); }',
      '.dtl-bar button:disabled { opacity: 0.45; cursor: default; }',
      '.dtl-bar button.dtl-primary { background: var(--accent-soft, rgba(110,168,254,0.22)); border-color: var(--accent, #6ea8fe); }',
      '.dtl-bar input[type="text"] { font: inherit; font-size: 12px; font-family: var(--mono, ui-monospace, monospace); color: inherit; background: var(--surface-2, #1b202a); border: 1px solid var(--border, #2a2f3a); border-radius: 7px; padding: 4px 8px; min-width: 0; width: 100%; }',
      '.dtl-bar .dtl-grow { flex: 1 1 120px; }',
      '.dtl-check { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--fg-muted, #98a2b3); white-space: nowrap; }',
      '.dtl-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font-size: 11px; border: 1px solid var(--border, #2a2f3a); white-space: nowrap; }',
      '.dtl-badge[data-status="running"] { color: #ffc46b; border-color: #6b553a; background: #2a2418; }',
      '.dtl-badge[data-status="passed"] { color: #7ee0a1; border-color: #34604a; background: #182a20; }',
      '.dtl-badge[data-status="failed"] { color: #ff8a80; border-color: #6d3a3a; background: #2a1c1e; }',
      '.dtl-badge[data-status="canceled"] { color: var(--fg-muted, #98a2b3); }',
      '.dtl-meta { padding: 6px 10px; border-bottom: 1px solid var(--border, #2a2f3a); font-size: 11.5px; color: var(--fg-muted, #98a2b3); display: grid; gap: 2px; flex: 0 0 auto; }',
      '.dtl-meta code { font-family: var(--mono, ui-monospace, monospace); color: var(--fg, #e6e9ef); overflow-wrap: anywhere; }',
      '.dtl-runs { display: flex; align-items: stretch; gap: 6px; overflow-x: auto; overflow-y: hidden; padding: 6px 10px; border-bottom: 1px solid var(--border, #2a2f3a); flex: 0 0 auto; }',
      '.dtl-run { flex: 0 0 auto; display: grid; gap: 1px; text-align: left; font: inherit; font-size: 11px; color: var(--fg-muted, #98a2b3); background: var(--surface-2, #1b202a); border: 1px solid var(--border, #2a2f3a); border-radius: 7px; padding: 4px 9px; cursor: pointer; }',
      '.dtl-run:hover { border-color: var(--accent, #6ea8fe); }',
      '.dtl-run.is-current { border-color: var(--accent, #6ea8fe); color: var(--fg, #e6e9ef); background: var(--accent-soft, rgba(110,168,254,0.16)); }',
      '.dtl-run[data-status="failed"] .dtl-run-id { color: #ff8a80; }',
      '.dtl-run[data-status="passed"] .dtl-run-id { color: #7ee0a1; }',
      '.dtl-run[data-status="running"] .dtl-run-id { color: #ffc46b; }',
      '.dtl-run-id { font-family: var(--mono, ui-monospace, monospace); font-size: 11px; }',
      '.dtl-run-sub { white-space: nowrap; font-size: 10.5px; }',
      '.dtl-log { flex: 1 1 auto; min-height: 120px; overflow: auto; padding: 6px 0; font-family: var(--mono, ui-monospace, monospace); font-size: 11.5px; line-height: 1.5; }',
      '.dtl-line { display: flex; gap: 8px; padding: 0 10px; white-space: pre-wrap; overflow-wrap: anywhere; }',
      '.dtl-line:hover { background: var(--surface-2, #1b202a); }',
      '.dtl-seq { flex: 0 0 auto; color: var(--border-strong, #3a4150); user-select: none; min-width: 3.5em; text-align: right; }',
      '.dtl-line[data-kind="run"] { color: #8fb8ff; }',
      '.dtl-line[data-kind="pass"] { color: #7ee0a1; }',
      '.dtl-line[data-kind="fail"] { color: #ff8a80; font-weight: 600; }',
      '.dtl-line[data-kind="skip"] { color: #c3a6ff; }',
      '.dtl-line[data-kind="package-ok"] { color: #7ee0a1; }',
      '.dtl-line[data-kind="package-ok"] { background: rgba(126, 224, 161, 0.05); }',
      '.dtl-line[data-kind="package-fail"] { color: #ff8a80; background: rgba(255, 138, 128, 0.08); font-weight: 600; }',
      '.dtl-line[data-kind="package-empty"] { color: var(--fg-muted, #98a2b3); }',
      '.dtl-line[data-kind="build"] { color: #ffc46b; }',
      '.dtl-line[data-kind="panic"] { color: #ff8a80; background: rgba(255, 138, 128, 0.1); }',
      '.dtl-line[data-kind="result"] { color: var(--fg, #e6e9ef); font-weight: 600; }',
      '.dtl-line[data-provisional="true"] { opacity: 0.6; }',
      '.dtl-foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 6px 10px; border-top: 1px solid var(--border, #2a2f3a); font-size: 11.5px; color: var(--fg-muted, #98a2b3); flex: 0 0 auto; }',
      '.dtl-foot b { color: var(--fg, #e6e9ef); font-weight: 600; }',
      '.dtl-foot a { color: var(--accent, #6ea8fe); text-decoration: none; }',
      '.dtl-empty { padding: 18px 14px; color: var(--fg-muted, #98a2b3); display: grid; gap: 8px; line-height: 1.6; }',
      '.dtl-empty code { color: var(--fg, #e6e9ef); font-family: var(--mono, ui-monospace, monospace); }',
      '.dtl-error { margin: 6px 10px; padding: 6px 9px; border: 1px solid #6d3a3a; background: #2a1c1e; color: #ff8a80; border-radius: 7px; font-size: 11.5px; }',
      '.dtl-filter { padding: 4px 10px; }',
      '.dtl-filter .dtl-filter-label { font-size: 11px; color: var(--fg-muted, #98a2b3); white-space: nowrap; }',
      '.dtl-bar button.dtl-seg { padding: 2px 9px; font-size: 11.5px; border-radius: 999px; opacity: 0.72; }',
      '.dtl-bar button.dtl-seg.is-active { opacity: 1; color: var(--fg, #e6e9ef); background: var(--accent-soft, rgba(110,168,254,0.22)); border-color: var(--accent, #6ea8fe); }',
      '.dtl-select { font: inherit; font-size: 11.5px; color: inherit; background: var(--surface-2, #1b202a); border: 1px solid var(--border, #2a2f3a); border-radius: 7px; padding: 3px 6px; max-width: 220px; }',
      '.dtl-runner { max-width: 190px; }',
      '.dtl-note { font-size: 11px; color: var(--fg-muted, #98a2b3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 240px; }',
      '.dtl-run-session { white-space: nowrap; font-size: 10.5px; color: var(--fg-muted, #98a2b3); opacity: 0.85; }',
      '.dtl-run-hist { color: #c3a6ff; }',
    ].join('\n')

    /** Inject the tab stylesheet once. */
    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /** GET/POST JSON, surfacing the server's error message. */
    function requestJson(url, options) {
      return fetch(url, options).then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + response.status)
          return body
        })
      })
    }

    /** Read one preference, falling back to a default. */
    function readPref(key, fallback) {
      try {
        var raw = window.localStorage.getItem(key)
        return raw === null ? fallback : JSON.parse(raw)
      } catch (error) {
        return fallback
      }
    }

    /** Persist one preference; a private-mode browser may refuse. */
    function writePref(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch (error) {
        // Preferences are a convenience; ignore the refusal.
      }
    }

    /** Human label of a run status. */
    function statusLabel(status) {
      if (status === 'running') return '运行中'
      if (status === 'passed') return '通过'
      if (status === 'failed') return '失败'
      if (status === 'canceled') return '已取消'
      return status || '未知'
    }

    /** Compact duration. */
    function durationText(meta) {
      var ms = typeof meta.durationMs === 'number' ? meta.durationMs : null
      if (ms === null && meta.status === 'running' && meta.startedAt) ms = Date.now() - meta.startedAt
      if (ms === null) return ''
      if (ms < 1000) return ms + 'ms'
      if (ms < 60000) return (ms / 1000).toFixed(1) + 's'
      var minutes = Math.floor(ms / 60000)
      return minutes + 'm' + Math.round((ms - minutes * 60000) / 1000) + 's'
    }

    /** Keep only lines the "failures only" filter should show. */
    function isFailureLine(line) {
      var kind = String(line.kind || '')
      // The grammars keep the old kinds (package-fail, build) and add their own
      // suite-level ones, so match the shape instead of a fixed list.
      if (kind === 'fail' || kind === 'error' || kind === 'build' || kind === 'panic') return true
      return /-fail$/.test(kind)
    }

    /** Last path segment, for the file-follow chips. */
    function baseName(path) {
      var parts = String(path || '').split('/')
      return parts[parts.length - 1] || path
    }

    /** Run id without its "run_" prefix, for the batch chips. */
    function shortId(id) {
      return String(id || '').replace(/^run_/, '')
    }

    /** A conversation id without its "ses_" prefix, for unnamed conversations. */
    function shortSessionId(id) {
      return String(id || '').replace(/^(session|sess|ses)_/, '').slice(0, 8)
    }

    /**
     * Display label of one conversation: the host title when there is one,
     * otherwise a short id. Never throws on a missing or partial record.
     */
    function sessionLabelText(id, label) {
      if (label) return String(label)
      if (!id) return '未知对话'
      return '对话 ' + shortSessionId(id)
    }

    /** The id field of a session record; the host and the routes disagree on the name. */
    function sessionIdOf(item) {
      if (!item) return null
      return item.id || item.sessionId || null
    }

    /** Look one conversation up in the list the host returned. */
    function findSession(sessions, id) {
      if (!id || !sessions || sessions.length === 0) return null
      for (var i = 0; i < sessions.length; i++) {
        if (sessionIdOf(sessions[i]) === id) return sessions[i]
      }
      return null
    }

    /** Label for a run's conversation, preferring the session list over the run's own copy. */
    function labelForSession(sessions, id, fallbackLabel) {
      var found = findSession(sessions, id)
      if (found) return sessionLabelText(id, found.label || found.sessionLabel)
      return sessionLabelText(id, fallbackLabel)
    }

    /** Shorten a chip label without cutting mid-character. */
    function clip(text, max) {
      var value = text === null || text === undefined ? '' : String(text)
      if (value.length <= max) return value
      return value.slice(0, max - 1) + '…'
    }

    /** The "/runs" query for one view; a session view without a session is "all". */
    function runsUrl(scope, sessionId) {
      var bySession = scope === 'session' && Boolean(sessionId)
      var url = ROUTE + '/runs?scope=' + (bySession ? 'session' : 'all')
      if (bySession) url += '&sessionId=' + encodeURIComponent(sessionId)
      return url
    }

    // -------------------------------------------------------------------------
    // Runner descriptors (GET /test-live/runners).
    //
    // The host's projection is deliberately small — id, label, language,
    // selectionPlaceholder, flags, labels, available, reason — so every reader
    // below is tolerant about the exact shape. An older host serves 404 and the
    // panel then behaves exactly like the pre-runner version.
    // -------------------------------------------------------------------------

    /** Shorthand for Object.prototype.hasOwnProperty. */
    function hasOwn(object, key) {
      return Object.prototype.hasOwnProperty.call(object, key)
    }

    /**
     * The runner the user picked, or null. The value is JSON-encoded like the
     * other preferences, but a bare string is accepted too.
     */
    function readRunnerPref() {
      try {
        var raw = window.localStorage.getItem(PREF_RUNNER)
        if (raw === null) return null
        if (raw.charAt(0) === '"') {
          var parsed = JSON.parse(raw)
          return typeof parsed === 'string' && parsed !== '' ? parsed : null
        }
        return raw === '' ? null : raw
      } catch (error) {
        return null
      }
    }

    /** A descriptor field that may sit on the entry or on its `selection` block. */
    function runnerField(entry, key, fallback) {
      if (entry) {
        if (entry[key] !== undefined && entry[key] !== null) return entry[key]
        var selection = entry.selection
        if (selection && typeof selection === 'object' && selection[key] !== undefined && selection[key] !== null) {
          return selection[key]
        }
      }
      return fallback
    }

    /** Well-formed flag rows of one descriptor, in descriptor order. */
    function runnerFlagList(entry) {
      if (!entry || !Array.isArray(entry.flags)) return []
      var list = []
      for (var i = 0; i < entry.flags.length; i++) {
        var flag = entry.flags[i]
        if (flag && typeof flag.id === 'string' && flag.id !== '') list.push(flag)
      }
      return list
    }

    /** Placeholder of the target input; an empty string means "no target row". */
    function runnerPlaceholder(entry) {
      if (!entry) return ''
      var value = entry.selectionPlaceholder
      if (value === undefined || value === null) value = runnerField(entry, 'placeholder', '')
      return value === undefined || value === null ? '' : String(value)
    }

    /** 'packages'|'files'|'nodeids'|'none'; a missing mode is inferred. */
    function runnerSelectionMode(entry) {
      var explicit = runnerField(entry, 'mode', null)
      if (explicit === null) explicit = runnerField(entry, 'selectionMode', null)
      if (explicit !== null && explicit !== '') return String(explicit)
      return runnerPlaceholder(entry) === '' ? 'none' : 'targets'
    }

    /**
     * Hint shown next to the target input. The projection carries two of them:
     * `selectionHint` is about targets ("相对文件路径…"), `hint` is about the
     * command ("pnpm exec vitest run，-timeout 不进 argv"). The target row wants
     * the first one; falling back to the second (or to the descriptor's own
     * `selection.hint`) keeps a narrower host working.
     */
    function runnerHint(entry) {
      if (!entry) return ''
      var text = runnerField(entry, 'selectionHint', null)
      if (text === null) text = runnerField(entry, 'hint', '')
      return text === undefined || text === null ? '' : String(text)
    }

    /** Target separator of one descriptor; the default is a comma. */
    function runnerSeparator(entry) {
      var separator = runnerField(entry, 'separator', ',')
      return typeof separator === 'string' && separator !== '' ? separator : ','
    }

    /** Noun the suite counts are labelled with: 包 / 文件 / 用例. */
    function suiteWord(entry, fallback) {
      var labels = entry && entry.labels
      if (labels && typeof labels.suite === 'string' && labels.suite !== '') return labels.suite
      return fallback || '包'
    }

    /** Command prefix of the empty-state example, '' when unknown. */
    function runnerPrefix(entry) {
      if (!entry) return ''
      if (typeof entry.command === 'string' && entry.command !== '') return entry.command
      var known = RUNNER_PREFIX[entry.id]
      return typeof known === 'string' ? known : ''
    }

    /** `go test ./...`-style example for the empty state; '' when unknown. */
    function runnerExample(entry) {
      var prefix = runnerPrefix(entry)
      if (prefix === '') return ''
      var placeholder = runnerPlaceholder(entry)
      if (placeholder === '' || runnerSelectionMode(entry) === 'none') return prefix
      return prefix + ' ' + placeholder
    }

    /** Split the target text on the descriptor's separator. */
    function splitTargets(text, separator) {
      var raw = text === null || text === undefined ? '' : String(text)
      var sep = typeof separator === 'string' && separator !== '' ? separator : ','
      // A pasted column of targets is common, so a comma list splits on newlines too.
      var parts = sep === ',' && raw.indexOf('\n') >= 0 ? raw.split(/[\r\n,]+/) : raw.split(sep)
      var list = []
      for (var i = 0; i < parts.length; i++) {
        var item = parts[i].trim()
        if (item !== '') list.push(item)
      }
      return list
    }

    /** The catalogue entry of one runner id, or null. */
    function findRunner(entries, id) {
      if (!entries || !id) return null
      for (var i = 0; i < entries.length; i++) {
        if (entries[i] && entries[i].id === id) return entries[i]
      }
      return null
    }

    /** First runner the host did not mark unavailable, else null. */
    function firstAvailableRunner(entries) {
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i]
        if (entry && entry.id && entry.available !== false) return entry.id
      }
      return null
    }

    /**
     * Which runner the panel starts on: the stored choice, then the host's
     * defaultRunner, then the first usable runner, then "auto".
     */
    function resolveRunner(entries, defaultRunner, stored) {
      var list = entries || []
      if (stored === 'auto') return 'auto'
      var storedEntry = findRunner(list, stored)
      if (storedEntry && storedEntry.available !== false) return stored
      if (defaultRunner === undefined || defaultRunner === null || defaultRunner === '' || defaultRunner === 'auto') {
        return 'auto'
      }
      var defaultEntry = findRunner(list, defaultRunner)
      if (defaultEntry && defaultEntry.available !== false) return defaultRunner
      return firstAvailableRunner(list) || 'auto'
    }

    /** Checked-set a descriptor starts with: `flag.default` for each flag. */
    function defaultFlags(entry, verbosePreference) {
      var list = runnerFlagList(entry)
      var set = {}
      for (var i = 0; i < list.length; i++) {
        set[list[i].id] = list[i].default === true
      }
      // The panel has always remembered the -v choice under its own key.
      if (hasOwn(set, 'verbose') && typeof verbosePreference === 'boolean') {
        set.verbose = verbosePreference
      }
      return set
    }

    /** Shallow equality of two checked-sets, so an effect does not thrash state. */
    function sameFlags(left, right) {
      var key
      var mine = 0
      for (key in left) if (hasOwn(left, key)) mine++
      var theirs = 0
      for (key in right) if (hasOwn(right, key)) theirs++
      if (mine !== theirs) return false
      for (key in left) {
        if (!hasOwn(left, key)) continue
        if (!hasOwn(right, key) || left[key] !== right[key]) return false
      }
      return true
    }

    /**
     * The `flags` field of a run request: `{flagId: boolean}` over every flag of
     * the descriptor, checked or not.
     *
     * The wire shape is an object, not a list of ids: `buildRunArgv` reads
     * `flags[id] === true` and the route refuses an array outright, so explicit
     * booleans are the only encoding that also expresses "a default-on flag the
     * user switched off". An empty object is sent for `auto`, where the panel has
     * no descriptor to speak for — the host then applies the detected runner's
     * own defaults.
     */
    function flagMap(entry, set) {
      var list = runnerFlagList(entry)
      var map = {}
      for (var i = 0; i < list.length; i++) {
        map[list[i].id] = Boolean(set && set[list[i].id] === true)
      }
      return map
    }

    /** The legacy `verbose` boolean, taken from the descriptor when it has one. */
    function verboseFlag(set, fallback) {
      if (set && hasOwn(set, 'verbose')) return set.verbose === true
      return fallback === true
    }

    /** Stored target text of one runner; the pre-runner key seeds the Go runner. */
    function readTargetsPref(runnerId) {
      var own = readPref(PREF_TARGETS + ':' + runnerId, null)
      if (typeof own === 'string') return own
      if (runnerId === 'go') {
        var legacy = readPref(PREF_PACKAGES, null)
        if (typeof legacy === 'string') return legacy
      }
      return ''
    }

    /**
     * Summary buckets under the new `suites` name, with the pre-rename
     * `packages` field accepted for runs restored from an old history file.
     */
    function suiteBuckets(summary) {
      if (!summary || typeof summary !== 'object') return null
      var raw = summary.suites || summary.packages || null
      if (!raw || typeof raw !== 'object') return null
      return {
        ok: Array.isArray(raw.ok) ? raw.ok : [],
        fail: Array.isArray(raw.fail) ? raw.fail : [],
        noTest: Array.isArray(raw.noTest) ? raw.noTest : [],
      }
    }

    /** Test counters, defaulting every missing number to zero. */
    function testCounts(summary) {
      var raw = summary && summary.tests && typeof summary.tests === 'object' ? summary.tests : {}
      return {
        pass: typeof raw.pass === 'number' ? raw.pass : 0,
        fail: typeof raw.fail === 'number' ? raw.fail : 0,
        skip: typeof raw.skip === 'number' ? raw.skip : 0,
      }
    }

    /**
     * "Which runner actually ran" for the meta line. `detectReason` is only
     * written when a run resolved `auto`, so it is the honest signal that the
     * user did not pick this runner by hand.
     */
    function runnerLine(meta, entries) {
      if (!meta || !meta.runner) return ''
      var id = String(meta.runner)
      if (id === 'auto') return 'runner：自动识别'
      var entry = findRunner(entries, id)
      var label = meta.runnerLabel || (entry && entry.label) || id
      if (meta.detectReason) return 'runner：自动识别 → ' + label
      return 'runner：' + label
    }

    /** One rendered log line. */
    function LogLine(props) {
      var line = props.line
      return h('div', {
        className: 'dtl-line',
        'data-kind': line.kind,
        'data-provisional': line.provisional ? 'true' : 'false',
      },
      h('span', { className: 'dtl-seq' }, String(line.seq)),
      h('span', null, line.text === '' ? '\u00a0' : line.text))
    }

    /** Status badge. */
    function StatusBadge(props) {
      return h('span', { className: 'dtl-badge', 'data-status': props.status }, statusLabel(props.status))
    }

    /** The sidebar panel. */
    function TestLiveBody(props) {
      // The sidebar slot may render us with no props at all, so never trust the
      // shape: a `props.sessionId` that is missing just means "all conversations".
      var safeProps = props && typeof props === 'object' ? props : {}
      var injectedSessionId =
        typeof safeProps.sessionId === 'string' && safeProps.sessionId !== ''
          ? safeProps.sessionId
          : null

      var runsState = React.useState([])
      var runs = runsState[0]
      var setRuns = runsState[1]
      // The strip scrolls horizontally; keep the newest run (host order) in view.
      var runsRef = React.useRef(null)
      var currentState = React.useState(null)
      var current = currentState[0]
      var setCurrent = currentState[1]
      var linesState = React.useState([])
      var lines = linesState[0]
      var setLines = linesState[1]
      var runState = React.useState(null)
      var run = runState[0]
      var setRun = runState[1]
      var errorState = React.useState(null)
      var error = errorState[0]
      var setError = errorState[1]
      var connectedState = React.useState(false)
      var connected = connectedState[0]
      var setConnected = connectedState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      // Which layer of the log is on screen: every conversation, or one of them.
      var scopePref = readPref('dsh-test-live:scope', null)
      var scopeState = React.useState(scopePref === 'session' && injectedSessionId !== null ? 'session' : 'all')
      var scope = scopeState[0]
      var setScope = scopeState[1]
      // The conversation picked in the dropdown; null means "the hosting one".
      var targetState = React.useState(null)
      var targetSession = targetState[0]
      var setTargetSession = targetState[1]
      var sessionsState = React.useState([])
      var sessions = sessionsState[0]
      var setSessions = sessionsState[1]
      // True once the user (or a stored preference) chose a view: only then may the
      // panel ignore the host's defaultScope.
      var scopeChosenRef = React.useRef(scopePref === 'session' || scopePref === 'all')
      // scope=session 时真正过滤的对话：下拉里选的，否则就是本对话。
      var activeSessionId = scope === 'session' ? targetSession || injectedSessionId : null
      var autoState = React.useState(readPref('dsh-test-live:autoScroll', true))
      var autoScroll = autoState[0]
      var setAutoScroll = autoState[1]
      var onlyFailState = React.useState(readPref('dsh-test-live:onlyFailures', false))
      var onlyFail = onlyFailState[0]
      var setOnlyFail = onlyFailState[1]
      // The target text: package patterns, file paths or node ids, per runner.
      // Pre-runner installs stored it under the "packages" key, which still seeds
      // the default so an upgrade keeps the patterns the user typed.
      var targetsState = React.useState(readPref(PREF_PACKAGES, './...'))
      var targets = targetsState[0]
      var setTargets = targetsState[1]
      var followState = React.useState(readPref('dsh-test-live:followPath', ''))
      var followPath = followState[0]
      var setFollowPath = followState[1]
      var verboseState = React.useState(readPref('dsh-test-live:verbose', true))
      var verbose = verboseState[0]
      var setVerbose = verboseState[1]
      // --- runner descriptors (null until /runners answers; null = old host) --
      var catalogState = React.useState(null)
      var catalog = catalogState[0]
      var setCatalog = catalogState[1]
      var runnerState = React.useState(null)
      var runnerId = runnerState[0]
      var setRunnerId = runnerState[1]
      var flagsState = React.useState({})
      var flags = flagsState[0]
      var setFlags = flagsState[1]
      // Which runner the target text currently belongs to, so switching runners
      // swaps in that runner's stored targets exactly once.
      var targetsOwnerRef = React.useRef(null)

      var indexRef = React.useRef({})       // seq -> index into lines
      var logRef = React.useRef(null)
      var sourceRef = React.useRef(null)
      var lastSeqRef = React.useRef(0)
      // 用户手动选了旧批次时非空：轮询只更新列表，不抢走他正在看的日志。
      var pinnedRef = React.useRef(null)

      /** Replace or append one streamed line. */
      var ingest = React.useCallback(function (entry) {
        setLines(function (previous) {
          var index = indexRef.current
          var existing = index[entry.seq]
          if (typeof existing === 'number' && previous[existing] && previous[existing].seq === entry.seq) {
            var next = previous.slice()
            next[existing] = entry
            return next
          }
          var appended = previous.concat([entry])
          index[entry.seq] = appended.length - 1
          if (appended.length > MAX_RENDERED) {
            var trimmed = appended.slice(appended.length - MAX_RENDERED)
            var rebuilt = {}
            for (var i = 0; i < trimmed.length; i++) rebuilt[trimmed[i].seq] = i
            indexRef.current = rebuilt
            return trimmed
          }
          return appended
        })
        if (entry.seq > lastSeqRef.current) lastSeqRef.current = entry.seq
      }, [])

      React.useEffect(function () {
        var el = runsRef.current
        if (el) el.scrollLeft = 0
      }, [runs])

      /**
       * Load the run list plus the conversation roster for one view.
       * Passing the view explicitly lets the click handler fetch before the state
       * from that click has been rendered.
       */
      var refreshRuns = React.useCallback(function (scopeArg, sessionArg) {
        var useScope = scopeArg === 'session' || scopeArg === 'all' ? scopeArg : scope
        var useSession = useScope === 'session' ? sessionArg || activeSessionId || null : null
        return requestJson(runsUrl(useScope, useSession)).then(function (body) {
          var list = body && Array.isArray(body.runs) ? body.runs : []
          setRuns(list)
          setSessions(body && Array.isArray(body.sessions) ? body.sessions : [])
          // First screen without a stored choice: follow the host's default view,
          // unless that view cannot be rendered without a session id.
          if (!scopeChosenRef.current) {
            var hostDefault = body && body.defaultScope === 'session' ? 'session' : 'all'
            if (hostDefault === 'session' && !injectedSessionId) hostDefault = 'all'
            if (hostDefault !== useScope) setScope(hostDefault)
          }
          return list
        })
      }, [scope, activeSessionId, injectedSessionId])

      /** Bind the panel to one run and stream it; a null meta clears the view. */
      var openRun = React.useCallback(function (meta) {
        if (sourceRef.current) {
          sourceRef.current.close()
          sourceRef.current = null
        }
        if (!meta || !meta.id) {
          indexRef.current = {}
          lastSeqRef.current = 0
          setLines([])
          setRun(null)
          setCurrent(null)
          setError(null)
          setConnected(false)
          return
        }
        indexRef.current = {}
        lastSeqRef.current = 0
        setLines([])
        setRun(meta)
        setCurrent(meta.id)
        setError(null)
        setConnected(false)
        var source = new EventSource(ROUTE + '/stream?id=' + encodeURIComponent(meta.id) + '&since=-1')
        sourceRef.current = source
        source.onopen = function () { setConnected(true) }
        source.onmessage = function (event) {
          try {
            ingest(JSON.parse(event.data))
          } catch (parseError) {
            // A truncated frame must not break the stream.
          }
        }
        source.addEventListener('status', function (event) {
          try {
            setRun(JSON.parse(event.data))
          } catch (parseError) {
            // Same rationale.
          }
          setConnected(false)
          source.close()
          if (sourceRef.current === source) sourceRef.current = null
          refreshRuns().catch(function () {})
        })
        source.onerror = function () { setConnected(false) }
      }, [ingest, refreshRuns])

      // First screen and every view switch: fetch the list for this view and bind
      // the newest (running first) run. A manual pin only shields the poll below.
      React.useEffect(function () {
        var alive = true
        refreshRuns().then(function (list) {
          if (!alive) return
          var running = null
          for (var i = 0; i < list.length; i++) {
            if (list[i].status === 'running') { running = list[i]; break }
          }
          openRun(running || list[0] || null)
        }).catch(function (loadError) {
          if (!alive) return
          setError(loadError && loadError.message ? loadError.message : String(loadError))
        })
        return function () {
          alive = false
          if (sourceRef.current) {
            sourceRef.current.close()
            sourceRef.current = null
          }
        }
      }, [scope, activeSessionId])

      /**
       * Ask the host for its runner catalogue. An older host answers 404 (or an
       * empty list) and the panel simply stays on the pre-runner layout: no
       * dropdown, no descriptor flags, `packages` on POST. The probe is silent
       * on purpose — a missing endpoint is not an error the user must see.
       *
       * Registered after the run-list effect on purpose: the list is the panel's
       * primary fetch and must stay first.
       */
      React.useEffect(function () {
        var alive = true
        requestJson(ROUTE + '/runners').then(function (body) {
          if (!alive) return
          var raw = body && Array.isArray(body.runners) ? body.runners : (Array.isArray(body) ? body : null)
          if (!raw) return
          var list = []
          for (var i = 0; i < raw.length; i++) {
            var entry = raw[i]
            if (entry && typeof entry.id === 'string' && entry.id !== '') list.push(entry)
          }
          // An empty catalogue is the same non-event as a 404.
          if (list.length === 0) return
          // The host is the only authority on availability: `allowScriptRunners`
          // is already folded into each entry's `available`/`reason`, and the
          // projection has no scriptRunner field to second-guess it with.
          var hostDefault = body && typeof body.defaultRunner === 'string' ? body.defaultRunner : 'auto'
          setCatalog({ runners: list })
          setRunnerId(resolveRunner(list, hostDefault, readRunnerPref()))
        }).catch(function () {
          // No catalogue: the legacy layout still works, so nothing to report.
        })
        return function () { alive = false }
      }, [])

      // Checkbox state follows the chosen descriptor: `flag.default` per flag.
      React.useEffect(function () {
        if (!catalog || !runnerId) return
        var entry = findRunner(catalog.runners, runnerId)
        var next = defaultFlags(entry, readPref(PREF_VERBOSE, true))
        setFlags(function (previous) { return sameFlags(previous, next) ? previous : next })
      }, [catalog, runnerId])

      // Each runner remembers its own target text; switching swaps it in once.
      React.useEffect(function () {
        if (!catalog || !runnerId) return
        if (targetsOwnerRef.current === runnerId) return
        targetsOwnerRef.current = runnerId
        setTargets(readTargetsPref(runnerId))
      }, [catalog, runnerId])

      // Close the stream when the whole panel goes away.
      React.useEffect(function () {
        return function () {
          if (sourceRef.current) {
            sourceRef.current.close()
            sourceRef.current = null
          }
        }
      }, [])

      // Discover runs started elsewhere (a tool call, another tab).
      React.useEffect(function () {
        var timer = setInterval(function () {
          refreshRuns().then(function (list) {
            if (list.length === 0) return
            var newest = list[0]
            var watching = current
            if (newest.id === watching) {
              // Same run: refresh only when something actually moved, otherwise the
              // 2.5s poll would re-render the panel forever.
              if (run === null || run.status !== newest.status || run.lastSeq !== newest.lastSeq) setRun(newest)
              return
            }
            // 手动选中了旧批次：只要它还在列表里就不抢焦点。
            if (pinnedRef.current !== null) {
              var stillListed = false
              for (var i = 0; i < list.length; i++) {
                if (list[i].id === pinnedRef.current) stillListed = true
              }
              if (stillListed) return
              pinnedRef.current = null
            }
            openRun(newest)
          }).catch(function () {})
        }, 2500)
        return function () { clearInterval(timer) }
      }, [current, run, refreshRuns, openRun])

      // Auto-scroll while new lines arrive.
      React.useEffect(function () {
        if (!autoScroll) return
        var node = logRef.current
        if (node) node.scrollTop = node.scrollHeight
      }, [lines, autoScroll])

      /**
       * Switch the list between every conversation and one of them.
       * `sessionId` only matters for scope 'session'; it defaults to this dialog.
       */
      function chooseScope(next, sessionId) {
        var resolved = next === 'session' ? sessionId || injectedSessionId || null : null
        if (next === 'session' && resolved === null) next = 'all'
        scopeChosenRef.current = true
        writePref('dsh-test-live:scope', next)
        // A new view invalidates the old manual pin.
        pinnedRef.current = null
        var sameView = next === scope && (next === 'all' || resolved === activeSessionId)
        setScope(next)
        setTargetSession(next === 'session' ? resolved : null)
        if (sameView) {
          // Same view as before: state won't change, so refresh by hand.
          refreshRuns(next, resolved).catch(function () {})
        }
      }

      /** Dropdown handler: '' means every conversation. */
      function chooseSession(event) {
        var value = event && event.target ? event.target.value : ''
        if (!value) chooseScope('all')
        else chooseScope('session', value)
      }

      /**
       * A run started here belongs to this dialog. If the list is narrowed to
       * another conversation, jump back so the new run is actually visible.
       */
      function followIntoView() {
        if (scope !== 'session' || injectedSessionId === null) return
        if (activeSessionId === injectedSessionId) return
        chooseScope('session', injectedSessionId)
      }

      /** Pick a runner from the dropdown; the choice survives a reload. */
      function chooseRunner(event) {
        var value = event && event.target ? String(event.target.value === undefined ? '' : event.target.value) : ''
        if (value === '') return
        setRunnerId(value)
        writePref(PREF_RUNNER, value)
      }

      /** Flip one descriptor flag; the -v choice also keeps its old key. */
      function toggleFlag(id, checked) {
        setFlags(function (previous) {
          var next = {}
          for (var key in previous) if (hasOwn(previous, key)) next[key] = previous[key]
          next[id] = checked
          return next
        })
        if (id === 'verbose') writePref(PREF_VERBOSE, checked)
      }

      /**
       * Start a run with the current options.
       *
       * With a catalogue the body is the descriptor shape (runner / targets /
       * flags) and keeps `verbose` so an old route still understands it; without
       * one it is byte-for-byte the pre-runner body.
       */
      function startRun() {
        var entry = catalog ? findRunner(catalog.runners, runnerId || 'auto') : null
        var targetsList = splitTargets(targets, catalog ? runnerSeparator(entry) : ',')
        var body
        if (catalog) {
          body = {
            runner: runnerId || 'auto',
            flags: flagMap(entry, flags),
            verbose: verboseFlag(flags, verbose),
            sessionId: injectedSessionId,
          }
          // No targets means "the runner's own default"; the host fills it in, so
          // the panel never invents a pattern for a runner it does not know yet.
          if (targetsList.length > 0) body.targets = targetsList
        } else {
          body = { packages: targetsList, verbose: verbose, sessionId: injectedSessionId }
        }
        setBusy(true)
        setError(null)
        requestJson(ROUTE + '/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // The host files this run under the conversation that asked for it.
          body: JSON.stringify(body),
        }).then(function (meta) {
          if (catalog) writePref(PREF_TARGETS + ':' + (runnerId || 'auto'), targets)
          else writePref(PREF_PACKAGES, targets)
          pinnedRef.current = null
          followIntoView()
          openRun(meta)
          refreshRuns().catch(function () {})
        }).catch(function (startError) {
          setError(startError.message)
        }).then(function () { setBusy(false) })
      }

      /** Follow a log file written by an external command. */
      function startFollow() {
        var target = followPath.trim()
        if (target === '') return
        setBusy(true)
        setError(null)
        requestJson(ROUTE + '/follow', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: target, sessionId: injectedSessionId }),
        }).then(function (meta) {
          writePref('dsh-test-live:followPath', target)
          pinnedRef.current = null
          followIntoView()
          openRun(meta)
          refreshRuns().catch(function () {})
        }).catch(function (followError) {
          setError(followError.message)
        }).then(function () { setBusy(false) })
      }

      /** Stop the currently bound run. */
      function stopRun() {
        if (!current) return
        setBusy(true)
        requestJson(ROUTE + '/cancel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: current }),
        }).catch(function (cancelError) {
          setError(cancelError.message)
        }).then(function () { setBusy(false) })
      }

      /** Switch the log view to one batch; picking the newest resumes following. */
      function pickRun(item) {
        var newest = runs.length > 0 ? runs[0] : null
        pinnedRef.current = newest !== null && newest.id === item.id ? null : item.id
        if (item.id === current) return
        openRun(item)
      }

      var running = run !== null && run.status === 'running'
      var visible = onlyFail ? lines.filter(isFailureLine) : lines
      var summary = run && run.summary ? run.summary : null
      var viewSummary =
        scope === 'all'
          ? runs.length + ' 条 · ' + sessions.length + ' 个对话'
          : (activeSessionId === injectedSessionId
              ? '本对话 '
              : clip(labelForSession(sessions, activeSessionId, null), 12) + ' ') + runs.length + ' 条'

      // --- runner-driven shaping --------------------------------------------
      // `withRunners` is false for an old host (404), an empty catalogue, or a
      // fetch that never landed: every branch below then reproduces the layout
      // and the wording the panel had before runners existed.
      var entries = catalog && Array.isArray(catalog.runners) ? catalog.runners : null
      var withRunners = entries !== null
      var activeId = withRunners ? runnerId || 'auto' : null
      var activeEntry = withRunners ? findRunner(entries, activeId) : null
      var activeMode = withRunners ? (activeId === 'auto' ? 'auto' : runnerSelectionMode(activeEntry)) : 'legacy'
      // "auto" is not a selection mode of its own: the host decides after it looks
      // at the repository, so the target row stays until then.
      var showTargetRow = !withRunners || activeMode !== 'none'
      var targetPlaceholder = withRunners && activeMode !== 'auto' && activeEntry
        ? runnerPlaceholder(activeEntry) || './...'
        : './...'
      var targetHint = withRunners && activeMode !== 'auto' ? runnerHint(activeEntry) : ''
      var activeFlags = withRunners && activeMode !== 'auto' ? runnerFlagList(activeEntry) : []
      var activeReason = activeEntry && activeEntry.available === false
        ? String(activeEntry.reason || '该 runner 不可用')
        : ''
      var emptyExample = withRunners && activeMode !== 'auto' ? runnerExample(activeEntry) : 'go test ./...'
      var runRunnerText = runnerLine(run, entries)
      // The summary of the open run, read through one tolerant accessor pair.
      var activeBuckets = run ? suiteBuckets(summary) : null
      var activeSuiteWord = suiteWord(findRunner(entries, run && run.runner), '包')
      var activeTests = testCounts(summary)

      return h('div', { className: 'dtl-root' },
        h('div', { className: 'dtl-bar' },
          withRunners
            ? h('select', {
              className: 'dtl-select dtl-runner',
              'data-role': 'runner',
              value: activeId,
              title: activeReason || '测试 runner（「自动识别」按仓库内容选择）',
              onChange: chooseRunner,
            },
              h('option', { key: 'auto', value: 'auto' }, '自动识别'),
              entries.map(function (entry) {
                var off = entry.available === false
                return h('option', {
                  key: entry.id,
                  value: entry.id,
                  disabled: off,
                  title: off
                    ? String(entry.reason || '不可用')
                    : String(entry.language || entry.id),
                }, String(entry.label || entry.id))
              }),
            )
            : null,
          h('button', {
            className: 'dtl-primary',
            disabled: busy || running,
            onClick: startRun,
            title: '运行测试（' + (withRunners && activeId !== 'auto'
              ? String((activeEntry && activeEntry.label) || activeId)
              : withRunners ? '自动识别' : 'go test') + '）',
          }, running ? '运行中…' : '运行'),
          h('button', {
            disabled: busy || !running,
            onClick: stopRun,
            title: run && run.kind === 'file' ? '停止读取（写入方不受影响）' : '向进程组发 SIGTERM',
          }, running && run && run.kind === 'file' ? '停止跟随' : '取消'),
          h('button', {
            disabled: !run,
            onClick: function () {
              if (!run) return
              window.open(ROUTE + '/log?id=' + encodeURIComponent(run.id) + '&download=1', '_blank')
            },
            title: '下载完整日志',
          }, '日志'),
          h('button', { onClick: function () { refreshRuns().catch(function () {}) }, title: '刷新运行列表' }, '刷新'),
          withRunners
            ? (activeMode === 'auto'
              ? h('span', {
                className: 'dtl-note',
                title: '自动识别：按仓库里的文件挑 runner，开关取该 runner 的默认值',
              }, '自动识别')
              : activeFlags.map(function (flag) {
                var argv = Array.isArray(flag.argv) ? flag.argv.join(' ') : ''
                return h('label', {
                  key: flag.id,
                  className: 'dtl-check',
                  title: argv ? '传给测试命令：' + argv : String(flag.label || flag.id),
                },
                  h('input', {
                    type: 'checkbox',
                    'data-flag': flag.id,
                    checked: flags[flag.id] === true,
                    onChange: function (event) { toggleFlag(flag.id, event.target.checked) },
                  }), String(flag.label || flag.id))
              }))
            : h('label', { className: 'dtl-check', title: '传给 -v：逐条输出用例名' },
              h('input', {
                type: 'checkbox',
                checked: verbose,
                onChange: function (event) {
                  setVerbose(event.target.checked)
                  writePref(PREF_VERBOSE, event.target.checked)
                },
              }), '-v'),
          h('label', { className: 'dtl-check', title: '新日志到达时自动滚到底部' },
            h('input', {
              type: 'checkbox',
              checked: autoScroll,
              onChange: function (event) {
                setAutoScroll(event.target.checked)
                writePref('dsh-test-live:autoScroll', event.target.checked)
              },
            }), '跟随'),
          h('label', { className: 'dtl-check', title: '只看失败/构建错误' },
            h('input', {
              type: 'checkbox',
              checked: onlyFail,
              onChange: function (event) {
                setOnlyFail(event.target.checked)
                writePref('dsh-test-live:onlyFailures', event.target.checked)
              },
            }), '只看失败'),
          activeReason ? h('span', { className: 'dtl-note', title: activeReason }, activeReason) : null,
          run ? h(StatusBadge, { status: run.status }) : null,
          h('span', { className: 'dtl-grow' }),
          connected ? h('span', { className: 'dtl-check' }, '实时') : null,
        ),
        showTargetRow
          ? h('div', { className: 'dtl-bar', 'data-role': 'targets-row' },
            h('input', {
              type: 'text',
              className: 'dtl-grow',
              'data-role': 'targets',
              value: targets,
              placeholder: targetPlaceholder,
              spellCheck: false,
              title: targetHint || ('要运行的' + suiteWord(activeEntry, '包') +
                '，用「' + runnerSeparator(activeEntry) + '」分隔'),
              onChange: function (event) { setTargets(event.target.value) },
              onKeyDown: function (event) {
                if (event.key === 'Enter' && !busy && !running) startRun()
              },
            }),
            targetHint ? h('span', { className: 'dtl-note', title: targetHint }, targetHint) : null,
          )
          : null,
        h('div', { className: 'dtl-bar', 'data-role': 'follow-row' },
          h('input', {
            type: 'text',
            className: 'dtl-grow',
            'data-role': 'follow',
            value: followPath,
            placeholder: '跟随日志文件（如 fulltest.log）',
            spellCheck: false,
            onChange: function (event) { setFollowPath(event.target.value) },
            onKeyDown: function (event) {
              if (event.key === 'Enter' && !busy) startFollow()
            },
          }),
          h('button', { disabled: busy, onClick: startFollow, title: '实时 tail 这个文件（外部命令写入）' }, '跟随'),
        ),
        h('div', { className: 'dtl-bar dtl-filter' },
          h('span', { className: 'dtl-filter-label' }, '范围'),
          h('button', {
            className: 'dtl-seg' + (scope === 'all' ? ' is-active' : ''),
            onClick: function () { chooseScope('all') },
            title: '所有对话的测试记录',
          }, '全部'),
          injectedSessionId
            ? h('button', {
              className: 'dtl-seg' + (scope === 'session' && activeSessionId === injectedSessionId ? ' is-active' : ''),
              onClick: function () { chooseScope('session', injectedSessionId) },
              title: '只看本对话的运行记录',
            }, '本对话')
            : null,
          sessions.length > 1
            ? h('select', {
              className: 'dtl-select',
              value: scope === 'session' ? activeSessionId || '' : '',
              onChange: chooseSession,
              title: '按对话筛选',
            },
              h('option', { value: '' }, '全部对话'),
              sessions.map(function (item) {
                var sid = sessionIdOf(item) || ''
                var count = typeof item.count === 'number' ? item.count : 0
                return h('option', { key: sid, value: sid },
                  sessionLabelText(sid, item.label || item.sessionLabel) + ' · ' + count + ' 条')
              }),
            )
            : null,
          h('span', { className: 'dtl-grow' }),
          h('span', { className: 'dtl-check' }, viewSummary),
        ),
        runs.length > 0
          ? h('div', { className: 'dtl-runs', ref: runsRef }, runs.map(function (item) {
            var buckets = suiteBuckets(item.summary)
            var suiteOk = buckets ? buckets.ok.length : 0
            var failed = buckets
              ? buckets.fail.length > 0 || testCounts(item.summary).fail > 0
              : false
            // Each chip speaks the language of the runner that produced it.
            var word = suiteWord(findRunner(entries, item.runner), '包')
            var isFile = item.kind === 'file'
            var cwdPart = item.cwd ? clip(baseName(item.cwd), 16) : ''
            return h('button', {
              key: item.id,
              className: 'dtl-run' + (item.id === current ? ' is-current' : ''),
              'data-status': item.status,
              'data-archived': item.archived ? 'true' : 'false',
              title: labelForSession(sessions, item.sessionId, item.sessionLabel) +
                ' · ' + (item.cwd || '—') +
                ' · ' + item.command + ' ' + (item.args || []).join(' ') +
                (item.runner ? ' · runner ' + item.runner : '') +
                '  (' + item.id + ')',
              onClick: function () { pickRun(item) },
            },
              h('span', { className: 'dtl-run-id' }, isFile ? '📄 ' + baseName(item.file) : shortId(item.id)),
              h('span', { className: 'dtl-run-sub' },
                statusLabel(item.status) + ' · ' +
                (isFile ? item.buffered + ' 行' : suiteOk + ' ' + word) +
                (failed ? ' · 有失败' : '') +
                (item.durationMs ? ' · ' + durationText(item) : ''),
                item.archived ? h('span', { className: 'dtl-run-hist' }, ' · 历史') : null),
              h('span', { className: 'dtl-run-session' },
                clip(labelForSession(sessions, item.sessionId, item.sessionLabel), 18) +
                (cwdPart ? ' · ' + cwdPart : '')),
            )
          }))
          : null,
        error ? h('div', { className: 'dtl-error' }, error) : null,
        run ? h('div', { className: 'dtl-meta' },
          h('div', null, h('code', null, run.command + ' ' + (run.args || []).join(' '))),
          h('div', null,
            '对话 ' + labelForSession(sessions, run.sessionId, run.sessionLabel) +
            ' · ' + (run.cwd || '—') +
            ' · ' + run.id +
            (durationText(run) ? ' · ' + durationText(run) : '')),
          // What the host actually ran — the only place an "auto" choice is resolved.
          runRunnerText ? h('div', { className: 'dtl-note' }, runRunnerText) : null,
        ) : null,
        run
          ? h('div', { className: 'dtl-log', ref: logRef }, visible.map(function (line) {
            return h(LogLine, { key: line.seq, line: line })
          }))
          : h('div', { className: 'dtl-empty' },
            h('div', null, scope === 'session' ? '这个对话还没有运行记录。' : '还没有运行记录。'),
            h('div', null, '这里汇总所有对话的测试记录：别的对话里跑完的测试也会出现在这里。'),
            h('div', null, '点「运行」跑 ',
              // The example follows the selected runner; an unknown one keeps the
              // pre-runner Go wording. A runner whose argv the client cannot know
              // (generic: it runs config.command) gets a neutral phrase, not a lie.
              emptyExample
                ? h('code', null, emptyExample)
                : h('span', null, String((activeEntry && (activeEntry.label || activeEntry.id)) || '当前 runner') + ' 的默认命令'),
              '，或在对话里让我调用 ', h('code', null, 'test_live_run'), '。'),
            h('div', null, '运行中的输出会逐行出现在这里，结束后给出失败汇总。'),
          ),
        run && summary
          ? h('div', { className: 'dtl-foot' },
            activeBuckets
              ? h('span', null,
                activeSuiteWord + '：',
                h('b', null, String(activeBuckets.ok.length)), ' 通过',
                activeBuckets.fail.length
                  ? h('span', null, ' · ', h('b', null, String(activeBuckets.fail.length)), ' 失败')
                  : null,
                activeBuckets.noTest.length
                  ? h('span', null, ' · ', String(activeBuckets.noTest.length), ' 无用例')
                  : null)
              : null,
            (activeTests.pass + activeTests.fail + activeTests.skip) > 0
              ? h('span', null, '用例：', h('b', null, String(activeTests.pass)), ' 过 · ',
                h('b', null, String(activeTests.fail)), ' 败 · ',
                String(activeTests.skip), ' 跳过')
              : null,
            summary.buildErrors && summary.buildErrors.length
              ? h('span', null, '构建错误：', h('b', null, String(summary.buildErrors.length)))
              : null,
            run.truncated ? h('span', null, '（早期日志已截断）') : null,
            h('span', { style: { marginLeft: 'auto' } }, durationText(run)),
          )
          : null,
      )
    }

    exports.name = 'dsh-test-live-client'
    exports.inject = ['sidebarRightTabs', 'slots']

    /** Mount the sidebar tab. */
    exports.apply = function apply(ctx) {
      try {
        ensureStyles()
        ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: KIND,
          priority: 'extension',
          title: function () { return '测试日志' },
          guide: [{
            id: 'test-live',
            order: 45,
            title: function () { return '测试日志' },
            description: function () { return '实时查看测试运行输出与失败汇总'; },
          }],
        })
        ctx.slots.inject('sidebar.right.pane.tab', function () {
          return ctx.slots.register(
            { name: 'sidebar.right.pane.tab', key: TAB_ID },
            TestLiveBody,
          )
        })
        // Do NOT also call betterSidebar.registerTab(): dsh-better-sidebar mirrors
        // every native sidebarRightTabs registration into its own surface
        // (registerNativeSurface), so registering in both places shows the same
        // tab twice — one of them without a working body.
      } catch (error) {
        // A client half must never take the application boot down with it.
        var message = error && error.message ? error.message : String(error)
        document.documentElement.setAttribute('data-test-live-error', message)
        if (window.console && window.console.warn) {
          window.console.warn('dsh-test-live client: ' + message)
        }
      }
    }

    return module.exports
  },
})
