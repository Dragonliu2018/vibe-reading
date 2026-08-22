---
source:
  type: "源码解读"
  project: "ClickHouse"
  url: "https://github.com/ClickHouse/ClickHouse"
title: "访问控制"
date: "2026-08-22T15:50:10+08:00"
category: [Database, OLAP, ClickHouse, CodeWiki, "26.8.1.1"]
tags: ["ClickHouse", "Access", "RBAC", "Quota", "RadixTree"]
description: "ClickHouse 访问控制源码解读——RBAC + 行策略 + 配额、AccessFlags 256-bit bitmap、AccessRights Radix Tree、ContextAccess。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/00-overview)

---

## 模块定位

`src/Access/` 是 ClickHouse 的 RBAC（基于角色的访问控制）——用户、角色、权限、配额、行策略、设置 profile。它独立成模块因为访问控制是横切关注点，贯穿从认证（连接建立）到查询（权限检查）到执行（行策略过滤、配额计量）的全程。

## 模块架构

```text
src/Access/
  ├─ IAccessEntity.h            ── 实体基类（User/Role/Quota/RowPolicy/SettingsProfile）
  ├─ AccessControl.h/.cpp       ── 全局管理器（继承 MultipleAccessStorage，含各 Cache）
  ├─ IAccessStorage.h            ── 存储抽象（策略模式：Disk/LDAP/Replicated/Config）
  ├─ MultipleAccessStorage.h     ── 组合存储（路由到子存储）
  ├─ AccessRights.h/.cpp        ── 权限集合（Radix Tree 存储）
  ├─ ContextAccess.h/.cpp       ── 查询级权限上下文（checkAccess/isGranted）
  ├─ User.h/Role.h/Quota.h      ── 各实体
  └─ Common/
     ├─ AccessFlags.h           ── 256-bit bitmap 权限
     ├─ AccessType.h            ── ~150 种权限 X-macro 定义（层级聚合）
     └─ AccessEntityType.h      ── 实体类型枚举
```

## 调用链路

查询权限检查：
```text
Interpreter 执行前 → ContextAccessWrapper::checkAccess(flags, db, table)
  └─ ContextAccess::checkAccess(context, flags, db, table) in ContextAccess.cpp:860
     └─ checkAccessImplHelper → getAccessRightsWithImplicit()
        └─ mixAccessRightsFromUserAndRoles（合并用户+角色权限）
        └─ addImplicitAccessRights（SELECT 隐含 SHOW_COLUMNS 等）
     └─ AccessRights::isGranted(flags, db, table) in AccessRights.h:114
        └─ Radix Tree 沿 db/table/column 路径走，node.flags.contains(required) 位运算
     └─ 未授权 → ACCESS_DENIED 异常（或返回 false）
```

实体管理：
```text
AccessControl::insert(entity) → MultipleAccessStorage → DiskAccessStorage::insertImpl
  └─ writeAccessEntityToDisk → AccessEntityIO::serializeAccessEntity
     └─ 实体序列化为 ATTACH SQL 语句，写 <uuid>.sql 文件
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `AccessControl::authenticate` in `AccessControl.h:129` | 用户认证 | 支持 SPNEGO/LDAP |
| `ContextAccess::checkAccess` in `ContextAccess.cpp:860` | 权限检查（抛异常版） | 模板编译期消除分支 |
| `AccessRights::isGranted` in `AccessRights.h:114` | Radix Tree 查权限 | O(path_length) |
| `AccessControl::getContextAccess` | 获取查询级上下文 | 缓存（ContextAccessCache） |
| `IAccessEntity::findDependencies` | 依赖管理 | 统一接口，删除时清理引用 |

</details>

## 核心实现

### IAccessEntity 与统一实体管理

```cpp title="src/Access/IAccessEntity.h"
struct IAccessEntity {
    virtual AccessEntityType getType() const = 0;   // USER/ROLE/QUOTA/ROW_POLICY/SETTINGS_PROFILE
    virtual std::vector<UUID> findDependencies() const { return {}; }   // 角色继承链
    virtual void replaceDependencies(const std::unordered_map<UUID, UUID> &) {}
};
```

User、Role、Quota、RowPolicy、SettingsProfile、MaskingPolicy 全部继承 `IAccessEntity`，共享 CRUD 生命周期、UUID 标识、`IAccessStorage` 存储层、`AccessChangesNotifier` 通知机制。User 引用 Role（`GrantedRoles`），Role 引用其他 Role（传递继承），`findDependencies/replaceDependencies` 统一管理依赖，删除实体时 `removeReferencesToRemovedIDs` 自动清理所有引用。

### AccessFlags：256-bit bitmap

```cpp title="src/Access/Common/AccessFlags.h"
class AccessFlags {
    using Flags = std::bitset<256>;   // 256-bit 位图
    Flags flags;
    bool contains(const AccessFlags & other) const { return (flags & other.flags) == other.flags; }
};
```

AccessType 用 X-macro `APPLY_FOR_ACCESS_TYPES(M)`（`AccessType.h:157`）定义约 150 种权限，按层级组织：COLUMN → TABLE → DATABASE → GLOBAL，GROUP 类型（ALL/ALTER/SHOW）自动聚合子权限。权限并集/交集/差集都是位运算 O(1)，`contains` 一次位运算判子集。SELECT 隐含 SHOW_COLUMNS 通过 `addImplicitAccessRights` 位运算推导。

### AccessRights：Radix Tree

```cpp title="src/Access/AccessRights.h"
class AccessRights {
    struct Node;                          // Radix Tree 节点
    std::unique_ptr<Node> root;
    bool isGranted(const AccessFlags &, std::string_view db, std::string_view table, ...) const;
};
```

`GRANT SELECT ON db.*` 在树中是 `db` 节点的通配叶子。检查 `SELECT ON db.table` 沿 `db→table` 路径走树 O(path_length) 而非 O(n) 扫列表。前缀共享（同库多表共享库前缀节点）省内存。`modifyFlags` 回调自底向上用 `min/max_flags_with_children` 计算隐含权限。

### ContextAccess：查询级权限上下文

```cpp title="src/Access/ContextAccess.h"
class ContextAccess {
    static std::shared_ptr<const ContextAccess> fromContext(const ContextPtr &);
    void checkAccess(const ContextPtr &, const AccessFlags &, ...) const;
    template <bool throw_if_denied, bool grant_option, bool wildcard, typename... Args>
    bool checkAccessImpl(...) const;   // 4 布尔模板参数编译期消除分支
private:
    UserPtr user;
    std::shared_ptr<const AccessRights> access;            // 用户+角色合并权限
    std::shared_ptr<const AccessRights> access_with_implicit;  // 加隐式权限
};
```

`ContextAccess` 持合并后的 access rights（`calculateAccessRights` 在初始化时合并 user+roles + 隐式权限）。`checkAccessImpl` 用 4 布尔模板参数 `<throw_if_denied, grant_option, wildcard, Args...>` 编译期生成所有组合实例化，消除运行时分支。`ContextAccessWrapper`（`ContextAccess.h:226`）是零开销适配器，`ALWAYS_INLINE` 标记 Release 完全内联。

### 角色继承避免循环

`RoleCache::collectRoles`（`RoleCache.cpp:23`）用 `skip_ids` 集合 + `enabled_roles` 去重：第二次遇到某角色时发现已在 `enabled_roles` 直接 return 不递归。即使 A→B→A 循环，第二次遇 A 即停。TTL 缓存（默认 10 分钟）避免每次检查重递归，角色变更经 `AccessChangesNotifier` 通知缓存重算。

### 实体持久化为 SQL DDL

实体以 **ATTACH SQL 语句**形式持久化（`AccessEntityIO.cpp:36`）——每个实体写 `<uuid>.sql` 文件，内容是 `CREATE USER/ROLE/GRANT` 语句。反序列化用 `ParserAttachAccessEntity` 解析 SQL，按 AST 类型分发到对应 Interpreter 构建实体。`ReplicatedAccessStorage` 经 ZK znode 复制，`watch` 机制同步。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略 | `IAccessStorage`（Disk/LDAP/Replicated/Config） | 多存储后端统一接口 |
| 工厂 | `AccessEntityIO` 序列化 | ATTACH SQL 动态创建实体 |
| 观察者 | `AccessChangesNotifier` | 角色变更通知缓存重算 |
| 模板元编程 | `checkAccessImpl<4 bool>` | 编译期消除分支 |
| 适配器 | `ContextAccessWrapper`（ALWAYS_INLINE） | 零开销自动捕获 context |

## 重要设计决策

### 为什么 RBAC + 行策略 + 配额统一在 Access 模块

所有实体共享 CRUD 生命周期、存储层、UUID、通知机制——分散到不同模块会重复实现序列化、磁盘 I/O、ZK 复制。`IAccessEntity::findDependencies` 统一管理 User→Role→Role 依赖链。`ContextAccess` 单次查询同时持 access rights、row policies、quota、settings，统一决策。

### 权限用 bitmap 加速检查

256-bit `bitset` 位运算 O(1) 集合操作，Radix Tree 叶子存 bitmap——检查只位运算比较无需遍历子树。层级隐含（SELECT→SHOW_COLUMNS）自动推导。

## 扩展方式

新增权限类型 `VACUUM`（表级）：在 `AccessType.h` 的 `APPLY_FOR_ACCESS_TYPES(M)` 加 `M(VACUUM, "", TABLE, ALL)`（父组 ALL 在后）；在执行 VACUUM 的 Interpreter 调 `checkAccess(AccessType::VACUUM, db, table)`。无需改 AccessRights/ContextAccess/AccessFlags——bitmap 与 Radix Tree 自动适配。新增访问实体 `AuditPolicy`：在 `AccessEntityType.h` 加枚举；建 `AuditPolicy.h` 继承 `IAccessEntity`；`AccessEntityIO.cpp` 加 `ASTCreateAuditPolicyQuery` 分支；`AccessControl.h` 加 `AuditPolicyCache` + getter；Parsers/Interpreters 加对应 AST/Parser/Interpreter。

## 模块间交互

被 `Interpreters`（所有 Interpreter 执行前 checkAccess）、`Server`（`TCPHandler`/`HTTPHandler` 连接建立时 `authenticate`）、`Storages`（`getRowPolicyFilter` 注入 WHERE 条件）、`DatabaseCatalog`（解析表名检查 SHOW 权限）使用。依赖 `Common`（CacheBase、ThreadPool）、`Core`（UUID）、`IO`（序列化）、`Parsers`（ATTACH SQL 解析）、`Interpreters/Access`（DDL Interpreter 构建/修改实体）。实体持久化为 SQL DDL，跨副本经 ZK 同步。
