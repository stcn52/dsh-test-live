# dsh-test-live

DSH 侧边栏「测试日志」页签：在 GUI 里跑测试，输出**逐行实时**出现，结束后给出失败汇总。

![测试日志面板](docs/screenshot.png)

> 截图用示例数据渲染（`/workspace/service`、`github.com/example/*` 均为占位），面板的配色与布局来自 `src/client/index.js`。

## 它解决什么

`go test ./...` 的输出有三个问题：跑得久、被 `| tail` 吞掉、失败信息埋在几百行里。
这个插件把测试进程放进**独立进程组**，通过 SSE 把每一行推给浏览器：

- **不碰宿主**：子进程 `detached` 成自己的进程组，取消/超时对整组发信号；`go test` 派生的测试二进制
  一起死，不会变成孤儿，也不会误伤宿主所在进程组。
- **实时**：进程还在跑就能看到 `=== RUN` / `ok` / `FAIL` 逐行出现，不用等结束。
- **有颜色**：按行分类着色（用例开始/通过/失败/跳过、包结果、构建错误、panic）。
- **有汇总**：包通过/失败/无用例数、用例通过/失败/跳过数、构建错误数、耗时。
- **只看失败**：一键过滤，失败行保留完整上下文。
- **可取消**：面板上的「取消」对进程组发 SIGTERM（3 秒后 SIGKILL）。
- **对话联动**：模型调用 `test_live_run` 启动的运行同样在这个面板里实时显示；工具默认不等待，
  对话不会被一个卡住的测试拖住。
- **跟随文件**：任意来源（终端里 `go test ./... | tee fulltest.log`、bash 调用、CI）只要写进文件，
  面板就能 tail 它——同一条 SSE 通道、同一套着色与汇总，不受「谁启动的」限制。

## 安装

```bash
dsh plugin --profile web add /home/chenyang/opt/dsh-test-live
```

包内自带 `cordis.patch.yml`，插件管理器会把它并入 `dsh.profile.bundles`，重启/重载 profile
后侧边栏出现「测试日志」页签。

## 配置

在 profile 的 `cordis.patch.yml` 里按行 id 覆盖：

```yaml
- id: test-live
  name: 'dsh-test-live'
  config:
    cwd: /home/chenyang/ai/kk/golang/kmicro   # null = 宿主进程工作目录
    command: go
    baseArgs: [test]
    defaultTimeoutSec: 900
    maxLines: 20000
    maxRuns: 8
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `kind` | `go-test` | `go-test` 追加 `-v/-race/-run/-timeout` 与包模式；`command` 原样执行 `command + baseArgs` |
| `cwd` | `null` | 子进程工作目录；`null` 表示宿主进程 cwd |
| `command` | `go` | 可执行文件名（不允许带路径/空格） |
| `baseArgs` | `[test]` | 固定前置参数 |
| `env` | `{}` | 追加环境变量（值会被转成字符串） |
| `maxRuns` | `8` | 保留多少个已结束运行 |
| `maxLines` | `20000` | 单次运行的行缓冲上限，超出丢最早的（`seq` 继续增长） |
| `defaultTimeoutSec` | `900` | 默认墙钟上限，可按次覆盖 |
| `followRoot` | `null` | 「跟随文件」允许读取的根目录；`null` 表示沿用 `cwd` |
| `followIntervalMs` | `300` | 跟随文件的轮询间隔（毫秒） |

## 安全边界

HTTP 面**不接受命令字符串**，只接受：

- `packages`：相对包模式（`./...`、`./database/kdb`），拒绝绝对路径与 `;` 等字符；
- `pattern`：`-run` 的用例名正则，限 `[A-Za-z0-9_./|()\[\]*+?^$-]`；
- `verbose` / `race` / `count` / `timeoutSec` 开关。

也就是说，面板能调的只是「跑哪些包、跑哪些用例、跑多久」，执行的可执行文件永远是配置里的那个。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/test-live/runs` | 最近运行列表（新的在前） |
| GET | `/test-live/status?id=` | 单次运行元信息（缺省取最新） |
| POST | `/test-live/run` | 启动运行，JSON 选项 |
| POST | `/test-live/cancel` | 取消运行 `{id}` |
| GET | `/test-live/log?id=` | 纯文本完整日志（`&download=1` 下载） |
| POST | `/test-live/follow` | 跟随日志文件 `{path}`（必须落在 `followRoot` 内） |
| GET | `/test-live/stream?id=&since=` | SSE：先补 `since` 之后的历史行，再推新增行；结束时发 `event: status` |

跟随模式没有退出码可观察：运行会一直是 `running`，直到 `cancel` 停止读取（写入方不受影响）。
文件被截断（再次 `> file`）时从 0 重读，并插一行 `(file truncated, re-reading from the start)`。

SSE 每行是一个 `data: {"seq":N,"text":"...","kind":"...","provisional":false}`；
同一 `seq` 的行会被替换（未换行的半行在补全时原地更新，不重复追加）。

## 工具

| 工具 | 作用 |
| --- | --- |
| `test_live_run` | 启动运行后**立即返回** run id（不占用对话）；`wait:true` 才等结束，等待可被取消打断，上限 300s |
| `test_live_status` | 读某次运行（默认最新）的状态、计数、失败用例与日志尾部 |
| `test_live_follow` | 跟随一个日志文件（外部命令写入），立即返回 run id |
| `test_live_cancel` | 停止运行或停止跟随（默认最新的运行中那次），对整组发 SIGTERM |

## 已知限制

- **不做持久化**：运行记录只在宿主进程内存里，宿主重启即清空。
- **顺序是流式的，不是 `-json`**：汇总靠文本标记解析（`go test` 的 `ok`/`FAIL`/`--- FAIL:` 等），
  自定义测试框架的输出仍会原样显示，但不会计入汇总。
- **并发运行不分组**：面板一次只看一次运行；同时启动多次时，仍在运行的那次会被自动选中。
- **跟随文件不会自动结束**：没有退出码可观察，只能手动停止；可读范围受 `followRoot` 限制。
