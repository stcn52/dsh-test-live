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
      if (line.kind === 'fail' || line.kind === 'package-fail' || line.kind === 'build' || line.kind === 'panic') return true
      return false
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
    function TestLiveBody() {
      var runsState = React.useState([])
      var runs = runsState[0]
      var setRuns = runsState[1]
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
      var autoState = React.useState(readPref('dsh-test-live:autoScroll', true))
      var autoScroll = autoState[0]
      var setAutoScroll = autoState[1]
      var onlyFailState = React.useState(readPref('dsh-test-live:onlyFailures', false))
      var onlyFail = onlyFailState[0]
      var setOnlyFail = onlyFailState[1]
      var packagesState = React.useState(readPref('dsh-test-live:packages', './...'))
      var packages = packagesState[0]
      var setPackages = packagesState[1]
      var followState = React.useState(readPref('dsh-test-live:followPath', ''))
      var followPath = followState[0]
      var setFollowPath = followState[1]
      var verboseState = React.useState(readPref('dsh-test-live:verbose', true))
      var verbose = verboseState[0]
      var setVerbose = verboseState[1]

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

      /** Load the run list. */
      var refreshRuns = React.useCallback(function () {
        return requestJson(ROUTE + '/runs').then(function (body) {
          var list = body && body.runs ? body.runs : []
          setRuns(list)
          return list
        })
      }, [])

      /** Bind the panel to one run and stream it. */
      var openRun = React.useCallback(function (meta) {
        if (!meta || !meta.id) return
        if (sourceRef.current) {
          sourceRef.current.close()
          sourceRef.current = null
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

      // Initial load: bind to the newest run, preferring a running one.
      React.useEffect(function () {
        refreshRuns().then(function (list) {
          var running = null
          for (var i = 0; i < list.length; i++) {
            if (list[i].status === 'running') { running = list[i]; break }
          }
          openRun(running || list[0] || null)
        }).catch(function (loadError) {
          setError(loadError.message)
        })
        return function () {
          if (sourceRef.current) sourceRef.current.close()
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

      /** Start a run with the current options. */
      function startRun() {
        var patterns = packages.split(',').map(function (item) { return item.trim() }).filter(Boolean)
        setBusy(true)
        setError(null)
        requestJson(ROUTE + '/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ packages: patterns, verbose: verbose }),
        }).then(function (meta) {
          writePref('dsh-test-live:packages', packages)
          pinnedRef.current = null
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
          body: JSON.stringify({ path: target }),
        }).then(function (meta) {
          writePref('dsh-test-live:followPath', target)
          pinnedRef.current = null
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

      return h('div', { className: 'dtl-root' },
        h('div', { className: 'dtl-bar' },
          h('button', {
            className: 'dtl-primary',
            disabled: busy || running,
            onClick: startRun,
            title: '运行测试（go test）',
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
          h('label', { className: 'dtl-check', title: '传给 -v：逐条输出用例名' },
            h('input', {
              type: 'checkbox',
              checked: verbose,
              onChange: function (event) {
                setVerbose(event.target.checked)
                writePref('dsh-test-live:verbose', event.target.checked)
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
          run ? h(StatusBadge, { status: run.status }) : null,
          h('span', { className: 'dtl-grow' }),
          connected ? h('span', { className: 'dtl-check' }, '实时') : null,
        ),
        h('div', { className: 'dtl-bar' },
          h('input', {
            type: 'text',
            className: 'dtl-grow',
            value: packages,
            placeholder: './...',
            spellCheck: false,
            onChange: function (event) { setPackages(event.target.value) },
            onKeyDown: function (event) {
              if (event.key === 'Enter' && !busy && !running) startRun()
            },
          }),
          h('button', { onClick: function () { refreshRuns().catch(function () {}) }, title: '刷新运行列表' }, '刷新'),
        ),
        h('div', { className: 'dtl-bar' },
          h('input', {
            type: 'text',
            className: 'dtl-grow',
            value: followPath,
            placeholder: '跟随日志文件（如 fulltest.log）：终端里 go test ./... | tee fulltest.log',
            spellCheck: false,
            onChange: function (event) { setFollowPath(event.target.value) },
            onKeyDown: function (event) {
              if (event.key === 'Enter' && !busy) startFollow()
            },
          }),
          h('button', { disabled: busy, onClick: startFollow, title: '实时 tail 这个文件（外部命令写入）' }, '跟随'),
        ),
        runs.length > 0
          ? h('div', { className: 'dtl-runs' }, runs.map(function (item) {
            var packagesOk = item.summary ? item.summary.packages.ok.length : 0
            var failed = item.summary && (item.summary.packages.fail.length > 0 || item.summary.tests.fail > 0)
            var isFile = item.kind === 'file'
            return h('button', {
              key: item.id,
              className: 'dtl-run' + (item.id === current ? ' is-current' : ''),
              'data-status': item.status,
              title: item.command + ' ' + (item.args || []).join(' ') + '  (' + item.id + ')',
              onClick: function () { pickRun(item) },
            },
              h('span', { className: 'dtl-run-id' }, isFile ? '📄 ' + baseName(item.file) : shortId(item.id)),
              h('span', { className: 'dtl-run-sub' },
                statusLabel(item.status) + ' · ' +
                (isFile ? item.buffered + ' 行' : packagesOk + ' 包') +
                (failed ? ' · 有失败' : '') +
                (item.durationMs ? ' · ' + durationText(item) : '')),
            )
          }))
          : null,
        error ? h('div', { className: 'dtl-error' }, error) : null,
        run ? h('div', { className: 'dtl-meta' },
          h('div', null, h('code', null, run.command + ' ' + (run.args || []).join(' '))),
          h('div', null, run.cwd + ' · ' + run.id + ' · ' + durationText(run)),
        ) : null,
        run
          ? h('div', { className: 'dtl-log', ref: logRef }, visible.map(function (line) {
            return h(LogLine, { key: line.seq, line: line })
          }))
          : h('div', { className: 'dtl-empty' },
            h('div', null, '还没有运行记录。'),
            h('div', null, '点「运行」跑 ', h('code', null, 'go test ./...'), '，或在对话里让我调用 ', h('code', null, 'test_live_run'), '。'),
            h('div', null, '运行中的输出会逐行出现在这里，结束后给出失败汇总。'),
          ),
        run && summary
          ? h('div', { className: 'dtl-foot' },
            h('span', null, '包：', h('b', null, String(summary.packages.ok.length)), ' 通过',
              summary.packages.fail.length ? h('span', null, ' · ', h('b', null, String(summary.packages.fail.length)), ' 失败') : null,
              summary.packages.noTest.length ? h('span', null, ' · ', String(summary.packages.noTest.length), ' 无用例') : null),
            (summary.tests.pass + summary.tests.fail + summary.tests.skip) > 0
              ? h('span', null, '用例：', h('b', null, String(summary.tests.pass)), ' 过 · ',
                h('b', null, String(summary.tests.fail)), ' 败 · ',
                String(summary.tests.skip), ' 跳过')
              : null,
            summary.buildErrors.length ? h('span', null, '构建错误：', h('b', null, String(summary.buildErrors.length))) : null,
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
