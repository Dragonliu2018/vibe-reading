---
source:
  type: "源码解读"
  project: "neon"
  url: "https://github.com/neondatabase/neon"
title: "Control Plane 与测试体系"
date: "2026-10-02T15:00:33+08:00"
category: [Database, OLTP, Neon, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["Neon", "neon_local", "pytest", "E2E 测试", "CLI"]
description: "neon_local 本地编排 CLI 与 test_runner 端到端测试框架：flock 串行、真实二进制全链路、allowed_errors 白名单与版本混跑矩阵"
readingTime: "30 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/Neon/CodeWiki/main-2026-08/00-overview)

---

## 模块定位（Control Plane / neon_local）

`control_plane/` 产出 `neon_local` CLI（`cargo neon` 即别名）。**定位是开发/测试编排工具，不是生产控制面**（README 明示 "not suitable for production"）——生产侧 K8s 编排与 console 在独立仓库。它管的"控制面"是：拉起本地全栈进程（storcon/broker/pageserver/safekeeper/endpoint_storage）、创建 tenant/timeline/endpoint、分支映射。`storcon_cli`（1.5k 行子 crate）是 storcon 的 HTTP 客户端 CLI（40+ 子命令：node register/migrate、tenant policy、shard split 等，主要服务测试与运维）。

值得澄清一个常见误解：neon_local **从首个提交起就是 Rust**（2021-03 `c018247c5` "[issue #7] CLI first commit"），并非"Rust 重写了 Python 版"——Python 的部分一直是 test_runner（见下半篇）。

## 核心实现（neon_local）

**状态即一个 TOML 文件**：全部环境状态序列化为 `.neon/config`（`LocalEnv` → `OnDiskConfig`），`main()` 先取 `RepoLock`（flock `.neon` 目录）串行化并发 CLI——可 grep、可 diff、测试可整目录快照拷贝恢复。pageservers 列表刻意**不存** config，加载时扫描 `pageserver_*/pageserver.toml` 重建（`load_config`，`local_env.rs:703`）——消除双份真源漂移。

进程管理的几个讲究：pidfile 用 **fcntl 锁**而非裸 pid（进程死后 pid 被 OS 复用时 stop 不误杀，`background_process.rs:182` 注释 "Lucky we didn't harm anyone"）；对非 Neon 二进制，锁由父进程在 fork-exec 间隙经 `pre_exec_create_pidfile`（`:310`）抢建、并去掉 FD_CLOEXEC 让锁跨 exec 存活——pidfile 从诞生起就由子进程自身持有。`stop_process` 读到"文件存在但无进程持锁"（`PidFileRead::NotHeldByAnyProcess`）时既不 kill 也不删文件——三态判断防竞态。就绪探测是 **HTTP 语义探测**而非进程存活——探 `/status`，transport 错误重试、应用层错误 fail-fast（端口监听 ≠ 服务可用）；storcon 本地实例配真 Postgres 持久化（initdb + `fsync=off` + startup.sql 注入点），让 DB 代码路径真实跑过。`neon start` 用 tokio `JoinSet` 并发拉起，任一失败全部回滚；storcon 先起，pageserver 通过 `control_plane_api` upcall 向它**自注册**，`neon_start_status_check` 轮询到全部 Active。

endpoint 启动链：`neon endpoint start` → storcon `tenant_locate` 拿 shard→pageserver 连接信息 → `Endpoint::start`（`endpoint.rs:702`）先删上次遗留的 pgdata、写 ComputeSpec、再 spawn **`compute_ctl`**（不是 CLI 直接 pg_ctl！pid 记入 compute_ctl.pid，stop 时 `wait_for_compute_ctl_to_exit` 等它收尸）→ 轮询 compute_ctl HTTP `/status` 到 Running。CLI 的 `pg_ctl()` 只用于 stop。分支名→timeline 的映射（`branch_mappings.rs`）落盘进 TOML，`neon timeline branch` 同样经 storcon 走 Branch 模式。

## 模块间交互（neon_local）

对 storcon：tenant/timeline/branch 全部 HTTP（含 `timelines_onto_safekeepers`——把新 timeline 放上 SK 集群）；对 compute：spawn compute_ctl 并等其 HTTP 就绪；对 test_runner：被 `NeonLocalCli`（`neon_cli.py:141`）subprocess 驱动，wrapper 强制显式传 tenant_id/pg_version（拒绝隐式默认——防止测试暗中依赖全局状态）。兼容性设计：storcon 二进制永远取 `current_exe` 同目录（`local_env.rs:462`），旧版 pageserver/safekeeper 可配新版 storcon 运行（升级测试的基础）。

**扩展方式**（以 `endpoint_storage` 为现成范例）：`LocalEnv`/`OnDiskConfig` 加配置字段 → 新建 `src/xxx.rs`（`from_env/init/start/stop` 四件套，就绪闭包注入 `start_process`）→ `neon_local.rs` 加子命令 + `handle_start_all_impl` 并发启动 + `try_stop_all` 逆序停止 → 测试侧 `neon_cli.py` 加 typed wrapper。

---

## 模块定位（test_runner）

`test_runner/`（76k 行 Python，258 文件）是 Neon 的质量地基，也是仓库里 degree 最高的 god 对象聚集地：graphify 统计 `NeonEnvBuilder` 644 条边、`NeonEnv` 435 条边——**测试夹具就是全仓库的架构总装图**。规模：`regress/` 151 个文件 582 个测试函数（pageserver/存储层 ~43、compute/PG 语义 ~38、tenant/storcon/sharding ~19、proxy/auth ~10、wal/safekeeper ~9、branching ~7）；另有 `performance/`（38 个场景）、`sql_regress/`、`cloud_regress/`、`random_ops/`（20k 行模糊测试）、`pg_clients/`（9 种语言驱动）。

## 核心实现（test_runner）

**端到端真实二进制优先**：`NeonEnvBuilder.init_start()` 经 `neon_local` CLI fork 出**真实的** pageserver/safekeeper/storcon/compute_ctl 进程（非 mock、非进程内嵌入），teardown 还要跑 scrub 校验远端一致性（`__exit__`，`neon_fixtures.py:999`）。为什么：Neon 的 bug 集中在跨进程协议与持久化边界，只有全链路能覆盖——这一选择决定了整个框架的形态。

环境加速三板斧：`build_and_use_snapshot`/`from_repo_dir`（repo 目录快照共享，测试间不重复 initdb）、端口按 xdist worker 分段（`worker_base_port = 15000 + seq*(32768-15000)/N`）、`RemoteStorageKind::{LOCAL_FS, MOCK_S3, REAL_S3}`（moto 起本地 S3；`ENABLE_REAL_S3_REMOTE_STORAGE` 开真 S3，15 个 regress 文件自动加跑）。

**版本混跑矩阵**：`_mix_versions()`（`utils.py:759`）按组件硬链新旧二进制到 mixdir，配 `VERSIONS_COMBINATIONS` 5 组合验证升级路径——存算分离使各组件可独立升级，测试矩阵就得跟着覆盖组合；`COMPATIBILITY_NEON_BIN` / `COMPATIBILITY_POSTGRES_DISTRIB_DIR` 环境变量未设置时旧版本组合自动跳过（CI 只在有旧构建产物时才跑兼容矩阵）。

**allowed_errors 白名单 + 无错误收尾**：默认把任何服务的 ERROR/WARN 日志变成测试失败；预期错误必须显式正则白名单（`env.pageserver.allowed_errors.extend([...])`），teardown `assert_no_errors()` 扫全量日志（另有 `scripts/check_allowed_errors.sh` 防白名单滥用）。这是"测试绿但日志埋雷"的解药，也是本框架最值得借鉴的机制。

**故障注入三通道**：`PageserverHttpClient.configure_failpoints`（HTTP failpoints，"pause" 后用 `wait_until_paused` 确认生效）、`add_persistent_failpoint`（跨重启重放）、环境变量（FAILPOINTS/AWS_* 白名单透传）。性能基线：`neon_with_baseline`（`compare_fixtures.py:357`）按 [vanilla, neon] 参数化同机对照，结果写 junitxml → `scripts/ingest_perf_test_result.py` 入库 → Grafana；pytest-split 按近 10 天实测时长把 38 个 perf 测试均衡切 5 组。

一个典型测试骨架（`regress/test_branching.py::test_branching_with_pgbench`）：

```python title="test_runner/regress/test_branching.py（节选）"
def test_branching_with_pgbench(neon_simple_env, pg_bin):
    env = neon_simple_env                       # fixture: 现成全栈环境
    env.create_tenant(conf={"gc_period": "0s"})  # 显式配置
    env.create_branch("b0")
    ep = env.endpoints.create_start("b0")        # 分支上起 compute
    # 后台 pgbench 负载 + 循环建分支，断言各分支数据独立
    ep.safe_psql("SELECT count(*) FROM pgbench_accounts")
```

## 运行与 CI

`pytest.ini`：`testpaths=test_runner`、默认排除 `remote_cluster` marker、全局 timeout=300。CI 并行：pytest-xdist `-n12 --dist=loadgroup`（loadgroup 使 xdist_group 与 pytest-order 兼容）、`--reruns 2` 处理与 pytest-timeout 的冲突；regress 在 release 非 sanitizer 下 session-timeout 3000s；矩阵再乘 pg_version(v16/v17) × lfc_state × build_type。云侧测试（`remote_cluster` marker）需 `NEON_API_KEY` 或 `BENCHMARK_CONNSTR`，默认排除。

**修改建议路径**：想理解某个服务的行为，先读它的 fixture（`fixtures/pageserver/http.py` 的 70+ 方法就是 pageserver 管理 API 的完整清单）；想加测试，从 `neon_simple_env`（`neon_fixtures.py:1681`）起步，日志断言用 `log_contains` + `wait_until`（`utils.py:391`，20s/0.5s）。

---

## 附：Scrubber 测试与 CLI 的关系

巡检/GC 类改动直接在 `test_runner/regress/test_scrubber.py` 复现 S3 不一致状态（failpoint 注入半截上传）后用 `neon_local` 的 scrubber 入口验证——CLI（`storcon_cli`）、scrubber、test_runner 三者在测试场景里天然联动，这也是 Neon 把"运维工具"放进主仓库的好处：开发-测试-运维共享同一套二进制。
