# fixtures 来源与自证

这份目录是 `src/core/parse.js` 各门语法的**唯一判据来源**：每条正则都必须能在下面的真实输出里对上一条真行。
凡是手写的期望值，都必须在 `tests/parse.test.js` 里被「用另一条独立正则从同一份输出里抽出来的数字」复核。

## 1. 原样复制（未改一个字节）

来源目录 `/tmp/lang-fixtures/`，相对路径保持一致，sha256 与源文件逐一相同（不是抽查）：

| fixture | sha256 |
| --- | --- |
| `vitest/vitest-pass.txt` | `839a4a8f438ce8a5765ebea9823f9355b629c88b4d04586e9591eaa9b2e43d6b` |
| `vitest/vitest-fail.txt` | `e56b9ec6bc39c64c76145f2810928dd277dc5dd2e4997d7b79818c336eab7b17` |
| `jest/jest-pass.txt` | `0a0521b53d7fdb898a3b6d6c07c90bb423cc9e8fba5b304fc8d0d999fe06457a` |
| `jest/jest-fail.txt` | `6903ecc4756cc31ce1c5149e08dc6e992c9bac4d0a497bdfcf60292f8ae04ee0` |
| `node-test/node-test-all.txt` | `407e32114a18c067f8062b1a3ca9301bfd20424e752d4097a34c924ef01652ae` |
| `node-test/node-test-fail.txt` | `fd4e3f4004f494551381dc895389e4021fa3a33ddcb7eb730c7e8365d29369cd` |
| `node-test/node-test-module-error.txt` | `b4810b9c902b4801ec49d5ae175ada0c8e73fc521761b443756935fca33c884a` |
| `node-test/node-test-pass.txt` | `8cdafa1200a6f7b3d0e6966f0673636fff5f882bcaf4e063497aa1b0d441e407` |
| `node-test/node-test-syntax-error.txt` | `f983b67617458459f9825e5d02cda1f1623fb17c8dc77aa8d90850dd4fb3aa1b` |
| `node-test/pnpm-test-all.txt` | `e843ddf3391a66ac45895bc923abc783400d2cb03832d44d65981f8f477e239c` |
| `pytest/pytest-collect-error.txt` | `d0327069221ada13aec251729801d3f059814710f9455bf3bd7cdecddb51bac1` |
| `pytest/pytest-fail.txt` | `f75e57c898d33fe4ee3a9247b605e666d1b7e9837c5d03a2c18cc09a784d1f6f` |
| `pytest/pytest-mixed.txt` | `ff0ee638ece2651cf52d5ea1789c428ac9030013359a580a1e1847d6ec8e7d84` |
| `pytest/pytest-pass.txt` | `ce2714324241abd4caf01cb8cc0976ab9329c996606d5debbe4b6d9ad817b6bd` |
| `pytest/pytest-syntax-error.txt` | `2cc4a44f1d27a057258472e6f050d6e4a41b3060b79262a8f190c7a10a0294a7` |

## 2. `node --test --test-reporter=spec` 抓包（原素材里没有，由我抓取）

`/tmp/lang-fixtures/node-test/` 与 `/tmp/probe/nt/` 里的 6 个 TAP 样本**全是 TAP 形态**，而契约要求
nodeTest 以 spec 报告器（`✔`/`✖`）为主、TAP 兜底。所以 spec 形态是本机真实抓的，不是照着文档编的：

| fixture | 命令（cwd） | exit |
| --- | --- | --- |
| `node-test-spec-pass.txt` | `node --test --test-reporter=spec test/math.test.js`（/tmp/lang-fixtures/node-test） | 0 |
| `node-test-spec-fail.txt` | `node --test --test-reporter=spec test/broken.test.js`（同上） | 1 |
| `node-test-spec-all.txt` | `node --test --test-reporter=spec`（同上，自动发现 test/） | 1 |
| `node-test-spec-suites.txt` | `node --test --test-reporter=spec test/calc.test.js`（/tmp/probe/nt） | 1 |
| `node-test-spec-load-error.txt` | `node --test --test-reporter=spec test/load-error.test.js`（/tmp/probe/nt） | 1 |
| `node-test-spec-syntax-error.txt` | `node --test --test-reporter=spec test/syntax.test.js`（/tmp/probe/nt） | 1 |

`/tmp/probe/nt` 是我为补 spec 形态现建的最小工程（`package.json` type=module，`calc.js`，`test/calc.test.js`
带 `describe` + 嵌套 `describe`，`test/load-error.test.js` 引不存在的模块，`test/syntax.test.js` 故意语法错）。
探针工程只为产生真实输出，产物已逐字落在上面的文件里。

## 3. go：仓库内已有输出的拼接（本机不许跑 go）

`go test` 输出全部取自本仓库既有测试里的字符串，逐行来源如下（**没有**任何一行声称是抓包）：

| fixture | 行 | 来源 |
| --- | --- | --- |
| `go-pass.txt` | `=== RUN   TestA` / `--- PASS: TestA (0.00s)` / `PASS` | `tests/core.test.js:94-105` |
| `go-pass.txt` | `ok  \tgithub.com/x/y\t0.123s` | `tests/core.test.js:99` |
| `go-pass.txt` | `coverage: 81.2% of statements` | `tests/core.test.js:122` |
| `go-fail.txt` | `=== RUN   TestB` / `--- FAIL: TestB (0.01s)` / `FAIL` / `FAIL\tgithub.com/x/y\t0.456s` | `tests/core.test.js:94-105`、`tests/runner.test.js:97` |
| `go-mixed.txt` | `ok  \tpkg/one\t0.1s` / `FAIL\tpkg/two\t0.2s` / `?\tpkg/three\t[no test files]` | `tests/core.test.js:119-121` |
| `go-skip.txt` | `--- SKIP: TestSkip (0.00s)` 形态 | `tests/core.test.js:98` 的 `--- SKIP: TestC (0.00s)` |
| `go-subtests.txt` | `=== RUN   TestB/sub` / `--- FAIL: TestB/sub (0.01s)` | 子测试形态，父/子两行 FAIL 均计入（`tests/core.test.js:97` 的 `TestB/sub`） |
| `go-build.txt` | `# github.com/x/y` | `tests/core.test.js:103` |
| `go-build.txt` | `./broken.go:5:2: undefined: something` 与 `FAIL\tgithub.com/x/y\t[build failed]` | **go 文档形态**，本机无 go 抓包（brief 禁止跑 go），已在测试里只断言「被识别为 build/package-fail」而不声称是抓包 |
| `go-panic.txt` | `panic: boom` | `tests/core.test.js:104` |

`git log --all -S "build failed"` 在本仓库为空，所以 `[build failed]` 这一行只能是文档形态。
