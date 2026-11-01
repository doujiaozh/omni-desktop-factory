# Omni-Desktop-Factory

> **Omni-Desktop-Factory：把网页装进 Go 的壳里，让每个人都能造出属于自己的原生软件。**
>
> *Omni-Desktop-Factory: wrap the web in a Go shell, so everyone can ship their own native software.*

---

[English](#english) · [中文](#中文)

---

## English

A one-command factory that turns HTML/CSS/JS — or a built frontend `dist` folder —
into a **standalone Windows `.exe`**. No Electron, no Tauri, no Rust, no CGO.
Just pure Node.js for the build pipeline and pure Go 1.20 for the binary.

### Why

- **Tiny output.** A Hello-World app is ~5 MB, not 150 MB. The whole frontend is
  embedded into the Go binary with `//go:embed`, so there is exactly one file to ship.
- **Windows 7 friendly.** The Go runtime templates target **Go 1.20.x**, the last
  toolchain whose binaries still run on Windows 7 / 8.1 / Server 2008 R2 / 2012.
  `omni-factory build` loudly warns when it detects a newer toolchain, because that
  binary would **not** run on Win7.
- **Zero webview dependencies.** Instead of bundling a Chromium the app host is
  detected at runtime (Chrome / Edge / Chromium / Brave / Vivaldi / Firefox) and
  launched in `--app` kiosk-ish mode with a dedicated profile directory.
- **Frontend ↔ Go RPC out of the box.** Every generated app ships a ~6 KB WebSocket
  bridge SDK, so the page can call into the host:

  ```js
  window.omni.call('system.getInfo').then((info) => console.log(info));
  window.omni.on('omni:ready', () => console.log('bridge is up'));
  window.omni.call('app.exit'); // close the app from the page
  ```

### Prerequisites

- **Node.js ≥ 14** (the CLI has zero runtime dependencies)
- **Go 1.20.x** — install from <https://go.dev/dl/> and make sure `go` is on `PATH`

Check everything at once:

```bash
npx omni-factory doctor
```

### Quick start

```bash
# Build the bundled example (examples/index.html -> examples/Hello.exe)
node examples/build.js

# Build your own app
npx omni-factory build --src ./dist --name MyApp
```

That produces `MyApp.exe` in the current directory (Windows 7 compatible), with
`-ldflags="-s -w -H windowsgui"` for a stripped, console-free binary.

### CLI reference

```text
omni-factory build --src <dir> --name <name> [--out <dir>] [--title <text>]
                   [--width <px>] [--height <px>] [--browser <name>]
                   [--keep] [--verbose]
omni-factory doctor
omni-factory help
omni-factory --version
```

| Flag        | Default | Meaning                                                            |
| ----------- | ------- | ------------------------------------------------------------------ |
| `--src`     | —       | Folder with `index.html` (your `dist` output). Required.            |
| `--name`    | —       | Binary/product name (`[A-Za-z0-9_.-]+`). Required.                  |
| `--out`     | `.`     | Where `Hello.exe` lands.                                           |
| `--title`   | `name`  | Window title, also reported by `system.getInfo`.                    |
| `--width`   | `1200`  | Initial window width in pixels.                                     |
| `--height`  | `800`   | Initial window height in pixels.                                    |
| `--browser` | `auto`  | `auto`, `chrome`, `edge`, `chromium`, `brave`, `vivaldi`, `firefox`. |
| `--keep`    | off     | Keep the generated Go staging tree next to the binary.               |
| `--verbose` | off     | Debug-level logging.                                                |

### How it works

```text
--src (HTML/CSS/JS)                     runtime/*.go templates
         |                                       |
         v                                       v
  src/generate.js  ------------------------>  staging/
  copies assets, injects /__omni.js           main.go  //go:embed all:assets
  into every *.html                           go.mod, bridge/omni.js
                          |
                          v
                   go build -ldflags="-s -w -H windowsgui"
                          |
                          v
                     MyApp.exe  (~5 MB, single file)
                          |
                          v
              runtime: 127.0.0.1 server  <--WebSocket RPC-->  browser --app window
```

### Runtime environment variables

| Variable         | Effect                                                       |
| ---------------- | ------------------------------------------------------------ |
| `OMNI_PORT`      | Pin the embedded server port instead of a random one (debug). |
| `OMNI_NO_WINDOW` | `1` = run the embedded server headless, no window (CI/smoke). |

### Built-in RPC methods

| Method            | Description                                    |
| ----------------- | ---------------------------------------------- |
| `system.getInfo`  | App name/title/version, OS, arch, uptime, …     |
| `system.open`     | Open an `http(s)` URL in the default browser.   |
| `system.log`      | Mirror a message into the host log file.        |
| `app.exit`        | Ask the host to shut down cleanly.              |
| `bridge.version`  | Bridge protocol version.                        |
| `bridge.echo`     | Loop-back test used by the smoke test.          |

### Project layout

```text
omni-desktop-factory/
  bin/omni-factory.js      CLI entry (shebang, no deps)
  src/cli.js               argument parsing + command dispatch
  src/core.js              build orchestration (detect Go, stage, compile)
  src/generate.js          staging scaffolder + config.go templating
  src/doctor.js            environment self-check (with Win7 red lines)
  src/log.js               tiny zero-dependency logger
  runtime/                 Go templates copied into every generated app
    main.go                //go:embed all:assets + bridge/omni.js
    server.go              embedded HTTP server, SPA fallback, health
    ws.go                  hand-written RFC 6455 minimal WebSocket
    bridge.go              JSON-RPC dispatcher (call/result/event)
    shell.go               browser sniffing + --app window launcher
    config.go              build-time __OMNI_*__ placeholder template
    bridge/omni.js         frontend SDK served at /__omni.js
  examples/                index.html + one-line build.js -> Hello.exe
  test/smoke.mjs           HTTP + WebSocket smoke test for a running app
```

### Development

```bash
npm run doctor          # check the toolchain
npm run example         # examples/index.html -> examples/Hello.exe
npm run smoke           # needs a running app, e.g.:
#   $env:OMNI_PORT=18999; $env:OMNI_NO_WINDOW=1; Start-Process examples/Hello.exe
#   npm run smoke -- http://127.0.0.1:18999
```

### License

MIT — see [LICENSE](LICENSE).

---

## 中文

一条命令，把 HTML/CSS/JS（或构建好的 `dist` 目录）变成**独立运行的 Windows `.exe`**。
不用 Electron、不用 Tauri、不写 Rust、不用 CGO——构建流水线用纯 Node.js，二进制内核
用纯 Go 1.20。

### 为什么这么做

- **产物极小。** Hello-World 只有约 5 MB，而不是 150 MB。整个前端通过 `//go:embed`
  编进 Go 二进制，发布只需一个文件。
- **守住 Win7 红线。** 运行时模板锁定 **Go 1.20.x**——这是最后一个二进制仍能在
  Windows 7 / 8.1 / Server 2008 R2 / 2012 上运行的工具链。`omni-factory build`
  检测到更高版本 Go 时会大声告警，因为那种产物**在 Win7 上跑不起来**。
- **零 WebView 依赖。** 不内置整个 Chromium：运行时自动嗅探本机浏览器
  （Chrome / Edge / Chromium / Brave / Vivaldi / Firefox），以 `--app` 模式启动
  独立窗口，并使用独立 profile 目录。
- **开箱即用的前后端 RPC。** 每个生成的应用自带约 6 KB 的 WebSocket 桥接 SDK，
  前端可以直接调用 Go 底层能力：

  ```js
  window.omni.call('system.getInfo').then((info) => console.log(info));
  window.omni.on('omni:ready', () => console.log('桥已就绪'));
  window.omni.call('app.exit'); // 从页面关闭应用
  ```

### 环境要求

- **Node.js ≥ 14**（CLI 零运行时依赖）
- **Go 1.20.x** —— 从 <https://go.dev/dl/> 安装，并确保 `go` 在 `PATH` 中

一键自检：

```bash
npx omni-factory doctor
```

### 快速开始

```bash
# 跑通内置示例（examples/index.html -> examples/Hello.exe）
node examples/build.js

# 打包你自己的应用
npx omni-factory build --src ./dist --name MyApp
```

在当前目录生成 `MyApp.exe`（Win7 兼容），编译参数
`-ldflags="-s -w -H windowsgui"`：去掉调试信息、无控制台黑窗。

### 命令行

```text
omni-factory build --src <目录> --name <名称> [--out <目录>] [--title <文本>]
                    [--width <像素>] [--height <像素>] [--browser <名称>]
                    [--keep] [--verbose]
omni-factory doctor
omni-factory help
omni-factory --version
```

| 参数        | 默认值 | 含义                                                 |
| ----------- | ------ | ---------------------------------------------------- |
| `--src`     | —      | 含 `index.html` 的目录（你的 `dist` 产物）。必填。    |
| `--name`    | —      | 二进制/产品名（`[A-Za-z0-9_.-]+`）。必填。            |
| `--out`     | `.`    | `Hello.exe` 的输出目录。                              |
| `--title`   | 同 name | 窗口标题，`system.getInfo` 也会返回。                 |
| `--width`   | `1200` | 初始窗口宽度（像素）。                                 |
| `--height`  | `800`  | 初始窗口高度（像素）。                                 |
| `--browser` | `auto` | `auto`/`chrome`/`edge`/`chromium`/`brave`/`vivaldi`/`firefox`。 |
| `--keep`    | 关     | 保留生成的 Go 暂存源码（输出到二进制旁边的 `.omni-staging-<name>`）。 |
| `--verbose` | 关     | 输出调试日志。                                         |

### 工作原理

```text
--src（HTML/CSS/JS）                      runtime/*.go 模板
         |                                       |
         v                                       v
  src/generate.js  ------------------------>  staging/
  拷贝资产，给每个 *.html 注入 /__omni.js      main.go  //go:embed all:assets
                                              go.mod、bridge/omni.js
                          |
                          v
                   go build -ldflags="-s -w -H windowsgui"
                          |
                          v
                     MyApp.exe  （约 5 MB，单文件）
                          |
                          v
              运行时：127.0.0.1 服务  <——WebSocket RPC——>  浏览器 --app 窗口
```

### 运行时环境变量

| 变量              | 作用                                                  |
| ----------------- | ----------------------------------------------------- |
| `OMNI_PORT`       | 固定内嵌服务器端口（默认随机），便于调试。              |
| `OMNI_NO_WINDOW`  | `1` = 只跑内嵌服务器、不拉窗口（CI / 冒烟测试用）。      |

### 内置 RPC 方法

| 方法              | 说明                                        |
| ----------------- | ------------------------------------------- |
| `system.getInfo`  | 应用名/标题/版本、OS、架构、运行时长等。      |
| `system.open`     | 用默认浏览器打开 `http(s)` 链接。             |
| `system.log`      | 把日志镜像写入宿主日志文件。                   |
| `app.exit`        | 通知宿主优雅退出。                            |
| `bridge.version`  | 桥接协议版本。                                |
| `bridge.echo`     | 回环测试，冒烟脚本使用。                       |

### 目录结构

```text
omni-desktop-factory/
  bin/omni-factory.js      CLI 入口（shebang，零依赖）
  src/cli.js               参数解析与命令分发
  src/core.js              构建编排（检测 Go、暂存、编译）
  src/generate.js          暂存目录组装 + config.go 模板渲染
  src/doctor.js            环境自检（含 Win7 红线告警）
  src/log.js               零依赖日志模块
  runtime/                 每个生成的应用都会拷贝的 Go 模板
    main.go                //go:embed all:assets + bridge/omni.js
    server.go              内嵌 HTTP 服务器、SPA 回退、健康检查
    ws.go                  纯手写 RFC 6455 最小 WebSocket
    bridge.go              JSON-RPC 分发器（call/result/event）
    shell.go               浏览器嗅探 + --app 窗口拉起
    config.go              构建期 __OMNI_*__ 占位符模板
    bridge/omni.js         前端 SDK，固定挂在 /__omni.js
  examples/                index.html + 一行 build.js -> Hello.exe
  test/smoke.mjs           对运行中应用的 HTTP + WebSocket 冒烟测试
```

### 开发

```bash
npm run doctor          # 检查工具链
npm run example         # examples/index.html -> examples/Hello.exe
npm run smoke           # 需要先启动应用，例如：
#   $env:OMNI_PORT=18999; $env:OMNI_NO_WINDOW=1; Start-Process examples/Hello.exe
#   npm run smoke -- http://127.0.0.1:18999
```

### 开源协议

MIT —— 见 [LICENSE](LICENSE)。
