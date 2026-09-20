---
source:
  type: "源码解读"
  project: "supabase"
  url: "https://github.com/supabase/supabase"
title: "docker 自托管编排"
date: "2026-09-20T18:30:00+08:00"
category: [Database, Ecosystems, Supabase, CodeWiki, "self-hosted-0.8.0"]
contentType: "CodeWiki"
tags: ["Supabase", "Docker", "自托管", "Envoy", "PostgreSQL"]
description: "docker/ 自托管栈：12 服务拓扑、网关与存储双可插拔、setup.sh 引导与 update.sh 的 3-way merge 生命周期。"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Ecosystems/Supabase/CodeWiki/self-hosted-0.8.0/00-overview)

---

## 模块定位

`docker/` 目录是 Supabase 自托管产品的全部交付物：一条 `docker compose up` 拉起完整平台（studio/envoy/gotrue/postgrest/realtime/storage/imgproxy/postgres-meta/edge-runtime/postgres/supavisor），加上 `setup.sh`（bootstrap）/`update.sh`（3-way merge 升级）/`run.sh`/`reset.sh` 生命周期脚本与 DB 初始化 SQL。这个模块与 monorepo 其它部分完全不同域：它编排的都是**外部仓库的成品镜像**，本仓库只做接线（环境变量 + 网关路由 + 初始化 SQL）。

## 模块架构

![自托管部署栈服务拓扑](/vibe-reading/images/articles/supabase-internals/self-hosted-topology.svg)

单默认网络（服务名即 DNS 名），12 服务。核心拓扑事实：`api-gw`（envoy 默认，宿主 :8000）是唯一对外的统一入口，路由 studio/auth/rest/realtime/storage/functions；`db`（PG 17）无宿主端口，只有 `supavisor` 池化对外发布 5432（session）/6543（transaction）；`meta`（postgres-meta :8080）被 studio 直连（`STUDIO_PG_META_URL: http://meta:8080`）执行 SQL。一个反直觉的依赖：`api-gw` → `studio (service_healthy)`——因为 envoy 健康检查只是 TCP 端口探测，但 gateway 要反代 studio 的 3000。

v0.8.0 的标志性设计：**gateway 可插拔**。三层手段：服务统一命名 `api-gw`（而非网关名）；`api-gw` 在默认网络同时注册 `envoy` 和 `kong` 两个 network alias（compose 第 74-80 行）——无论启用哪个网关，内部引用 `http://kong:8000` 或 `http://envoy:8000` 都能解析到当前活跃网关；下游 TLS 层（caddy/nginx override）只依赖 `api-gw` 服务名。`docker-compose.envoy.yml` 现在是 no-op shim（`services: {}`）——envoy 已是默认，保留一版防旧 `COMPOSE_FILE` 引用报错。

<details>
<summary>服务清单速查</summary>

| 服务 | 镜像 | 端口 | 健康检查手段 |
| --- | --- | --- | --- |
| studio | supabase/studio:2026.08.03 | 3000（不映射宿主） | `node -e fetch /api/platform/profile` |
| api-gw | envoyproxy/envoy:v1.39.0 | 宿主 :8000 | `/dev/tcp` bash 探测（镜像无 curl） |
| auth | supabase/gotrue:v2.189.0 | 9999 | `wget --spider /health` |
| rest | postgrest/postgrest:v14.12 | 3000/3001(localhost) | `postgrest --ready` |
| realtime | supabase/realtime:v2.102.3 | 4000 | 带 ANON_KEY Bearer 打 tenants health |
| storage | supabase/storage-api:v1.60.4 | 5000 | — |
| imgproxy | darthsim/imgproxy:v3.30.1 | 5001 | — |
| meta | supabase/postgres-meta:v0.96.6 | 8080 | — |
| functions | supabase/edge-runtime:v1.74.0 | 9000 | — |
| db | supabase/postgres:17.6.1.136 | 无宿主端口 | pg_isready |
| supavisor | supabase/supavisor:2.9.5 | 宿主 5432/6543 | `127.0.0.1:4000/api/health` |

</details>

## 调用链路

### setup.sh bootstrap（一条 `curl | sh` 拉起一切）

```
main
 ├─ detect_os → install_base_packages → install_docker   # Debian/RHEL 双系
 ├─ prepare_source
 │    ├─ latest_release_tag()   # git ls-remote --tags | grep '^self-hosted/v' | sort -V | tail -1
 │    ├─ sparse_clone()         # --filter=blob:none --no-checkout --depth=1
 │    │                         #  + sparse-checkout set docker （只拉 docker/ 目录）
 │    └─ RESOLVED_REF = tag 或 resolved_sha()
 ├─ cp -rf "$SRC_DIR/." "$PROJECT_DIR/" ； cp .env.example .env
 ├─ ask_url ×3（SUPABASE_PUBLIC_URL / API_EXTERNAL_URL / SITE_URL）+ sed -i 写 .env
 ├─ sh utils/generate-keys.sh --update-env        # HS256: JWT_SECRET/ANON_KEY/SERVICE_ROLE_KEY
 ├─ sh utils/add-new-auth-keys.sh --update-env    # ES256: JWT_KEYS/JWT_JWKS + opaque sb_ keys
 ├─ write_version_stamp()   # 写 .supabase-version: ref=<tag|sha>，供 update.sh 做 merge base
 └─ docker compose pull
```

幂等：`main` 开头检查 `.env + docker-compose.yml + utils/` 三者齐备即跳过 bootstrap。`ask()` 从 `/dev/tty` 读入——`curl | sh` 管道场景仍可交互。

### update.sh 3-way merge

三棵树：**base**（`.supabase-version` 记录的 ref 快照）、**target**（最新 tag 快照）、**user's**（部署目录，非 git checkout）。核心 `merge_one_file()`（第 422-470 行）逐文件判定：`no target` → 保留用户文件；`no user file` → 拷入 target；`u == t` → unchanged；`u == b`（用户没改过）→ 直接覆盖为 t；其余 → `git merge-file -p u b t` → clean 或 CONFLICT（写冲突标记）。

流水线（`main`，第 638-692 行）：`resolve_target_ref → resolve_base_ref → fetch_snapshot×2 → build_gate_report（读 upgrades.json，breaking 变更先 confirm_gate，任何写之前）→ take_backup（tar 到 backups/，排除 volumes/db/data 与 volumes/storage）→ merge_vendor_files → merge_env_file → print_summary → write_stamp`。两个防御性细节：`stage_self_update()` 因 shell 边运行边读 `$0`，绝不就地覆盖自身（暂存为 `update.sh.dist`）；有 CONFLICT 时退出码 2 且**不推进版本戳**，下次干净运行才更新。

## 核心实现

### DB 初始化：两档挂载

compose 把 `volumes/db/` 挂到 `docker-entrypoint-initdb.d` 分两档（第 480-497 行）：

- **`migrations/`**（普通 SQL）：`97-_supabase.sql` 建 `_supabase` 库 → `99-realtime.sql` 建 `_realtime` schema → `99-logs.sql`/`99-pooler.sql` 在 `_supabase` 库内建 `_analytics`/`_supavisor` schema
- **`init-scripts/`**（需 superuser）：`98-webhooks.sql` 建 pg_net 扩展 + `supabase_functions` schema + hooks 表 + `http_request()` 触发器函数；`99-roles.sql` 给五个**预置低权限角色**（`authenticator`/`pgbouncer`/`supabase_auth_admin`/`supabase_functions_admin`/`supabase_storage_admin`）改密码；`99-jwt.sql` 用 psql `\set` 从容器 env 取 `JWT_SECRET` 写入 `app.settings.jwt_secret` 数据库级 GUC

消费关系：`rest` 以 `authenticator` 角色连库（anon/service_role 是其成员，PostgREST 经 JWT role 切换）；`auth` 用 `supabase_auth_admin`；`storage` 用 `supabase_storage_admin`——每个服务最小权限直连。`storage` 还依赖 `rest`（`POSTGREST_URL: http://rest:3000`，storage 自身的表 CRUD 走 PostgREST）。

### supavisor：以代码 seeding 租户

`volumes/pooler/pooler.exs`（Elixir）：compose 的 `command` 三段串联——`migrate && supavisor eval "$(cat /etc/pooler/pooler.exs)" && server`。该脚本启动时从 env 组装 params（`auth_query: "SELECT * FROM pgbouncer.get_auth($1)"`，db_user=`pgbouncer`，`is_manager: true`），`Supavisor.Tenants.create_tenant/1` 幂等写入其 `_supabase._supavisor` 元数据表（supavisor 经 `ecto://supabase_admin@.../_supabase` 访问——即 `pooler.sql` 建的 schema）。`pgbouncer.get_auth()` 让客户端可用任意 `postgres` 库用户名连接，密码统一校验。

### 可插拔 override 组合

不是 `-f` 手工拼接，而是写进 `.env` 的原生 `COMPOSE_FILE` 变量（冒号分隔），由 `run.sh config add/remove` 管理：

| 文件 | 用途 |
| --- | --- |
| `docker-compose.kong.yml` | 换回 Kong：**原地 override `api-gw`**（`!override` 标签整体替换 healthcheck/ports/entrypoint）+ 补 8443 HTTPS listener |
| `docker-compose.pg15.yml` / `pg17.yml` | 钉住 PG 版本；pg15 是 `utils/upgrade-pg17.sh` 的回滚目标（两版 UID 不同，残留 named volume 会导致 `FATAL: invalid secret key`） |
| `docker-compose.s3.yml` / `rustfs.yml` | 存储后端：附加 minio（one-shot `minio-createbucket` 容器，`service_completed_successfully` 门控）或 RustFS，改 `STORAGE_BACKEND: s3` |
| `docker-compose.caddy.yml` / `nginx.yml` | TLS 终端：先 `ports: !reset []` 摘掉 api-gw 宿主端口再起反代 |
| `docker-compose.logs.yml` | 附加 Logflare analytics 栈 |

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Override 文件组合 | `.env` 的 `COMPOSE_FILE` | 网关/存储/TLS/PG 版本全部可插拔 |
| 双网络别名 | compose 第 74-80 行 `envoy`+`kong` | 旧配置零修改切网关 |
| 3-way merge | `update.sh` `merge_one_file()` | 区分「用户改过」与「上游更新」，冲突显式呈现 |
| 版本账本 | `versions.md` + `upgrades.json`（含 `_schema` 自描述） | 人工干预清单的真源；breaking 变更 gate |
| 模板化生成配置 | `volumes/api/envoy/docker-entrypoint.sh`（sed 注入 key 到 `lds.template.yaml`）；Kong 侧 Lua 表达式把 opaque `sb_` key 翻译成 ES256 JWT | 密钥不落盘 |
| sparse-clone 引导 | `setup.sh` `sparse_clone()` | 一条 curl 引导只拉 docker/ 目录 |

## 模块间交互

studio 与栈内服务的通信变量（已验证，非想当然的 `KONG_API_URL`）：`SUPABASE_URL: http://api-gw:8000`（内部经网关调 auth/rest/storage）、`SUPABASE_PUBLIC_URL`、`STUDIO_PG_META_URL: http://meta:8080`（直连 postgres-meta）。pg-meta 的 SQL 消费链：浏览器 → studio Next API route（`lib/api/self-hosted/query.ts` 用 env 拼连接串 + `encryptString()` 加密为 `x-connection-encrypted` 头）→ Kong/envoy 网关（`/pg/*` → `http://meta:8080`，key-auth + acl admin，见 `volumes/api/kong.yml` L394-405）→ postgres-meta 容器执行。辅助脚本群：`utils/generate-keys.sh`（纯 openssl 自签 HS256 JWT）、`add-new-auth-keys.sh`（EC P-256 + opaque `sb_` keys）、`db-passwd.sh`/`reassign-owner.sh`、`rotate-new-api-keys.sh`。

## 扩展方式

**新增 self-hosted 服务**：替换型写 `docker-compose.<name>.yml` 用 `!override` 原地改写目标服务（参考 kong 版），保持服务名/网络别名不变以免下游断裂；附加型追加 service + depends_on 健康门控（参考 s3 版的 one-shot 副容器）。新 env key 加 `.env.example`（`merge_env_file` 自动追加到老部署）；需要 DB schema/角色在 `volumes/db/` 加 SQL（编号排 97-99 段，按是否需 superuser 选 migrations/ 或 init-scripts/）；网关路由改 `volumes/api/envoy/cds.yaml`（cluster）+ `lds.template.yaml`（route）。对应测试：`.github/workflows/self-host-tests-smoke.yml` 的 5 组合 matrix（default/logs/kong/rustfs/kong-rustfs）。

**升级 PG 大版本**：`utils/upgrade-pg17.sh`（34k gate 脚本），`upgrades.json` 的 `0.6.0` 条目以 `breaking: true, gate: "utils/upgrade-pg17.sh"` 强制 update.sh 合并前交互确认；升级后 `docker-compose.pg17.yml` 显式声明；回滚 = pg15 override（UID 不匹配必须从 PG 15 镜像起）。

**加 HTTPS + Kong 组合**：`sh run.sh config add kong` + `sh run.sh config add caddy` → `COMPOSE_FILE` 拼接 → `sh run.sh recreate`。注意组合配置间的手工衔接点（caddy 注释提醒需手工取消 `KONG_PORT_MAPS` 注释）目前靠文件内注释引导。
