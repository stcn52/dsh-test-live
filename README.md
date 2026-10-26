# dsh-test-live

DSH 侧边栏「测试日志」页签：在 GUI 里跑测试，输出**逐行实时**出现，结束后给出失败汇总。
运行记录按**对话归属**而不是按项目绑定——同一个仓库可以从多个对话里跑测试，一个对话也可能在几个目录里工作，
面板汇总的是「这个宿主上所有对话的测试记录」，可以按对话筛。

0.3.0 起它不再只是 `go test` 的壳：runner 由一张**描述符表**驱动，Go、Vitest、Jest、`node --test`、pytest、
`package.json` 里的 test 脚本、以及配置好的自定义命令都能跑；可以在面板里选 runner，也可以交给「自动识别」
按项目目录挑。每种 runner 有自己的命令、目标写法、开关，以及一套读懂它输出的语法和计数单位。

![测试日志面板](docs/screenshot.png)

> 截图用示例数据渲染（`/workspace/service`、`github.com/example/*` 均为占位），配色与布局来自 `src/client/index.js`。
> 但**截图仍是 0.2.0 的界面**：没有 0.3.0 的 runner 下拉，没有随 runner 变化的目标占位与开关，也没有
> 「全部 / 本对话」筛选栏与对话下拉。它只说明面板长什么样，**不能**当作新 UI 的说明；以实际界面为准。

## 它解决什么

跑一次测试的输出有三个问题：跑得久、被 `| tail` 吞掉、失败信息埋在几百行里。
这个插件把测试进程放进**独立进程组**，通过 SSE 把每一行推给浏览器：

- **不碰宿主**：子进程 `detached` 成自己的进程组，取消/超时对整组发信号；测试框架再派生的进程
  （例如 `go test` 编译出的测试二进制）也一起死，不会变成孤儿，也不会误伤宿主所在进程组。
- **实时**：进程还在跑就能看到逐行输出（Go 的 `=== RUN` / `ok` / `FAIL`，其他 runner 的 `✔` / `✖` /
  `PASSED` / `Tests 3 passed` …），不用等结束。
- **有颜色**：按行分类着色——用例开始/通过/失败/跳过、套件结果、构建或加载错误、panic。
  分类规则每种 runner 一套；不认识的输出原样显示。
- **有汇总**：套件通过/失败/无用例数、用例通过/失败/跳过数、构建错误数、耗时。套件的单位跟着 runner 走：
  Go 是「包」，vitest/jest 是「文件」，pytest 与 `node --test` 是「用例」；工具文本里对应
  packages / files / suites / test files。
- **只看失败**：一键过滤，失败行保留完整上下文。
- **可取消**：面板上的「取消」对进程组发 SIGTERM（3 秒后 SIGKILL）。
- **按对话归属**：一次运行属于「启动它的那个对话」，不属某个项目目录。运行目录取**该对话自己的工作目录**；
  面板显示每条记录属于哪个对话，并可按对话筛选。
- **跨对话汇总**：别的对话里跑完的测试也出现在同一个面板里，跑着的会标「运行中」。
- **历史留档**：结束的运行写进宿主级状态文件，宿主重启后仍在（面板里标「· 历史」）。
- **对话联动**：模型调用 `test_live_run` 启动的运行同样在这个面板里实时显示；工具默认不等待，
  对话不会被一个卡住的测试拖住。
- **跟随文件**：任意来源（终端里 `pytest -v | tee fulltest.log`、bash 调用、CI）只要写进文件，
  面板就能 tail 它——同一条 SSE 通道、同一套着色与汇总，不受「谁启动的」限制。

## 支持的 runner 与自动识别

runner 的描述符集中在 `src/core/runners.js`：一个 id 决定可执行文件与固定前置参数、目标选择器的形态、
用例名过滤 flag、可用开关、timeout、探测规则，以及解析输出用的语法。这张表是数据，argv 由唯一的纯函数
`buildRunArgv` 拼出来——所以 Go 的 argv 仍与描述符出现之前逐字节一致。

### 自动识别怎么工作

- **什么时候识别**：配置写 `runner: 'auto'`（包内 `cordis.patch.yml` 就是），或单次请求显式传 `runner: 'auto'`。
- **优先级**：单次请求的 `runner` > 配置里的具体 id > 识别。显式指定的 runner 永远不会被识别结果覆盖。
- **看哪个目录**：这次运行的工作目录——优先发起运行的对话自己的 cwd，取不到才用配置的 `cwd`，
  再取不到用宿主进程目录。
- **探测顺序**（先命中先赢）：`go.mod` → `package.json` 依赖含 `vitest` → 依赖含 `jest` →
  `scripts.test` 匹配 `node --test` → pytest 标记 → `package.json`（`script`，需开启）→ `generic`。
  pytest 标记指 `pytest.ini` / `pyproject.toml` / `setup.cfg` / `tox.ini` 任一存在，或者目录本身、
  `tests/` 下有一层 `test_*.py`、`*_test.py`、`conftest.py`。
- **结果可追溯**：命中的 runner 连同**原因**写进运行记录（`runner` / `runnerLabel` / `detectReason`）。
  面板显示「runner：自动识别 → Vitest」；`test_live_status` 的报告里也有一行 `runner:`（例如
  `runner: vitest (Vitest)`）。显式指定 runner 时 `detectReason` 为 null。
- **`Cargo.toml` 不猜**：cargo runner 本期没有实现（本机没有 cargo，无法自证），识别到它明确回落
  `generic` 并给出原因。

### runner 一览

| id | 实际命令 | 自动识别依据 | 目标选择器 | 开关 / 用例名过滤 |
| --- | --- | --- | --- | --- |
| `go` | `go test`；追加 `-v`、`-race`、`-count=1`、`-run=<pattern>`、`-timeout=<Ns>s`、目标 | 目录里有 `go.mod` | 相对包模式，默认 `./...`（如 `./database/kdb`） | `verbose`（`-v`，面板默认勾选）、`race`（`-race`）、`count`（`-count=1`）；`-run` |
| `vitest` | `pnpm exec vitest run`；追加 `--reporter=verbose`、`-t=<pattern>`、目标 | `package.json` 的 dependencies/devDependencies 含 `vitest` | 相对文件或目录，默认留空（交给 vitest 自己发现），如 `tests/`、`src/a.test.js` | `verbose`（`--reporter=verbose`）；`-t` |
| `jest` | `pnpm exec jest`；追加 `--verbose`、`-t=<pattern>`、目标 | dependencies/devDependencies 含 `jest` | 同上 | `verbose`（`--verbose`）；`-t` |
| `nodeTest` | `node --test`；追加 `--test-reporter=spec`、`--test-name-pattern=<pattern>`、目标 | `package.json` 的 `scripts.test` 里出现 `node --test` | 相对文件或目录，如 `test/`、`test/math.test.js` | `verbose`（`--test-reporter=spec`）；`--test-name-pattern` |
| `pytest` | `pytest`；追加 `-v`、`-k=<pattern>`、目标 | pytest 配置标记（`pytest.ini` / `pyproject.toml` / `setup.cfg` / `tox.ini` 任一），或目录、`tests/` 下的 `test_*.py` / `*_test.py` / `conftest.py` | 相对 nodeid，如 `tests/test_calc.py::test_add`、`tests/` | `verbose`（`-v`）；`-k` |
| `script` | `pnpm test --`（执行 `package.json` 的 `scripts.test`），不追加任何东西 | `package.json` 存在，且 `allowScriptRunners: true`；关闭时回落 `generic` 并说明 | 目标会被忽略（不进 argv） | 无 |
| `generic` | 配置里的 `command + baseArgs`（默认 `go test`） | 以上都不匹配、`Cargo.toml`（cargo 未实现）、`script` 被关闭 | 目标会被忽略（不进 argv） | 无 |

几个容易踩的点：

- **目标是「这次跑什么」**：Go 是相对包模式（默认 `./...`），vitest/jest/`node --test` 是相对文件或目录
  （默认留空，交给它们自己发现），pytest 是相对 nodeid（默认留空）。`script` 和 `generic` 没有目标概念，
  传了也会被忽略；HTTP 的 `targets`、工具的 `targets` 都是这个意思，旧字段 `packages` 是它的别名。
- **用例名过滤**：Go 的 `-run` 还是 0.2.0 的字符集（不收空格）；pytest 的 `-k`、vitest/jest 的 `-t`、
  `node --test` 的 `--test-name-pattern` 允许空格（`calc add` 这种用例名是合法的）。
- **超时**：只有 Go 把 `-timeout=Ns` 写进 argv（默认 900s，可按次覆盖）；其他 runner 的墙钟上限由宿主看门狗
  负责，到点对整组 SIGTERM/SIGKILL，不伪装成 runner 自己的开关。
- **开关的默认值只影响面板**：描述符里的 `default: true` 决定面板的预选状态（Go 的 `-v`、vitest/jest/
  `node --test`/pytest 的 verbose 默认都打开）。HTTP/工具只追加显式 `flags[id] === true` 的开关，所以
  `hub.start({})` 的 Go argv 仍是 `go test -timeout=900s ./...`；勾上 `-v -race -count=1` 后顺序固定为
  `-v -race -count=1 -run=… -timeout=… 目标`，和 0.2.0 逐字节一致。
- **`go` 仍认配置里的命令**：`kind: 'go-test'`（默认）下 Go 运行使用 `command + baseArgs`（默认就是
  `go test`），把绝对路径（`/usr/local/go/bin/go`）写进 `command` 仍然有效；其他 runner 使用描述符自带的
  executable，`command` 不会替换它们。

## 安装

```bash
dsh plugin --profile web add github:stcn52/dsh-test-live
```

包内自带 `cordis.patch.yml`，插件管理器会把它并入 `dsh.profile.bundles`，重启/重载 profile
后侧边栏出现「测试日志」页签。

## 配置

在 profile 的 `cordis.patch.yml` 里按行 id 覆盖：

```yaml
- id: test-live
  name: 'dsh-test-live'
  config:
    cwd: /workspace/service     # 只是兜底：运行目录优先取会话自己的 cwd
    runner: auto                # auto = 每次按运行目录识别；也可固定成某个 runner id
    allowScriptRunners: false   # script 会执行 package.json 的 test 脚本，默认关闭
    command: go                 # 只被 generic（和 kind: go-test 的 Go 运行）使用
    baseArgs: [test]
    defaultTimeoutSec: 900
    maxLines: 20000
    maxRuns: 30                 # 内存里条数
    historyRuns: 100            # 落盘条数
    defaultScope: all           # 面板打开时：all = 全部对话，session = 只看本对话
    followRoots: [/workspace]   # 跟随白名单（会话目录会自动加入）
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `kind` | `go-test` | 旧开关。`command` 等价于 `generic` runner，和别的 runner 同时配会被判为配置错误（插件回落默认配置并 warn）；`go-test` 下 Go 运行取 `command + baseArgs`，其余 runner 不受影响 |
| `runner` | `go`（代码默认；包内 patch 为 `auto`） | 默认 runner：`auto` 或 `go` / `vitest` / `jest` / `nodeTest` / `pytest` / `script` / `generic`。`DEFAULTS.runner` 是 `'go'`，让没配置过的部署保持 0.2.0 的 `go test` argv；包内 `cordis.patch.yml` 写的是 `'auto'`，装好即按目录识别。值大小写不敏感，解析后统一成规范 id |
| `allowScriptRunners` | `false` | 是否允许 `script` runner（`pnpm test --`，执行仓库自己的 test 脚本）。关闭时显式选它会被拒，自动识别遇到 `package.json` 会回落 `generic` 并给出原因 |
| `cwd` | `null` | **只是兜底**运行目录：优先取发起运行的对话自己的工作目录，取不到才用这个值，再取不到用宿主进程 cwd |
| `command` | `go` | 可执行文件名（裸名字或绝对路径，不允许路径里的空格）。只有 `generic` 与 `kind: go-test` 的 Go 运行使用；其他 runner 用描述符里的 executable |
| `baseArgs` | `[test]` | 固定前置参数，使用范围同 `command`；其他 runner 用描述符里的 baseArgs |
| `env` | `{}` | 追加环境变量（值会被转成字符串） |
| `maxRuns` | `30` | **内存**里保留多少个已结束运行（1–100），更早的被挤掉 |
| `historyRuns` | `100` | **落盘**保留多少次运行（1–1000），与 `maxRuns` 独立 |
| `historyLines` | `200` | 每条运行落盘保留多少行**尾部**日志（10–2000）；长日志的头部不落盘 |
| `stateFile` | `${DSH_HOME:-~/.dsh}/test-live/runs.json` | 历史状态文件路径；写绝对路径可改位置，写 `''` 保持默认，写 `null`/`false` **关闭持久化**（只在内存里） |
| `defaultScope` | `all` | 面板默认视角：`all` = 全部对话，`session` = 只看本对话（用户仍可在面板里切换） |
| `maxLines` | `20000` | 单次运行的行缓冲上限，超出丢最早的（`seq` 继续增长） |
| `defaultTimeoutSec` | `900` | 默认墙钟上限，可按次覆盖；Go 还会把它写成 `-timeout=Ns` |
| `followRoot` | `null` | 「跟随文件」的**单个**根目录，是 `followRoots` 的单值别名（排在白名单最前） |
| `followRoots` | `[]` | 「跟随文件」的**白名单**，有序，面板按它出选择器；空数组表示沿用 `followRoot`（再退到 `cwd`） |
| `followIntervalMs` | `300` | 跟随文件的轮询间隔（毫秒，100–5000） |
| `ui.autoScroll` | `true` | 有新行时自动滚到底 |
| `ui.packagesPlaceholder` | `'./...'` | 0.2.0 的包输入框占位。0.3.0 面板改用当前 runner 描述符的占位提示；这个键仍被解析，但不再影响界面 |

> `cwd` 与 `stateFile` 的「空值」含义不同，容易踩：`cwd: null` 是「照旧兜底到宿主目录」，
> 而 `stateFile` 要写 `''`（空字符串）才是「用默认路径」，显式写 `stateFile: null`（或 `false`）是**关闭**持久化。
> 包内 `cordis.patch.yml` 因此写的是 `stateFile: ''`。

> 配置写错不会拖垮宿主：`resolveConfig` 抛错时插件回落到默认配置（`runner: 'go'`、`command: 'go'`、
> `baseArgs: ['test']`）并 `logger.warn`。所以 `runner` 拼错时先看宿主日志，别以为它悄悄生效了。

## 跨对话汇总、历史保留、只看本对话

这三件事是同一个模型的三面：**运行属于对话，面板属于宿主。**

**跨对话汇总。** 所有对话共用一张运行表，面板顶部的 `全部` 视角列出全部记录，每条都带「属于哪个对话 + 该次的目录」。
别的对话正在跑的测试也会实时出现，不需要你切过去。`全部` 视角下还能看到「N 条 · M 个对话」。
HTTP 侧对应 `GET /test-live/runs?scope=all`；模型侧对应 `test_live_runs`（默认就列全部对话）。

**历史保留。** 结束的运行会写进宿主级状态文件，默认 `${DSH_HOME:-~/.dsh}/test-live/runs.json`
（`DSH_HOME` 没设就用 `~/.dsh`）——放在宿主家目录而不是某个项目下，因为这张表是全宿主共享的。
落盘的内容是**元数据 + 每条运行尾部 `historyLines`(200) 行**，条数上限 `historyRuns`(100)；运行结束时写一次、按 100ms 节流合并，
用临时文件 + rename 原子替换，插件卸载时再立即 flush 一次；读不到/写不进/文件损坏都只降级成「没有历史」，绝不会让一次测试失败。
从盘里恢复出来的运行在面板里标「· 历史」；如果宿主是在它运行中挂掉的，恢复后状态是 `canceled` 并附错误
`宿主重启，运行被中断`（子进程已经没了，留个永远转的圈只会误导）。
0.2.0 落盘的记录没有 `runner` 字段，恢复时按命令行推断（`go test` → `go`，其余 → `generic`），不会被错标成自动识别。
所以历史是**摘要级**的：想在重启后看完整日志，请自己 `| tee` 一份文件再用「跟随文件」。

**只看本对话。** 面板顶部是 `全部 | 本对话` 分段按钮，选 `本对话` 就只剩当前对话的记录；对话多于一个时，
旁边还有对话下拉，可以跳到任意一个对话的记录（选项来自「拥有运行的对话」，所以已经结束的对话也还在列表里）。
选择记在浏览器偏好里，下次打开沿用。默认视角由 `defaultScope` 决定（默认 `all`）。
HTTP 侧是 `GET /test-live/runs?scope=session&sessionId=…`；模型侧 `test_live_status` / `test_live_cancel` 默认就作用于
**调用它的那个对话**，要看/停别的对话的，显式传 `sessionId`。

## 安全边界

HTTP 面**不接受命令字符串**，只接受这些「收窄」参数：

- `runner`：只能是描述符表里的 id 或 `auto`；未知 id 直接 400 并列出可用值，不会退化成默认命令；
- `targets`：按该 runner 的选择器校验——Go 只收相对包模式（`./...`、`./database/kdb`），
  vitest/jest/`node --test` 只收相对路径或目录（不接受空白字符），pytest 只收相对 nodeid；
  绝对路径一律拒绝（pytest 另外拒绝换行）。旧字段 `packages` 等价；
- `pattern`：该 runner 的用例名过滤（`-run` / `-k` / `-t` / `--test-name-pattern`），规则来自描述符；
- `flags`：只能是当前 runner 描述符里有的开关 id；未知 id 会报错而不是静默忽略。
  旧的 `verbose` / `race` / `count` 布尔字段仍接受；
- `timeoutSec`：这次运行的墙钟上限。

也就是说，面板能调的只是「跑哪些目标、跑哪些用例、开哪些开关、跑多久」；可执行文件只来自 runner 描述符或部署配置。
`script` runner 会把仓库自己的 `pnpm test --` 跑起来（代码不受插件控制），所以默认关闭，见配置里的 `allowScriptRunners`。

**跟随范围 = 配置的根 + 当前对话的工作目录。** 允许读的根集合是 `followRoots`（白名单，`followRoot` 是其单值别名，
为空时退到 `cwd`，再退到宿主进程目录），加上**发起调用的那个对话自己的 cwd**——这样一个对话能跟随它正在工作的项目里的日志，
而不必事先写进 profile。边界判定在 `realpath` 之后的真实路径上做前缀比较，根里种一个符号链接也逃不出去；
请求里的 `root` 只能在已允许的根里**收窄**，不能扩宽；不在任何根内的路径一律拒绝（HTTP 400 / 工具报错），
不会被悄悄改写到别的根下。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/test-live/runs?scope=all\|session&sessionId=&limit=` | 运行列表（新的在前）。`scope` 缺省取 `defaultScope`；`scope=session` 但没给 `sessionId` 时退回 `all`；`limit` 上限 500。响应含 `runs` / `sessions` / `scope` / `defaultScope` |
| GET | `/test-live/sessions` | 拥有运行记录的对话列表（含条数、是否有运行中的、最近活动时间）+ `defaultScope`，供面板下拉 |
| GET | `/test-live/runners` | runner 目录：`runners` 每条含 `id` / `label` / `language` / `executable` / `baseArgs` / `mode` / `selectionPlaceholder` / `selectionHint` / `flags` / `labels` / `available` / `reason` / `hint`，另有本宿主的 `defaultRunner`（`auto` 或具体 id）与 `allowScriptRunners` |
| GET | `/test-live/status?id=&sessionId=` | 单次运行元信息；缺 `id` 时取最新（给 `sessionId` 则取该对话最新） |
| POST | `/test-live/run` | 启动运行，JSON 选项：`runner?`（id 或 `auto`）、`targets?`、`pattern?`、`flags?`、`timeoutSec?`，可选 `sessionId`（决定归属对话与运行目录）→ `202`。旧字段 `packages` / `verbose` / `race` / `count` 仍然兼容 |
| POST | `/test-live/cancel` | 取消 `{id}`，或 `{sessionId}` 取消该对话最新一次 |
| GET | `/test-live/log?id=&sessionId=` | 纯文本完整日志（`&download=1` 下载） |
| GET | `/test-live/roots` | 配置的跟随根 + 运行目录（只给配置，不做目录列举） |
| POST | `/test-live/follow` | 跟随日志文件 `{path, root?, sessionId?}` |
| GET | `/test-live/stream?id=&since=&sessionId=` | SSE：先补 `since` 之后的历史行，再推新增行；结束时发 `event: status` |

运行记录本身带 `runner`（实际跑的 id）、`runnerLabel`（面板显示的名字）与 `detectReason`（自动识别命中的依据；
显式指定时为 `null`），所以面板和 `test_live_status` 都能说清这次是谁跑的、计数是哪套语法算的。
`/runners` 的 `allowScriptRunners` 决定 `script` 这一行是否可用（不可用时 `available: false` 且带 `reason`）。
`POST /run` 在 spawn 之前做预检：未知 runner、未开启的 `script`、被当前 runner 拒绝的目标/用例名/开关，
都会在 spawn 之前变成 400 而不是「启动了但什么都没跑」（`script` / `generic` 没有目标概念，传了是忽略，不会报错）。

所有 `sessionId` 参数都是可选的：不带它的老客户端看到的仍然是原来的宿主级视图（`scope` 落到 `defaultScope`，
默认 `all`）。未知的 `sessionId`（面板停在一个已结束的会话页上）不会让请求失败，只是退化成「没有对话」的归属。

跟随模式没有退出码可观察：运行会一直是 `running`，直到 `cancel` 停止读取（写入方不受影响）。
文件被截断（再次 `> file`）时从 0 重读，并插一行 `(file truncated, re-reading from the start)`。

SSE 每行是一个 `data: {"seq":N,"text":"...","kind":"...","provisional":false}`；
同一 `seq` 的行会被替换（未换行的半行在补全时原地更新，不重复追加）。

## 工具

| 工具 | 作用 |
| --- | --- |
| `test_live_run` | 启动运行后**立即返回** run id（不占用对话）；运行归属**调用它的对话**、在该对话的 cwd 里执行。可用 `runner` 选 `auto` 或某个 id，`targets` 的含义随 runner 变（Go 包模式 / JS 文件 / pytest nodeid），`packages` 是 `targets` 的旧别名，`flags` 按描述符 id 给开关，`pattern` 是该 runner 的用例名过滤；`verbose` / `race` / `count` 是旧别名，只在当前 runner 有同名开关时生效。`timeoutSec` 是墙钟上限，`tail` 回带日志尾部（默认 120 行）。`wait:true` 才等结束（`waitSec` 默认 60、上限 300，等待可被取消打断） |
| `test_live_status` | 读某次运行的状态、计数、失败用例与日志尾部（`tail`，默认 120 行）；报告里有一行 `runner:`，说明这份计数是哪套语法算出来的（没有记录的运行写 `runner: not recorded`）。默认读**本对话**最新一次；`sessionId` 读别的对话，`id` 读指定一次 |
| `test_live_runs` | 列出最近的运行（新的在前）：状态、耗时、所属对话、目录、汇总。默认列**全部对话**（`sessionId` 只看某个对话），`limit` 默认 10、上限 100，`tail` 默认 0（最多回带 200 行） |
| `test_live_follow` | 跟随一个日志文件（`path`，外部命令写入），立即返回 run id；路径须在「配置根 + 本对话目录」内。可传 `runner` 指定跟随的 runner；不传（或传 `auto`）时按「本对话最近一次运行的 runner → 目录识别 → 默认 runner」推断，并在记录里写明推断来源。跟随运行**记录**它用的 runner，因为它决定这份日志按哪套语法统计计数（否则 vitest/pytest 的日志会被 Go 语法算错） |
| `test_live_cancel` | 停止运行或停止跟随。`{id}` 停指定一次；不给 `id` 就停**本对话**最新那次（`sessionId` 可指向别的对话），不会误停别的对话的运行；对整组发 SIGTERM |

## 已知限制

- **cargo 未实现**：`Cargo.toml` 目前只会让识别结果明确回落 `generic` 并附原因（本机没有 cargo，无法自证，
  与其猜一个跑不起来的描述符，不如不提供）。Rust 项目要用测试面板，请配置 `command` 后用 `generic`。
- **script 默认关闭**：`script` runner 会执行 `package.json` 里的 `scripts.test`（`pnpm test --`），
  跑的是仓库自己的代码，所以必须显式打开 `allowScriptRunners: true`；否则显式选它会被拒，
  自动识别遇到 `package.json` 会回落 `generic` 并说明。
- **界面单位随 runner 变**：套件一列不是固定的「包」——Go 是「包」，vitest/jest 是「文件」，
  pytest 与 `node --test` 是「用例」；`generic` 与 `script` 只着色、不计数（没有可诚实地数的词汇）。
  工具摘要里的单位也跟着变（packages / files / suites / test files）。
- **自动识别是启发式**：只看文件名、依赖名和 `scripts.test` 的文本，不解析项目内容。`pyproject.toml` 存在就算
  pytest（哪怕它只是别的工具的配置）；只要 `package.json` 存在且允许 script 就会选 `script`，哪怕里面没有
  `test` 脚本（`pnpm test --` 会失败）。不确定时把 `runner` 固定成某个 id。
- **历史是摘要级**：落盘只有元数据 + 每条尾部 `historyLines`(200) 行、条数上限 `historyRuns`(100)。
  重启后面板能续看这 200 行与汇总，更早的行不在盘上；要长期完整日志请自己 `tee` 一个文件再跟随。
- **宿主中途重启的运行会被标成 `canceled`**：子进程随宿主一起没了，恢复时附错误「宿主重启，运行被中断」。
- **跟随范围不是无边界的**：能读的是配置根（`followRoots` / `followRoot` / `cwd` 兜底）加**当前对话自己的工作目录**；
  越界仍拒。旧版本只有一个 `followRoot` 单根，现在多了白名单与「会话目录自动加入」，
  想让某个目录可跟随，要么在 profile 里加进 `followRoots`，要么在需要它的那个对话里发起。
- **汇总靠文本标记，不是 `-json`**：每种 runner 用自己的正则读输出（Go 的 `ok`/`FAIL`/`--- FAIL:`、
  vitest 的 `Test Files`/`Tests`、jest 的 `Test Suites:`/`Tests:`、pytest 的 `PASSED`/`FAILED`、
  `node --test` 的 `✔`/`✖` 与 TAP）；`generic` / `script` 只着色不计数，自定义测试框架的输出仍会原样显示，
  但不会计入汇总。
- **并发运行不分组**：面板一次只看一次运行；同时启动多次时，仍在运行的那次会被自动选中（列表里能按对话区分）。
- **跟随文件不会自动结束**：没有退出码可观察，只能手动停止；可读范围受「配置根 + 会话目录」限制。
