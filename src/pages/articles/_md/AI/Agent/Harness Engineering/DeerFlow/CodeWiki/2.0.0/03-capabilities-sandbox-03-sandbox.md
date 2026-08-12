---
source:
  type: "源码解读"
  project: "deer-flow"
  url: "https://github.com/bytedance/deer-flow"
title: "Sandbox"
date: "2026-08-12T10:45:17+08:00"
category: [AI, Agent, "Harness Engineering", DeerFlow, CodeWiki, "2.0.0"]
tags: ["DeerFlow", "Python", "Sandbox", "E2B", "Docker"]
description: "DeerFlow 沙箱模块解析：SandboxProvider 可插拔契约、warm-pool 对象池、跨进程 ownership lease、LocalSandbox/E2B/AIO 多后端。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 概览](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/00-overview) > [← 能力扩展与沙箱](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/03-capabilities-sandbox)

---

## 模块定位

本模块属于 **能力扩展与沙箱** 子系统。agent 执行代码（bash/read_file/write_file/glob/grep）需要一个隔离边界——DeerFlow 把它做成可插拔 provider：本地开发用 `LocalSandbox`（subprocess + path mapping），容器化用 `AioSandboxProvider`（Docker/K8s），云用 `E2BSandboxProvider`（e2b micro-VM），内部平台用 `BoxliteProvider`/`TenkiSandboxProvider`。两层 ABC（`SandboxProvider` 管理生命周期 acquire/get/release，`Sandbox` 管执行 execute_command/read/write/glob/grep）+ warm-pool 复用 + 跨进程 ownership lease + 安全策略（env_policy/path_patterns/read_before_write）。

## 核心实现

### SandboxProvider ABC

```python title=backend/packages/harness/deerflow/sandbox/sandbox_provider.py
class SandboxProvider(ABC):
    uses_thread_data_mounts: bool = False
    @abstractmethod
    def acquire(self, thread_id=None, *, user_id=None) -> str: ...   # 返回 sandbox_id
    async def acquire_async(self, thread_id, *, user_id=None) -> str: ...  # asyncio.to_thread
    @abstractmethod
    def get(self, sandbox_id: str) -> Sandbox | None: ...
    @abstractmethod
    def release(self, sandbox_id: str) -> None: ...
    def reset(self) -> None: ...   # 清 provider 级缓存

def get_sandbox_provider():  # config.sandbox.use + resolve_class 动态导入, 单例
```

### Sandbox ABC

```python title=backend/packages/harness/deerflow/sandbox/sandbox.py
class Sandbox(ABC):
    @abstractmethod
    def execute_command(self, command, env=None, timeout=None) -> str: ...
    @abstractmethod
    def read_file(self, path, start_line=None, end_line=None) -> str: ...
    @abstractmethod
    def write_file(self, path, content, append=False) -> None: ...
    @abstractmethod
    def list_dir(self, path, max_depth=2) -> list[str]: ...
    @abstractmethod
    def glob(self, path, pattern, *, include_dirs=False, max_results=200) -> tuple[list[str], bool]: ...
    @abstractmethod
    def grep(self, path, pattern, *, glob=None, literal=False, ...) -> tuple[list[GrepMatch], bool]: ...
# _validate_extra_env(): env key 须 ^[A-Za-z_][A-Za-z0-9_]*$ (防 shell-splicing 注入)
```

### LocalSandbox — subprocess 实现

```python title=backend/packages/harness/deerflow/sandbox/local/local_sandbox.py
class LocalSandbox(Sandbox):
    def __init__(self, id, path_mappings=None):
        self.path_mappings = path_mappings or []  # container<->local, read_only 标志
        self._agent_written_paths: set[str] = set()
    def execute_command(self, command, env=None, timeout=None) -> str:
        # 1. _validate_extra_env  2. _resolve_paths_in_command (container→local)
        # 3. _get_shell (zsh/bash/sh/PowerShell)  4. build_sandbox_env (减平台密钥)
        # 5. subprocess.Popen(start_new_session=True) + _BoundedPipeCapture (10MB 上限)
        # 6. 超时 → _terminate_process_group (SIGKILL 整进程组)
        # 7. _reverse_resolve_paths_in_output (local→container)
```

### AioSandboxProvider — AIO 容器（god 78）

```python title=backend/packages/harness/deerflow/community/aio_sandbox/aio_sandbox_provider.py
class AioSandboxProvider(WarmPoolLifecycleMixin[SandboxInfo], SandboxProvider):
    def __init__(self):
        self._sandboxes: dict[str, AioSandbox] = {}
        self._warm_pool: dict[str, tuple[SandboxInfo, float]] = {}  # 释放后保持运行的容器
        self._thread_sandboxes: dict[tuple[str,str], str] = {}      # (user,thread)→id
        self._ownership: SandboxOwnershipStore = make_sandbox_ownership_store(...)
        self._backend = self._create_backend()  # LocalContainerBackend or RemoteSandboxBackend
        # 启动: _reconcile_orphans() + _start_lease_renewal() + _start_idle_checker()
```

### E2BSandboxProvider — 云沙箱（god 75）

```python title=backend/packages/harness/deerflow/community/e2b_sandbox/e2b_sandbox_provider.py
class E2BSandboxProvider(SandboxProvider):
    uses_thread_data_mounts = False  # 云沙箱无共享文件系统
    def __init__(self):
        self._warm_pool: OrderedDict[str, tuple[str, float]] = OrderedDict()  # LRU
        self._reserved_slots = 0; self._transitioning_slots = 0
        self._capacity_cond = threading.Condition(self._lock)
        self._deployment_capacity = make_e2b_capacity_store(...)  # 部署级容量
```

## 调用链路

### acquire 流程（ensure_sandbox）

```
agent tool 调用 (execute_command)
  ▼ sandbox/tools.py → get_sandbox_provider().acquire(thread_id, user_id)
  ▼ _get_thread_lock(thread_id, user_id)  # 串行化同 thread acquire/release
  ▼ _acquire_internal:
  ├─ 1. _reuse_in_process_sandbox()   # 查 _thread_sandboxes 缓存, is_alive/ping, take lease
  ├─ 2. _reclaim_warm_pool_sandbox()   # 从 warm pool 提升, reconnect+liveness, take lease
  ├─ 3. _discover_remote_sandbox()     # 查远程已有 (E2B: Sandbox.list(metadata); AIO: backend.discover)
  └─ 4. _create_sandbox()              # 冷启动: _reserve_capacity → backend.create() → bootstrap+mounts
```

### warm-pool 生命周期（AioSandboxProvider）

```
release(sandbox_id) → 容器不停, 放入 _warm_pool[id] = (info, timestamp)
  ├─ Idle Checker Thread (每 IDLE_CHECK_INTERVAL):
  │    _reconcile_orphans (peer lease 过期 adopt) + _cleanup_idle_sandboxes + _reap_expired_warm
  ├─ Lease Renewal Thread (独立于 idle checker!):
  │    _renew_owned_leases: renew()→RENEWED keep / LAPSED re-claim / LOST forget (不碰容器)
  └─ _evict_oldest_warm (replicas 超限 LRU 驱逐)
```

**为什么 renewal 和 idle checker 独立**：`idle_timeout: 0`（支持的"keep warm VMs until shutdown"配置）时 idle checker 不启动，若 renewal 折叠进去会静默停止让所有 lease 过期，重新引发 #4206 跨实例杀沙箱 bug。

## 设计模式

| 模式 | 位置 | 说明 |
| --- | --- | --- |
| 策略 | `get_sandbox_provider` + `resolve_class` | `config.sandbox.use` 指向 provider 类，运行时切换 |
| 抽象基类 | `SandboxProvider` + `Sandbox` | 两层 ABC：生命周期契约 + 执行契约 |
| 对象池 | `_warm_pool` | 释放不销毁，下次跳过冷启动。AIO dict / E2B OrderedDict LRU |
| 所有权存储 | `SandboxOwnershipStore` | 跨进程 lease（Redis/memory），take/claim/renew/release |
| 同进程排除 | `_local_teardown` + `_acquire_epoch` | lease store 只排除 peer，不排除同进程自己，填补 reaper→acquire 竞态 |
| Context Manager | `_held_teardown_lease` | 心跳线程刷新 `del:` marker 直到容器停止 |
| Bounded Pipe | `_BoundedPipeCapture` | 不用 `communicate()`（backgrounded 进程会阻塞），daemon thread drain + 10MB 上限 |

## 模块间交互

- **依赖**：`config`（SandboxConfig use/image/port/replicas/idle_timeout/ownership + paths）、`community` providers（resolve_class 动态加载）、`persistence`/ownership（SandboxOwnershipStore Redis/memory + E2B capacity store）、`sandbox/env_policy`（build_sandbox_env）、`sandbox/path_patterns`（output mask）、`integrations.lark_cli`（sandbox mounts）。
- **被调用**：`sandbox/tools.py`（暴露 execute_command/read_file 等工具）、`agents/middlewares/sandbox_audit_middleware`（审计）、`agents/middlewares/read_before_write_middleware`（先读后写）。
- **多 provider 切换**：`config.yaml` 的 `sandbox.use` 决定 provider，`get_sandbox_provider` 读取后 `resolve_class` 动态导入构造单例。切换需 `reset_sandbox_provider` 或重启。

## 核心实现（续）

### 为什么可插拔 provider

不同部署需不同沙箱后端（本地 subprocess / 生产容器 / 云 micro-VM / 内部平台）。ABC 契约让上层 agent 不感知后端差异，配置驱动切换避免硬编码。

### 为什么 warm-pool

容器/VM 冷启动数秒到数十秒，agent 在一个 thread 可能多次需沙箱（执行→读结果→再执行）。warm pool 让 release 不销毁，下次 reclaim 跳过冷启动；`idle_timeout` 控空闲清理；`replicas` 控最大并发，超限 LRU 驱逐。

### 为什么 ownership store

多 gateway 实例共享容器后端时无跨进程协调：实例 A idle checker 看容器"空闲"停掉，实例 B 正把该容器给 agent 用 → 跨实例杀沙箱（#4206）。`SandboxOwnershipStore` 通过 Redis lease：`take` 获取、`renew` 续约、`claim(for_destroy=True)` 标 `del:` 阻止 acquire。peer lease 过期后才能 adopt orphan，`_adoptable_after_grace` 加 grace period 防 Redis 重启误判。同进程内 lease store 不排除自己，故 AioSandboxProvider 额外用 `_local_teardown` + `_acquire_epoch` 填竞态。

### 为什么 env_policy/path_patterns/read_before_write

`build_sandbox_env` 继承 `os.environ` 减平台密钥再叠加 per-call env，防凭据泄漏到 skill 子进程；`path_patterns` 统一 container↔local 路径重写（`_reverse_output_patterns` 和 tools 共享同一规则，防 #4035/#4055 drift bug）；`read_before_write` 确保写前先读已有内容防盲写覆盖。

### 为什么 LocalSandbox 用 daemon drain thread 而非 communicate()

`subprocess.communicate()` 阻塞到所有 pipe 关闭，但 agent 可能跑 `server &` backgrounded 进程继承 pipe，shell 已返回但 pipe 打开，`communicate()` 阻塞到 timeout。改用 daemon thread drain + `_BoundedPipeCapture`（10MB），`process.wait(timeout)` 能在 foreground shell 退出后立即返回。

## 扩展方式

### 新增沙箱 provider

实现 `TenkiSandboxProvider(SandboxProvider)`：`acquire`/`get`/`release`/`reset` + `__init__` 初始化 warm pool/ownership/backend + `uses_thread_data_mounts`；实现 `TenkiSandbox(Sandbox)` 的 8 个抽象方法；`config.yaml` 设 `sandbox.use: deerflow.community.tenki:TenkiSandboxProvider`；需 warm pool 则继承 `WarmPoolLifecycleMixin`。无需改核心——ABC + resolve_class 保证可插拔。

### 改 warm-pool 阈值

`config.yaml` 的 `sandbox.idle_timeout` / `replicas`（AioSandboxProvider 读 `SandboxConfig`）；E2B 额外 `overflow_policy`（wait/reject/burst）+ `acquire_timeout`。改配置后需 `reset_sandbox_provider` 或重启（provider 单例）。E2B 的 `idle_timeout` 通过 `_refresh_remote_timeout` → `client.set_timeout()` 推送到 e2b 控制面。

### 加 path 安全策略

`sandbox/path_patterns.py` 的 `build_output_mask_pattern`（唯一所有者，LocalSandbox 和 tools 都引用）调正则边界；改 `sandbox/env_policy.py` 的 `build_sandbox_env` 调过滤/注入。影响所有 provider（都通过这些函数编译正则/构建 env）。

对应测试：`backend/tests/sandbox/` + `community/test_aio_sandbox_provider.py` + `test_e2b_sandbox_provider.py`。
