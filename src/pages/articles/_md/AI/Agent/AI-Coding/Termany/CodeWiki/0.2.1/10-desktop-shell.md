---
source:
  type: "源码解读"
  project: "Termany"
  url: "https://github.com/thinkany-ai/termany"
title: "桌面壳"
date: "2026-09-18T16:01:20+08:00"
category: [AI, Agent, "AI Coding", Termany, CodeWiki, "0.2.1"]
contentType: "CodeWiki"
tags: ["Termany", "Rust", "Tauri"]
description: "Tauri 2 壳只做壳：spawn 并看护打包的 Node 24 server（版本仲裁 + 孤儿清理 + watchdog）、五入口收敛到单一退出路径、macOS Services 与 Windows 托盘的原生集成、bundle-server.mjs 的四步打包链与 entitlements 放行 V8 JIT。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/00-overview)

---

## 模块定位

`apps/desktop/src-tauri` 是 Tauri 2 桌面壳，Rust ~1404 行——`lib.rs`（1398 行）承载全部逻辑，`main.rs` 仅 6 行调 `app_lib::run()`。核心姿态是 **Rust 只做壳**：窗口/托盘/全局快捷键/更新/进程看护；PTY 与 API 完全交给随包分发的 Node server 子进程。为什么复用 web UI + Node server 而不把 PTY 放进 Rust？README 的架构图已回答——`WebSocketBackend` 服务 web/desktop 两端是同一条代码路径，桌面版几乎零后端增量代码（lib.rs 里 server 相关只有 spawn/看护/版本仲裁 ~400 行），且 ACP 桥生态本身就是 Node 的。`LocalPtyBackend`（进程内 pty）是 Roadmap——当前取舍把复杂度集中在了进程边界管理，换来的是一套 PTY/ACP 逻辑只维护一份、server 可独立于 app 存活。

## 模块架构

```text title="lib.rs 的职责块"
setup()（L1148-1262）
├─ macOS：macos_services::install()（Services 菜单）+ 自建菜单栏（防 Tauri 预置项打架）
├─ Windows：install_windows_tray + 快捷方式图标刷新
├─ 恢复持久化的全局召唤快捷键
└─ 仅 release：start_server() → spawn_server_child() + monitor_server() watchdog

server 看护（~400 行）
├─ existing_server_matches()：手写 HTTP GET /api/version 比对烧进 bundle 的版本
├─ kill_termany_server_on_port()：lsof/PowerShell 找 PID + 核对命令行，只杀自己的
└─ spawn_server_child()：定位 Resources/server/{node,server.cjs} + 日志重定向 + CREATE_NO_WINDOW

窗口模型
├─ create_window()：decorations(false)+transparent(true) 自绘 chrome，先 invisible 等首帧
├─ PageClaims：workspaces/tabs/panes 全局共享，唯独 page 一窗一个
├─ 退出确认三重防线（CloseRequested / ExitRequested / QuitState 二段提交）
└─ 全局快捷键：toggle_app_windows() quake 式召唤
```

## 调用链路

release 启动的 server 决策链（`spawn_server_child()`，L453-502）：

```text
GET /api/version（手写 HTTP，不引客户端依赖）
├─ 版本一致 → 复用已在跑的 server（上一版 app 留下的活 shell 因此存活）
├─ 不一致 + /api/activity 有 running 任务 → 推迟换新（不能杀正在跑的 agent）
├─ 否则 kill_termany_server_on_port()
│    lsof / Get-NetTCPConnection 找监听 PID → ps / Get-CimInstance 核对命令行
│    确实是本 app 的 server（is_termany_server_command 匹配 server.cjs + termany.app 路径）
│    → 只杀自己的，放过占用端口的无关进程 → 轮询 20×100ms 等端口释放
└─ resolve resource_dir()（Windows 剥 \\?\ verbatim 前缀——Node 24 入口解析器不认）
     → command.spawn(<Resources>/resources/server/node, [server.cjs])
     → attach_server_log()（app_log_dir/server.log，超 2MB 截断）
     → monitor_server() watchdog：500ms 轮询 try_wait，意外退出自动重启 ≤3 次
```

就绪探测是**懒的**——Rust 不等 server 监听就绪，靠 watchdog + server 自身的 listen 重试；web 侧另有 `waitForServer()` 轮询兜底。两个配套细节：手写 HTTP 的 `server_get()`（L163-181）请求带 `Connection: close`、**靠读到 EOF 判断响应体结束**（不解析 Content-Length），`TcpStream::connect_timeout` 250ms——为一个请求不值得引 HTTP 客户端依赖；watchdog 区分"有意停止"靠 `kill_server()` 先 `take()` 把 child 置 None——watchdog 看到 None 即视为有意停止不重启，意外退出才计数重启（上限 `MAX_AUTO_RESTARTS = 3`，`ServerRestartAttempts` 状态持有）。

## 核心实现

### 版本仲裁与升级闭环

版本号由 `scripts/bundle-server.mjs` 的 esbuild `--define:__TERMANY_VERSION__` 烧进 bundle。升级必须显式停 server（server 故意跨普通退出存活，升级会把二进制换掉，不停则新 app 连到旧后端）——但直接停会杀掉活 shell，所以走任务检查闭环：前端 `updater.ts` 的 `relaunchApp()` 先 HTTP 查 `/api/activity` 的 running 任务，再 invoke `stop_server`——Rust 侧在停 server 前用同一检查再守一次竞态（L575-579 注释明说这是关"另一个窗口在 HTTP 检查后启动任务"的窗口）。

### 退出确认三重防线

五个退出入口（macOS 菜单 Quit / Windows 托盘 Quit / ⌘Q / 关最后一窗 / `RunEvent::ExitRequested`）全部收敛到 `quit-requested` 事件 + 前端确认对话框 + `QuitState` 二段提交：`CloseRequested` 拦截（必须在它拦而不是等 ExitRequested——Windows 上事件循环可能活得比唯一窗口还久）；`QuitState` 的存在是因为 `AppHandle::exit()` 自己会再抛一次 ExitRequested，不区分就会死循环弹确认框。`confirm_quit` command（L124-140）置 QuitState 后 `app.exit(0)`，**Windows release 下连带杀 server**（`kill_server` + `kill_termany_server_on_port` 双保险——托盘进程退出不会自动带走 detached 的 server 子进程）。自建菜单栏的原因（L1179-1239）：Tauri 预置 Quit 绕过 ExitRequested（tauri#3124）、"Close Window" 在 OS 层吃掉 ⌘W、"Minimize" 吃掉 ⌘M。

### 多窗口与 page 独占

`create_window()`：`main-N` 单调标签（`WindowCounter` 从 2 起，标签不复用——webview 按标签记忆每窗口的 workspace+page 视点，重开的 main-2 能落回原位）、复制聚焦窗口尺寸 +28px 级联偏移、`decorations(false)+transparent(true)+shadow(true)`（自绘标题栏，前端 `WindowControls.tsx`）、**先 `visible(false)`** 等前端首帧 reveal（15 秒兜底强制 show）。`PageClaims`：workspaces/tabs/panes 全局共享，唯独 page（持有活终端 + 原生子 webview）一窗一个——`claim_page` 被占时 raise 持有窗口并返回 false（raise 的 `set_focus` 会 pump 事件循环，所以放在 Mutex 锁**外**执行防死锁）；窗口销毁经 `WindowEvent::Destroyed` 释放声明（不用 CloseRequested——被对话框否决的关闭不该在页面还在屏幕上时交出 page）。这是 web 侧 `layoutMerge` "own page 必胜"合并规则的 Rust 侧对应物。

### 平台原生集成

**macOS**（objc2-app-kit）：用在 **Services 菜单**——`define_class!` 定义 `TermanyServiceProvider` 实现 `openInTermany:` selector（Finder 右键"在 Termany 打开"）；关键坑（Info.plist 注释）：Finder Services 按"选中文本是路径"匹配而非 file-URL flavor，所以 `paths_from_pasteboard()` 同时读 `NSPasteboardTypeFileURL` 和以 `/` 开头的裸文本行——镜像 Terminal.app 的声明。`macos-private-api` 是透明窗口的官方要求配置（非 vibrancy）。entitlements 放行 bundled Node：`allow-jit` + `allow-unsigned-executable-memory`（V8 JIT）、`disable-library-validation`（自签的 node-pty `.node` addon）。`ApplePressAndHoldEnabled=false` 防长按 j/k 弹重音符选择器。

**Windows**（windows-sys 的 `Win32_UI_Shell`）：只用于一处——`SHChangeNotify(SHCNE_ASSOCCHANGED)` 通知 Explorer 刷新快捷方式图标缓存（in-place 升级后图标不刷新的问题），用 marker 文件保证每版本只做一次。其余 Windows 动作全是系统工具子进程：PowerShell 找 PID、`taskkill /PID <pid> /T /F` 杀进程树、两处 `CREATE_NO_WINDOW` 防黑窗。

### 打包链路（scripts/bundle-server.mjs，157 行）

产物 `resources/server/` = `node(.exe)` + `server.cjs` + `acp/*.mjs` + 平台 prebuild 的 node-pty。四步：

1. **esbuild 打 server**：`index.ts --bundle --platform=node --format=cjs --external:node-pty`，ws/Anthropic SDK/@termany/core 全部内联——这就是 index.ts 手工镜像 core 协议的原因。
2. **esbuild 打 ACP 桥**：claude-agent-acp 与 codex-acp 打成 ESM `acp/*.mjs`，不带平台二进制——运行时用 env 指向用户已装 CLI 的绝对路径，永不复制 agent。
3. **node-pty 原样复制**：pnpm isolated node_modules 用 `realpathSync` 穿透符号链复制真实文件；只留本平台 prebuild（其他架构会破坏 macOS codesign）、删 Windows `.pdb`（~40MB）、恢复 unix spawn-helper 执行位。
4. **Node runtime**：下载 node-v24.0.0 归档（选 24 的唯一原因：`node:sqlite` 免 flag，v22 完全没有）；`TERMANY_TARGET_ARCH` 支持从 Apple Silicon 交叉构建 Intel 版——runtime 必须匹配 app 架构而非构建机。

dev/release 差异：`tauri.dev.conf.json` 只改 productName/window title/dev 图标，**不加 resources**（dev 不打包 server，`dev:desktop` 用 concurrently 起 5175 的 dev server）；dev 不注册 single-instance 插件（dev 与安装版共用 bundle identifier，插件按 identifier 锁会误判安装版为"另一实例"直接退出）。`run-tauri.mjs` 的唯一职责是 macOS 工具链防御：探测 SDK 坏了就按 `DEVELOPER_DIR` 换装好的 Xcode（不改全局 `xcode-select`）。

### 前端通信面

`env.ts` 一行探测 `"__TAURI_INTERNALS__" in window`。`titleBar.ts` 不用 Tauri 的 `data-tauri-drag-region`（该 handler 只认直击元素、双击 zoom 要求像素级重合），自管手势状态机——macOS zoom 在第二次 release 判定（`performWindowDragWithEvent:` 的私有事件循环会吃掉第一次 click 的 release，`dblclick` 根本不触发）。`clipboard.ts` **无 Tauri 分支**——统一走 web 标准（async Clipboard API，失败降级 `execCommand`，处理 OSC 52 这种无用户手势的复制），刻意决策。`windowToggle.ts` 的 chord 转换契约由 lib.rs 的测试 pin 住；`globalShortcutWarning()` 列出**静默冲突**（注册失败只能抓响冲突；抢 IME/Spotlight 的键不报错，只能靠已知清单）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 单一退出路径收敛 | `QuitState` 二段提交 + quit-requested 事件 | 五个入口一种语义，杜绝绕过对话框直接 exit |
| 版本仲裁复用 | `existing_server_matches` | 升级不杀活 shell；新旧 app 平滑交接 |
| 命令行核对后才杀 | `is_termany_server_command` | 只杀自己的 server，放过占端口的无关进程 |
| cfg 内联平台差异 | lib.rs 的 `#[cfg]` 块 | 差异不散文件，每块带 why 注释 |
| 契约 pin 测试 | lib.rs:1352-1367 快捷键语法测试 | 前后端两套解析器的语法契约不漂移 |

## 模块间交互

看护对象是 `apps/server`（spawn + 版本仲裁 + stop_server）；webview 载入 `apps/web/dist`。前端↔Rust：`invoke` 八个 command（stop_server/frontend_ready_for_open_paths/webview_history/confirm_quit/快捷键读写/open_new_window/claim_page/page_claims）；Rust→前端 `emit_to`：quit-requested / open-paths / page-claims。`open_new_window` 与 `windowToggle.ts`、`updater.ts` 是三个主要协作面。

## 扩展方式

**新增一个原生快捷键动作**：lib.rs 仿 `apply_toggle_shortcut`（L900）写注册函数或在其回调里分发 → command 加进 `invoke_handler`（L1098）→ 快捷键串语法契约同步改 `parses_the_frontend_shortcut_syntax` 测试 → 前端 `windowToggle.ts` 加转换与 invoke 包装 + `KeyboardSettings.tsx` 加设置行 → 持久化仿 `toggle_shortcut_file` 加 json 文件。

**升级 Node 版本 / 加 Linux 支持**：`bundle-server.mjs` 的 `NODE_VERSION`（需同步 dev Node major 与 `--target=node22`）、`TERMANY_TARGET_ARCH`、`NODE_DIST_URL`；Linux 需在 `tauri.linux.conf.json` 加 `resources/server/**/*`；resource 路径映射变化要同步 `spawn_server_child` 的 fallback 与 `is_termany_server_command` 的路径匹配。

**新增一个前端可调的原生能力（如系统通知）**：新 `#[tauri::command]` 函数 + `generate_handler![]` + capabilities 权限；前端 `invoke` 动态 import + `isTauri` 守卫（照抄 windowToggle.ts 模式）。
