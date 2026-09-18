---
source:
  type: "源码解读"
  project: "Odysseus"
  url: "https://github.com/odysseus-dev/odysseus"
title: "Cookbook 硬件适配"
date: "2026-09-18T17:28:00+08:00"
category: [AI, Agent, Workspace, Odysseus, CodeWiki, "dev-2026-09"]
contentType: "CodeWiki"
tags: ["Odysseus", "VRAM 估算", "模型推荐", "tmux"]
description: "Odysseus Cookbook：hwfit 硬件指纹（NVIDIA/AMD/Apple/Windows 四路探测）→ MoE 感知的 VRAM 估算公式 → 模型推荐三档 profile → tmux 下载与 serve → 端点自动注册 + 崩溃看门狗 + 生命周期循环。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/00-overview)

---

## 模块定位

Cookbook 回答"**这台机器到底能跑什么模型**"：探测硬件指纹 → 估算每个模型每种量化的显存占用 → 推荐三档 serve profile → 用 tmux 下载（`hf download`）→ 拉起 serve → 自动注册成 Odysseus 端点（模型 picker 立即可用）→ 崩溃看门狗与到点停止。它是 Odysseus 与本地模型生态（HuggingFace / llama.cpp / vLLM / SGLang / Ollama / MLX）之间的"装机向导"。ROADMAP 承认这是最依赖真实机器的域："Cookbook reliability on other computers. This is probably the area most likely to need work across different machines, GPUs, drivers, shells"。

代码分布：`services/hwfit/`（3173 行，纯算法）、`routes/cookbook_routes.py`（4583 行）+ `routes/cookbook_helpers.py`（1482 行）+ `routes/cookbook_output.py`、`routes/hwfit_routes.py`（456 行）、`src/cookbook_serve_lifecycle.py`（219 行）；辅助脚本 `scripts/hf_download.py`、`scripts/import_from_vllm_recipes.py`、`scripts/check-docker-gpu.sh`（NVIDIA）/ `check-docker-amd-gpu.sh`。

## 模块架构

三层：**hwfit 算法层**（`services/hwfit/`，纯 dict、无 class——`hardware.py` 探测、`models.py` 模型目录、`fit.py` 打分、`profiles.py` serve 三档 profile）→ **路由编排层**（cookbook_routes：下载/serve/端口/注册）→ **生命周期层**（`cookbook_serve_lifecycle.py` 的 startup task + `cookbook_state.json` 状态外置）。数据契约是**命令字符串**：serve/download 都是生成 bash/PowerShell 文本经 tmux/SSH 执行，端口、endpoint 注册、生命周期全靠正则从命令字符串反解——"命令字符串即合约"。

**硬件指纹**（`detect_system()` in `services/hwfit/hardware.py`）产出统一 dict：`total_ram_gb / available_ram_gb / cpu_name / cpu_arch / gpu_name / gpu_vram_gb / gpu_count / gpus / gpu_groups / unified_memory / backend`，按 `_cache_key()`（`(host or '_local', str(ssh_port or ''), platform.lower())` 三元组——**同一 host 别名经不同 ssh_port 或平台进不同条目**）缓存，TTL 24h（`CACHE_TTL`），`fresh=True` 走 Rescan 按钮。平台探测分派：`_detect_nvidia()`（nvidia-smi CSV；`memory.total` 非数字的统一内存设备（GB10/DGX Spark，issue #1340）进 `unified` 列表——`vram_gb` 取系统 RAM（`_get_ram_gb()`），返回带 `unified_memory=True` / `homogeneous=True`；输出含 nvml / driver mismatch 关键字时设 `_last_gpu_error` 返回 None）、`_detect_amd()`（sysfs DRM + rocminfo）、`_detect_apple_silicon()`（ioreg）、`_detect_windows()`（单条 PowerShell/WMI 聚合——减少 SSH 往返），Linux 走 `/proc` + `os.sysconf`。

**模型目录**（`services/hwfit/models.py`）：静态目录 `data/hf_models.json` + MLX 缓存 + vLLM recipes 标记合并（`get_models()`）；三张量化常量表 `QUANT_BPP / QUANT_SPEED_MULT / QUANT_QUALITY_PENALTY` 驱动估算。

## 调用链路

`detect_system()` → `hwfit_routes.py` 的 `GET /system` → 前端带 host 参数调 `GET /models` → `rank_models()` / `analyze_model()`（`fit.py`；多卡（`gpu_count >= 2`）且未指定 quant 时默认尝试 `BF16`；`_try_quant_at()` 决定 `run_mode`: gpu / cpu_offload / cpu_only，context 减半回退；多卡且选 Q*/IQ GGUF 档位直接 `return None`——vLLM/SGLang 无法服务 GGUF）→ 用户选定后 `POST model_download`（`model_download()` in `routes/cookbook_routes.py:1065`，tmux + `hf download`，输出 ANSI 剥离后经 `tmux capture-pane` 回流，`DOWNLOAD_OK/FAILED` 标记收尾）→ `model_serve()`（`:1962`，命令经 `_validate_serve_cmd()` 与 `_normalize_minimax_m3_vllm_cmd()` / `_normalize_deepseek_v4_sglang_cmd()` 等按模型特化修补）→ `_auto_register_llm_endpoint()`（`:1759`，端口优先级 `--port N` > `OLLAMA_HOST=host:port` > ollama 默认 11434 > 其他 8080；主机名三种情况——本地 serve 取 `localhost`（tmux 在容器内跑）、命令匹配 `docker exec ollama-*` 取 `host.docker.internal`、远程 serve 取 `remote.split('@')[-1]` 去掉 SSH 用户名；写入 `ModelEndpoint` 表，模型 picker 经 `/v1/models` 探测点亮；image 模型走 `_auto_register_image_endpoint()` `:1521`）→ `_serve_crash_watchdog()`（`:1649`，`_waits = [25, 35, 60, 180]` 秒轮询窗口，经 `tmux capture-pane` 匹配 `=== Process exited with code (-?\d+) ===` 正则——**exit code == 0 保留 endpoint**、非零时删除前先探测 `base_url` 的 `/models`，可达则保留；本地 Windows（无 tmux）直接跳过监控）→ `cookbook_serve_lifecycle_loop()`（`src/cookbook_serve_lifecycle.py`，app.py:1270 注册为 startup task，每 60s `_tick()` 处理 `_scheduledStopAtMs` 早于当前时间且状态不在 stopped/ended/killed/crashed 的 serve：`_stop_serve()` + `_delete_endpoint_for_task()`）。

## 核心实现

### VRAM 估算：MoE 拆分

`estimate_memory_gb(model, quant, ctx)` in `services/hwfit/models.py` 的公式：**总参数 × bpp + 0.000008 × 活跃参数 × ctx + 0.5**——MoE 全部 expert 计权重、仅活跃参数计 KV cache（`_active_params_b()`）。为什么：llama.cpp / vLLM 常驻全部 expert，但每 token 只激活一条 expert 路径的 KV。配套：GPU-only 模式将 offload 预算置零（修复"96GB GPU 仍列出 175GB 模型"）；GPU 离散内存下 `fit_level` 需 1.5× 余量才算 perfect（vLLM 分配器 / KV / runtime 开销）；GGUF 不能多卡分片故用单卡 VRAM（`effective_vram`），而 AWQ/GPTQ/FP8 由 vLLM 分片故用全量。

### 平台探测差异

NVIDIA 一条命令拿全（含 GB10/DGX Spark 统一内存 N/A 特判，issue #1340）；AMD 无统一 CLI——读 `/sys/class/drm/card*/device/mem_info_{vram,vis_vram,gtt}_total`，`max(vram, vis)` 且 vis≥vram 判 APU（Strix Halo），ISA 靠 `rocminfo` 的 `classify_amd_gfx()`；nvidia-smi 三级回退（直接 → `bash -lc` 补 PATH → `NVIDIA_PATH_CANDIDATES` 绝对路径，兼容 WSL）。容器内探测有 `_hardware_visibility_warning()` 提示"Docker 未透传 GPU"并引导 Manual Hardware。`_lookup_bandwidth()` / `_lookup_apple_bandwidth()` 是带宽查表现成范式——新增硬件维度的样板。

### 下载与 serve 的工程细节

下载优先 hf_transfer（Rust 并行，`HF_HUB_DOWNLOAD_MAX_WORKERS=8`），但其在超大文件末段易崩——重试时 `disable_hf_transfer` 降级到 4 workers；自定义目录用 `HF_HOME` 环境变量而非 `--local-dir`，因为 blob 缓存的 `.incomplete` 支持断点续传（issue #2722）。`_pick_free_port_for_ollama()`（`:1595`）避免复用 Cookbook 杀不掉的 systemd ollama——本地 socket connect 探测、远程 bash `/dev/tcp` 免依赖 ss/netstat。生命周期 loop 写回前**重读状态文件**，避免覆盖并发 UI 写入。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 数据驱动目录 | `hf_models.json` + `import_from_vllm_recipes.py` 导入（`--update-existing` 打标） | 模型目录更新不用改代码 |
| 分层探测回退 | `_detect_nvidia()` 三级回退；下载 CLI→hub→pip 回退链 `_pip_install_fallback_chain()` | WSL/裸机/容器环境差异大 |
| 命令字符串即合约 | `_validate_serve_cmd()` + `_auto_register_llm_endpoint()` 正则反解 | serve 命令即单一真源，注册/生命周期从它推导 |
| 状态外置 | `COOKBOOK_STATE_FILE = DATA_DIR/cookbook_state.json`（`src/constants.py:32`） | 崩溃后可恢复 |

## 模块间交互

与 `src/model_discovery.py` 独立（发现扫端口，Cookbook 写 `ModelEndpoint` 表接入同一 picker）；served 模型被 agent 层 `adopt_served_model` 消费；`scripts/check-docker-gpu.sh` 是纯诊断脚本（Odysseus 不自动调用）。⚠️ 待核实：Cookbook 路由不直接调 task_scheduler——下载/serve 用 tmux session + `cookbook_state.json` 自管理，与全局调度器是并行体系。

## 扩展方式

新增一个硬件维度参与推荐：① `detect_system()` 及对应 `_detect_*()`（`hardware.py`）加字段并进 cache dict；② `analyze_model()`（`fit.py`）读取新字段参与 `_try_quant_at()` 预算或 `_estimate_speed()`（带宽查表是现成范式）；③ `hwfit_routes.py` 的 `GET /models` 需要则加 query 参数接 `_apply_manual_hardware()`；④ 前端 settings 页透传。风险点：`_cache_key()` 不含新维度时 24h 缓存会掩盖变化。
