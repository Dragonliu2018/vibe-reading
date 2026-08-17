---
source:
  type: "源码解读"
  project: "Multipass"
  url: "https://github.com/canonical/multipass"
title: "CLI 客户端"
date: "2026-08-17T11:04:42+08:00"
category: [OS, Virtualization, Multipass, CodeWiki, "1.16.2"]
tags: ["Multipass", "C++", "gRPC", "Qt", "命令模式"]
description: "multipass CLI：ArgParser 命令查找 + Command 模板方法 + gRPC 双向流，无状态 thin client。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Virtualization/Multipass/CodeWiki/1.16.2/00-overview)

---

## 模块定位

Client CLI 模块（`src/client/cli/`）是独立的 `multipass` 可执行文件，通过 gRPC 与 daemon 通信，自身不管理任何 VM 状态——它只负责参数解析、命令分发、用户交互和结果渲染，将所有副作用委托给 daemon，因此可独立编译、独立部署、无状态地作为 thin client 运行。

## 模块架构

四个核心组件：

- **ArgParser**（`include/multipass/cli/argparser.h`，god node 116 edges）：包装 `QCommandLineParser`，身兼三职——全局选项解析（`parse()`）、命令查找与分派（`findCommand()`）、子命令选项二次解析（`commandParse()`）
- **Client**（`src/client/cli/client.h`）：命令容器与分发入口，持有 `std::unique_ptr<multipass::Rpc::Stub>`（gRPC stub）+ `std::vector<cmd::Command::UPtr>`（33 个命令的拥有权）
- **Command**（`include/multipass/cli/command.h`）：命令抽象基类，纯虚 `run(ArgParser*)`；protected 模板方法 `dispatch()` 封装 gRPC 双向流
- **Formatter**（`include/multipass/cli/formatter.h`）：输出格式策略接口，4 个实现（`TableFormatter`/`JsonFormatter`/`CSVFormatter`/`YamlFormatter`），`formatter_for()` 工厂选择

返回码体系用 `std::variant`：`ReturnCodeVariant = std::variant<ReturnCode, VMReturnCode>`（`include/multipass/cli/return_codes.h:47`），`ReturnCode`（0/1/2/3/4/255）覆盖 CLI 自身退出码，`VMReturnCode` 是空枚举仅作 compile-time tag，用于 `exec`/`shell` 命令透传 VM 内部退出码。`main.cpp:47` 的 `std::visit` 统一转 `int`。

> 注：graphify god node 列出的 `OperationResult (40 edges)` 在代码中未找到，实际高扇入节点是 `ReturnCodeVariant` 与 `standard_failure_handler_for`（被所有命令的 `on_failure` 调用）。

## 调用链路

从 `multipass stop vm1` 到 gRPC 调用：

```
main.cpp:52  main()
  └─ top_catch_all("client", main_impl, argc, argv)          # 全局异常兜底
       └─ main_impl(argc, argv)                              main.cpp:34
            ├─ ClientConfig{server_address, cert_provider, term}
            ├─ Client client{config}                         client.cpp:83
            │    ├─ stub = Rpc::NewStub(make_channel(...))   # gRPC channel + SSL
            │    ├─ add_command<cmd::Stop>() / ...           # 注册 33 命令
            │    └─ sort_commands()                          # 按名排序
            └─ client.run(QCoreApplication::arguments())     client.cpp:136
                 ├─ ArgParser parser(arguments, commands, ...)
                 ├─ ParseCode = parser.parse(aliases)        argparser.cpp:123
                 │    ├─ QCommandLineParser 第一遍：提 command/verbose/help
                 │    ├─ findCommand(requested_command)       argparser.cpp:329
                 │    └─ 非命令→查 alias dict → prepare_alias_execution
                 ├─ parser.chosenCommand()->run(&parser)
                 │    └─ Stop::run(parser)                    stop.cpp:32
                 │         ├─ parse_args(parser)               # 二次解析
                 │         │    └─ parser->commandParse(this)  # QCommandLineParser 第二遍
                 │         └─ dispatch(&RpcMethod::stop, request, on_success, on_failure, ...)
                 │              └─ Command::dispatch()        command.h:71
                 │                   ├─ stub->stop(&context) → ClientReaderWriter
                 │                   ├─ client->Write(request)
                 │                   ├─ while(client->Read(&reply))
                 │                   │    └─ streaming_callback(reply)  # 打印 log_line
                 │                   ├─ client->Finish() → grpc::Status
                 │                   ├─ status.ok() → on_success(reply) → ReturnCode::Ok
                 │                   └─ !ok → on_failure → standard_failure_handler_for()
                 └─ std::visit → static_cast<int>(value)      # variant→退出码
```

`Client::run`（`client.cpp:165`）是唯一调 `chosenCommand()->run()` 的地方，所有命令经 `ArgParser::parse` 选出后统一走这条路径。

## 核心实现

### ArgParser 为何是 god node（116 度）

ArgParser 不是简单参数解析器，它承担三个职责：(1) 全局选项解析（`parse()`）；(2) 命令查找与分派（`findCommand()`）；(3) 子命令选项二次解析（`commandParse()`）。所有 33 个 Command 的 `run()` 都接收 `ArgParser*` 并经它访问解析结果（`isSet`/`value`/`positionalArguments`），因此每个 Command 都依赖 ArgParser → 116 条出边。设计意图：将"解析"作为独立关注点从 Command 剥离，Command 只"解释"参数而非"解析"参数，避免每个命令各自包装 `QCommandLineParser`。

### Command::dispatch：模板方法统一 streaming RPC

所有 29 个 RPC 方法都是 bidirectional streaming。`dispatch()`（`command.h:66-137`）定义 gRPC 双向流骨架：创建 context → `Write(request)` → `while(Read(reply))` 调 streaming_callback → `Finish()` → 成功/失败分派。具体命令只提供 `on_success`、`on_failure`、`streaming_callback` 三个 callable。重载版（`command.h:139-164`）为 `LogReply` 类型用 C++20 concepts 自动生成 streaming callback，减少样板。

关键细节：`UNAVAILABLE` 错误时检测 Unix socket 权限（`command.h:110-135`），把 `SocketAccessError` 转为更友好的 `PERMISSION_DENIED` 提示——这是 daemon 未运行 vs 权限不足的关键区分，集中在一处处理。

### 命令注册在构造函数硬编码

所有 33 命令在 `Client::Client()` 构造函数（`client.cpp:89-121`）经 `add_command<T>()` 显式注册。不用注册宏/自动注册，因命令构造参数不统一——部分需 `AliasDict&`（`Launch`/`Exec`/`Delete`），部分不需要（`Find`/`Info`）。显式构造让依赖注入一目了然，`sort_commands()` 保证 `help` 按字母序。

### gRPC 认证与密码交互

`client_common.cpp:148` `make_channel()` 用 `grpc::SslCredentials`，证书由 `SSLCertProvider` 管理，root cert 从平台路径读。地址优先 `MULTIPASS_SERVER_ADDRESS` 环境变量，否则 `platform::default_server_address()`。部分 RPC（`launch`/`start`/`restart`/`mount`/`set`）支持 `password_requested` 字段，client 在 streaming callback 检测到后调 `handle_password()` 向同一 stream 写回密码（`common_callbacks.h:57-62`）。

## 模块间交互

- 依赖 `multipass.proto`（gRPC service 29 方法）、`client_common`（channel/SSL）、`settings`（客户端配置）、`AliasDict`（本地 alias）、`Terminal`（终端 I/O）
- `exec`/`shell`/`transfer` 命令直接 SSH 到 VM（不经 daemon）：链接 `ssh_client`/`sftp_client`
- 依赖 Qt6（`QCommandLineParser`、`QLocalSocket` 检测 daemon socket 权限）
- 与 daemon 的通信契约：`src/rpc/multipass.proto` 的 `service Rpc`，全部双向流

## 扩展方式

新增 CLI 子命令（如 `multipass foo`）：

1. 新建 `src/client/cli/cmd/foo.h` + `foo.cpp`：继承 `cmd::Command`，实现 `run()`/`name()`/`short_help()`/`description()`，`run()` 内 `parse_args` 后 `dispatch(&RpcMethod::foo, request, on_success, on_failure, ...)`（参考 `stop.cpp` 模式）
2. `src/client/cli/client.cpp` 头部 `#include "cmd/foo.h"`；构造函数加 `add_command<cmd::Foo>()`
3. `src/client/cli/cmd/CMakeLists.txt:16` 的 `add_library(commands STATIC ...)` 加 `foo.cpp`
4. 若需新 RPC：`src/rpc/multipass.proto` 加 `rpc foo` + message（daemon 侧见 [守护进程](/vibe-reading/articles/OS/Virtualization/Multipass/CodeWiki/1.16.2/01-daemon) 扩展方式）

改已有命令输出格式（如 `list` 加列）：proto `ListVMInstance` 加字段 → 4 个 Formatter 实现全改（策略模式平行实现）→ `list.cpp` 的 `parse_args` 加 `--format` 选项控制。
