---
title: "企业级 MCP 实战：Doris MCP 1.0.0 设计详解"
source:
  type: "article"
  project: "Doris"
  url: "https://mp.weixin.qq.com/s/UKhCwQf6u3QnaqU8MO38hA"
  author: "AI4Data"
  site: "公众号"
date: "2026-08-11T19:30:55+08:00"
category: [AI, MCP, Informal]
tags: ["MCP", "Apache Doris", "Agent", "A2A", "企业架构", "Function Call", "语义层"]
description: "以 Apache Doris MCP Server 1.0.0 为例，讲清企业级 MCP Server 如何实现上下文有界、调用可确定、权限分层、Token 可持续四个目标。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [企业级 MCP 实战：Doris MCP 1.0.0 设计详解](https://mp.weixin.qq.com/s/UKhCwQf6u3QnaqU8MO38hA) · **作者** AI4Data · **来源** 公众号 · **原文发布** 2026-08-11 · **转载** 2026-08-11

---

最近一年，围绕 Agent 的概念越来越多。

Function Call、MCP、Skill、CLI、Workflow、Agent、A2A、语义层，每个词都能对应一批产品、开源项目和技术方案。

它们表面上也很像：都能让模型获得更多能力，都能帮 Agent 完成任务，都会出现在一次真实调用链路里。

混乱也就从这里开始。

**有人会问，CLI 能被 Agent 调用，还要 MCP 做什么？**

**也有人认为，只要提供一个通用 SQL 工具，其他能力都交给模型自己组合就行了。**

**还有人把 Skill 理解为 MCP 的轻量替代，把 A2A 理解为 MCP 的下一代，把语义层、Agent 平台、管理界面和业务 Workflow 全部放进一个 MCP Server 里。**

这些讨论里，很多问题都是真问题：

比如工具太多会占上下文，结果太大会浪费 Token，语义模型要更新，企业调用也必须有权限。

所以我发现真正卡住讨论的地方，是大家把不同工程层的东西放在了同一张淘汰赛表里。

进而我觉得需要写一篇文来一起聊聊我实践这两年的核心观点：

> Agent 工程化要解决的核心问题，是每一层由谁负责、通过什么合同交互、权限在哪里生效、状态如何被追踪。

概念归位以后，MCP 和 A2A 的关系会很清楚，Skill 和 CLI 的价值也会很清楚。

后面再进一步，我会以 Apache Doris MCP Server 1.0.0【最近刚基于 7 月 28 的第五代协议完整重构完】 的整体设计为例，讲清楚一个企业级 MCP Server 如何完成四个目标：

1. 上下文有界；
2. 调用过程可确定；
3. 安全与权限分层生效；
4. Token 和运行成本可持续。

---

## 一、先把 Agent 能力栈摆正

我们先不急着讨论哪个技术更好，先画一张能力栈。

![Agent 能力栈：模型周边执行机制、连接外部能力的交互面、执行主体协作机制三类](/vibe-reading/images/articles/doris-informal-mcp-1-0-0-design/fig-1-capability-stack.png)

这张图里有三类东西。

第一类是模型周边的执行机制，包括 Prompt、Function Call、Skill、Workflow 和 Memory。

第二类是连接外部能力的交互面，包括 API、SDK、CLI 和 MCP。

第三类是执行主体之间的协作机制，这里对应 Agent 和 A2A。

再把它们放到一张表里，边界会更直观。

| 概念 | 所在层 | 它主要解决的问题 |
| --- | --- | --- |
| Function Call | 模型与 Host | 模型如何以结构化方式表达调用意图 |
| API / SDK | 软件接口 | 两个确定软件如何直接集成 |
| CLI | 操作界面 | 人或 Agent 如何通过命令行驱动软件 |
| Skill | 方法与知识封装 | Agent 如何复用指令、资料、脚本和流程 |
| Workflow | 过程控制 | 多步任务如何按规则、状态和条件推进 |
| MCP | 能力连接协议 | Host 如何发现、理解并调用外部能力 |
| Agent | 目标执行主体 | 谁负责理解目标、分解任务、使用能力和追踪状态 |
| A2A | Agent 协作协议 | 两个独立 Agent 如何发现、委托、交换任务与产物 |
| 语义层 | 领域语义层 | 业务概念、指标、维度、关系和口径如何被统一表达 |
| Control Plane | 治理与生命周期 | 身份、策略、发布、审计、配额和状态如何被管理 |

这里最重要的一点，是不要用"都能完成任务"来判断它们是否等价。

一个人可以通过网页、手机 App、CLI 和 API 完成同一件事，但这四种界面的用户、合同、信任边界和运行环境都不一样。

Agent 工程里也是同样的道理。

---

## 二、Function Call 解决的是"模型如何表达调用"

Function Call 是整个能力栈里最靠近模型的一层。

Host 把函数名、Description 和参数 Schema 提供给模型，模型在需要时输出一段结构化调用：

```json title="Function Call 的结构化调用输出"
{
  "name": "get_cluster_overview",
  "arguments": {
    "include_nodes": true
  }
}
```

这一层关心两件事：

- 模型能否选对函数；
- 模型能否给出符合 Schema 的参数。

函数真正在哪里执行，网络怎么连，用什么身份，能否被发现，如何做超时、审计和版本兼容，都要由 Host 和后端框架继续完成。

所以 Function Call 更像一种模型输出格式和调用意图合同。

它可以承载本地函数，也可以承载 API、CLI、MCP Tool，甚至可以触发一次 A2A 任务委托。

当一个模型通过 Function Call 发起 MCP Tool 调用时，Function Call 负责"怎么表达"，MCP 负责"怎么发现、传输、授权和返回"。

两者经常同时出现，所以很容易被说成同一件事。

---

## 三、Skill 保存方法，CLI 提供操作面

Skill 的价值，在于把一类任务的处理方法外部化。

一个 Skill 里可以包含：

- 任务边界和执行规则；
- 参考文档和领域知识；
- Prompt 模板；
- 可复用脚本；
- 验证命令；
- 素材和输出模板。

比如"发布 Apache 项目版本"这个 Skill，它可以告诉 Agent 怎么检查标签、生成签名、验证包内容、写投票邮件。

它自己可以不提供任何远程服务。

真正执行时，Agent 仍然会调用 GPG、Git、SVN、浏览器、邮件系统或 MCP Server。

所以 Skill 更接近"会怎么做"，外部工具对应"通过什么做"。

CLI 又是另一个层面。

它是传统软件对人和自动化程序开放的命令行操作面。Agent 可以很好地使用 CLI，因为命令、参数、退出码、标准输出和文件都是稳定的计算机交互对象。

CLI 特别适合：

- 本地开发与诊断；
- Shell 自动化；
- 批量处理；
- 文件重定向；
- 离线分析；
- 人工可见、可复现的操作。

MCP 关心的是 Host 如何用统一方式发现 Schema、传入结构化参数、绑定身份、获取可用性、接收标准错误和有界结果。

一个成熟产品完全可以同时提供 CLI 和 MCP Server，并让它们共用底层 Runtime、安全策略和数据源。

Agent 要导出千万行数据时，CLI 或 Artifact Service 更合适。

Agent 要让 Dify、Claude Desktop、IDE 或企业 Agent 平台标准化发现"查询性能诊断"能力时，MCP 更合适。

---

## 四、MCP 处在 Agent 与应用能力之间

MCP 的位置，可以用一条很短的链路表达：

![MCP 的位置链路：Host → MCP Client → MCP Server → 后端系统](/vibe-reading/images/articles/doris-informal-mcp-1-0-0-design/fig-2-mcp-position.png)

这条链路里，每一层都有自己的责任。

**Host 负责模型上下文和用户交互。**

它决定当前对话有哪些信息、哪些 Tool 可见、何时调用、结果如何回到模型。

**MCP Client 负责协议连接。**

它处理传输、消息编码、版本、请求与响应。

**MCP Server 负责把能力变成稳定合同。**

它提供 Tool、Resource 和 Prompt 等协议对象，并把能力发现、参数校验、身份、权限、限流、审计、超时、错误和结果边界统一起来。

**后端系统保持业务事实和最终权限。**

比如 Apache Doris 仍然负责 SQL 执行、Catalog、存储、调度和 RBAC。Doris MCP Server 不另建一份元数据和授权事实。

MCP 2026-07-28 把这种基础设施定位推得更彻底。

新版本引入无状态协议核心，每个请求都能自描述；可选的 `server/discover` 用于预先获取能力；`Mcp-Method` 和 `Mcp-Name` 可以让网关直接路由和计量；List 结果具有确定顺序与缓存提示；MRTR 用于无状态地表达中途补参和确认；Tasks 作为扩展承载长任务。

这些变化都在说同一件事：MCP 已经开始按可水平扩展、可缓存、可路由、可治理的生产基础设施来设计。

---

## 五、A2A 负责的是 Agent 之间的委托与协作

A2A 的调用链路又向上走了一层。

![A2A 调用链路：主 Agent 通过 Agent Card 发现远程 Agent，经 Message、Task、Artifact 协作](/vibe-reading/images/articles/doris-informal-mcp-1-0-0-design/fig-3-a2a-chain.png)

A2A 1.0 中，远程 Agent 通过 Agent Card 声明身份、端点、认证方式、能力与 Skill；双方通过 Message 交换上下文，通过 Task 追踪长任务状态，通过 Artifact 交付文档、文件和结构化结果。

这里要特别注意一个重名。

A2A Agent Card 里的 Skill，表示远程 Agent 对外声明的能力。

Agent 开发环境里常说的 Skill，通常是指令、参考资料、脚本和流程的可复用封装。

两者都用 Skill 这个词，却处在不同合同里。前者用于远程能力发现，后者用于 Agent 内部方法复用。

区分 MCP 和 A2A，也不要只看同步还是异步。

MCP 新版本已经有 Tasks 扩展，工具调用同样可以很长。A2A 也能对简单请求直接返回 Message。

更稳定的区分方法，是看任务分解权在谁手里。

**MCP Tool 调用时，调用方选择精确能力，并保留整体规划权。**

**A2A 委托时，调用方交付一个目标，远程 Agent 在自己的边界内决定怎么完成。**

比如主 Agent 需要查看 Doris 集群状态，它可以直接通过 MCP 调用 `doris_cluster` 领域下的精确 Child。

如果主 Agent 需要"完成一次数据事故分析，联系当值人，给出影响范围和复盘报告"，这个目标已经包含多步推理、多系统调用和持续状态，交给一个独立运维 Agent 更自然。

这个运维 Agent 内部仍然可以调用 Doris MCP Server、监控 MCP Server、工单 API 和通知 CLI。

MCP 管理 Agent 向下连接能力的合同，A2A 管理 Agent 向外委托任务的合同。

---

## 六、语义层放在哪里

语义层是这些讨论里另一个经常越界的概念。

它负责把物理数据结构转换成稳定的业务语言，例如客户、订单、商品、收入、活跃用户、转化率、时间维度和它们之间的关系。

一套完整语义层往往还包含：

- 模型编辑；
- 指标与维度定义；
- 版本与发布；
- 评审和审批；
- 物理数据绑定；
- 编译和查询规划；
- 口径治理；
- 影响分析和血缘。

这些是语义 Control Plane 与 Runtime 的责任。

MCP Server 可以对外提供语义模型查看、指标发现、语义查询编译和受控执行能力，同时保持自己的边界。

在 Doris MCP Server 1.0 的设计里：

- Ossie 承载语义模型交换合同；
- MetricFlow 作为可选语义编译 Provider；
- `doris_semantic` 负责以 MCP 方式暴露受审查的只读能力；
- 每次模型调用都要给出精确 `model_ref`；
- Provider 完成模型加载和 Doris SQL 编译；
- 编译后的 SQL 回到统一 Query Runtime，继续接受路由、RBAC、SQL Guard、超时、行数、字节、审计和脱敏约束。

这种分工有一个很大的好处：语义系统可以独立进化，MCP 对 Host 提供的能力合同继续稳定，查询执行也不会绕过企业安全边界。

---

## 七、用 Doris MCP Server 1.0 看一套完整产品架构

到这里，可以进入 MCP Server 本身的设计了。

Doris 的能力面很宽。

它有 Catalog 和元数据，有 SQL 查询和 Profile，有 FE/BE 运行状态，有导入和物化视图，有文本、向量和混合检索，有审计、血缘和数据治理，有湖仓、Variant、ADBC 以及语义系统接入。

把这些能力全部平铺给 Host，工具目录会不断膨胀。

只保留一个 `execute_query`，模型又要自己猜 Doris 系统表、Patch 差异、FE/BE HTTP 接口、权限、返回字段和失败语义。

我们最后采用的是两级 Tool 架构。

![Doris MCP Server 1.0 两级 Tool 架构：8 个顶层领域 + 55 个精确 Child](/vibe-reading/images/articles/doris-informal-mcp-1-0-0-design/fig-4-two-level-tool-arch.png)

顶层只公开 8 个只读领域：

| 一级领域 | 主要问题域 |
| --- | --- |
| `doris_catalog` | Catalog、数据库、表、Schema 与大小 |
| `doris_query` | 只读查询、Explain、Profile、慢查询与 ADBC |
| `doris_cluster` | 节点、资源、缓存、Compaction 与运行能力 |
| `doris_pipeline` | 导入、MV、新鲜度与数据依赖 |
| `doris_search` | 文本、向量、混合检索与索引诊断 |
| `doris_governance` | 质量、血缘、审计、UDF 与访问模式 |
| `doris_lakehouse` | 外部 Catalog、湖仓表与 Variant |
| `doris_semantic` | Ossie、MetricFlow 与语义 Grounding |

8 个领域下共有 55 个精确 Child。

顶层 Description 只描述这个领域解决什么问题、包含哪些能力类别，不展开精确操作名和参数 Schema。

Host 选中一个领域后，用空参数 `{}` 调用它，Server 返回当前身份、Doris 路由和运行环境下的 Child Manifest。

```json title="领域调用后返回的 Child Manifest"
{
  "domain": "doris_cluster",
  "manifest_version": "...",
  "children": [
    {
      "name": "get_cluster_overview",
      "description": "...",
      "input_schema": {},
      "availability": {
        "callable": true,
        "reason_code": "AVAILABLE"
      }
    }
  ]
}
```

接下来的精确执行使用：

```json title="精确 Child 的调用结构"
{
  "child_tool": "get_cluster_overview",
  "arguments": {
    "include_nodes": true
  },
  "manifest_version": "..."
}
```

这套架构是后面四个企业级目标的基础。

---

## 八、第一个目标：让上下文有界

工具目录占用上下文，不只是一个 Token 计费问题。

它会直接影响模型的选择空间。

当 50 多个工具的名称、Description、Schema、Enum 和返回说明一次性全部进入对话，模型会同时面对很多弱相关候选项。

它需要在工具选择上消耗注意力，Prompt Cache 也容易因为列表顺序和动态内容变化而失效。

两级发现将这个问题拆成两次选择：

![两级发现：顶层 8 领域稳定注册，按需展开单个领域的精确 Child](/vibe-reading/images/articles/doris-informal-mcp-1-0-0-design/fig-5-context-bound.png)

比如用户先问"这个库里有哪些表"，Host 选择 `doris_catalog`，发现当前可用的 Catalog Child，然后精确调用 `list_tables`。

用户紧接着问"集群最近的运行情况怎么样"，8 个顶层领域仍然稳定注册，Host 直接转向 `doris_cluster` 并获取新 Manifest。

这种切换不依赖 Server 猜概率，也不要求 Host 在对话中重新注册一批 Tool。

顶层面始终稳定，精确 Schema 按需暴露。

我们给一级 `tools/list` 设置了 24 KiB 硬预算，每个单领域 Manifest 不超过 16 KiB。子操作数量、Description、Schema、Enum 和运行可用性证据都要在预算内。

这个设计也经历了一次很具体的 Host 验证。

在 Dify 1.16.1 的一次"查询集群历史运行情况"场景里，修复前 Host 推测性地展开了 5 个不相关领域，累积使用 100,093 Tokens；按单领域优先规则修复后，它只展开 `doris_cluster`，累积使用 33,510 Tokens，降幅约 66.5%。

这是一次真实 Host、真实问题和真实调用轨迹，可以证明设计方向有效。它的数值属于该 Host 和该场景，不用作所有模型与所有问题的通用基准。

**上下文治理的核心，是让模型在当前决策点看到刚好够用的能力集。**

---

## 九、第二个目标：让调用过程可确定

工具调用的准确率，很少只由模型大小决定。

真实系统里常见的误差有五类：

| 误差来源 | 典型表现 |
| --- | --- |
| 一级语义重叠 | 模型同时展开多个领域 |
| Child 职责重叠 | 同一请求有多个看似都可以的操作 |
| Schema 过宽 | 参数名、字段、过滤条件依赖模型猜测 |
| 可用性与环境脱节 | Tool 在列表中，真正调用时才发现版本或权限不支持 |
| 返回合同不稳定 | 模型要重新理解不同 Patch 和不同接口的原始输出 |

所以工具设计不能只数数量。

一个 Child 是否应该独立存在，可以看五个条件：

1. 它是否有独立的业务语义；
2. 它是否有独立的授权边界；
3. 它是否需要独立的版本或 Provider Gate；
4. 它是否使用不同证据源；
5. 它是否需要稳定的结构化输出。

如果几个旧工具围绕同一对象、共用权限和可用性，只是返回不同 Section，就适合合并。

1.0 里的 `get_table_context` 就合并了五个旧工具，统一返回 `basic`、`schema`、`comments`、`indexes` 等 Section，每个可选 Section 都可以独立报告 `partial` 或 `unavailable`。

如果操作面向不同对象，有不同版本门禁和脱敏规则，分开更稳。

Lakehouse 领域中的外部 Catalog、湖仓表和 Variant 列就属于这种情况。

另一个重要机制是动态 Availability。

Doris 的能力会同时受到多个条件影响：

![动态 Availability：版本、Provider、权限、路由等多条件共同决定 Child 是否可调用](/vibe-reading/images/articles/doris-informal-mcp-1-0-0-design/fig-6-availability.png)

版本探测要能从 `Doris version doris-3.0.3-rc03-43f06a5e26 (Cloud Mode)` 这类真实返回中提取 `3.0.3`，后续判断只使用标准三位数版本。

但版本只能说明某项功能可能存在。

当前集群是否已经安装血缘 Companion，ADBC Flight Endpoint 是否可达，账号能否读对应系统表，MetricFlow Sidecar 是否已配置，都要继续探测。

对于有发现权限、但当前环境不可调用的 Child，Manifest 会继续保留，标记 `callable=false`，同时返回稳定 `reason_code`、版本范围和所需 Provider 证据。

这样 Host 可以告诉用户功能为什么不可用，不用让模型盲目调用后再猜错误。

Manifest 还有 `manifest_version`。发现和执行之间如果路由、权限、Provider 或能力快照已经变化，Server 返回稳定的陈旧错误，要求 Host 重新发现。

这套机制将"模型选对"、"环境真能用"和"执行时仍然有权"三件事分开验证。

---

## 十、第三个目标：建立分层安全与权限体系

企业 MCP 不能只有一个 Token 开关。

从 Host 进入 Doris 再回到模型，中间经过一长串信任边界：

![从 Host 到 Doris 的信任边界分层](/vibe-reading/images/articles/doris-informal-mcp-1-0-0-design/fig-7-security-layers.png)

每一层解决不同问题。

### 1. 网络与身份边界

本地开发可以在回环地址使用未鉴权 HTTP，一旦绑定非回环地址，没有鉴权的服务应该在启动阶段失败。

生产环境要同时校验 Host、Origin 和可信代理，离开本机的流量使用 TLS，认证可以使用静态 Bearer Token、JWT、外部 OAuth/OIDC 或 Doris 账号驱动的 OAuth。

### 2. 发现权限和执行权限分开

一个身份能看见某个 Child，不代表它在执行时仍然有权。

比如：

```text title="发现权限与执行权限是两个独立策略"
child:discover:doris_query:execute_query
child:call:doris_query:execute_query
```

这是两个独立策略。

未授权 Child 从 Manifest 中过滤，直接调用时以 Not Found 处理，避免泄露能力名称。

已授权、当前环境缺条件的 Child 则继续可发现，通过 `callable=false` 说明原因。

"无权知道"和"有权知道但当前不能用"是两种完全不同的安全语义。

### 3. MCP 身份继续映射到 Doris 身份

Doris MCP Server 的路由选择遵循明确顺序：

1. Doris OAuth 用户和该用户的独立连接池；
2. 静态 Token 绑定的 Doris 配置；
3. 当路由策略允许时，使用全局服务账号。

受限 Token 或用户连接池出现凭据不匹配、超时或取消时，路由应该 Fail Closed，不回退到更高权限的全局账号。

最终的 Catalog、库、表、列、行、UDF、系统视图和查询权限仍然由 Doris RBAC 决定。

### 4. 只读 Query Guard 放在执行边界

只在 Prompt 里告诉模型"不要写数据"，不能构成安全边界。

只用字符串搜索 `delete`、`drop` 等关键词，也会同时产生误拦截和漏拦截。

比如 `SELECT 'DROP TABLE t' AS harmless` 只是返回一段文本；嵌套、注释、`EXPLAIN` 目标和执行型 Comment 又需要按语法树继续判断。

正式 Query Runtime 要做的是：

- 解析并只接受一个受支持的只读语句；
- 递归校验 `EXPLAIN` 的目标 SQL；
- 拒绝 DDL、DML、管理命令、堆叠语句、锁定读和副作用函数；
- 校验命名参数，通过 Driver 绑定调用方数值；
- 限制超时、行数、字节数、深度和集合大小；
- 将后端失败转换成稳定、脱敏的错误分类。

这层 Guard 还要放在数据库执行边界做最后一次 Fail Closed 检查，避免新增调用路径绕过上层校验。

### 5. 结果同样要受控

很多系统专注于防止危险输入，忽略了输出也会造成安全和成本问题。

原始 SQL、Client Address、认证映射、对象 Location、Catalog Property、Variant Sample、后端 Exception 和 Trace Baggage 都可能包含敏感信息。

所以模型可见结果要经过字段裁剪、脱敏、行数与字节限制，Schema 错误只返回 Path 和 Keyword，不回显被拒绝的 Secret 值。

Doris MCP Server 1.0 的内置合同全部只读，`doris_admin` 只作为未来架构保留，运行时不注册。

未来如果开放管理操作，要单独设计 Preview、Confirm、Idempotency、Rollback 和更严格审批合同，不能通过一个配置开关把只读 Tool 变成写入 Tool。

---

## 十一、第四个目标：让 Token 与运行成本可持续

上下文有界与 Token 成本相关，但要分开评估。

上下文问题关心：模型能否在当前任务中理解和选对能力。

成本问题关心：完成一次成功任务，一共传了多少目录、Manifest、参数、结果、错误和历史。

可以把单次任务的 Token 拆成一个简单式子：

![单次任务 Token 拆解式子](/vibe-reading/images/articles/doris-informal-mcp-1-0-0-design/fig-8-token-formula.png)

企业系统要同时管六个地方。

### 1. 常驻 Tool 面要稳定且小

8 个顶层领域的名称、顺序和 Schema 保持确定，新增 Doris 小版本能力时，优先进入已有领域 Child，不反复扩大顶层面。

### 2. Manifest 只在选中领域后出现

一次问题默认只展开一个领域。

跨领域问题可以由 Host 根据任务证据继续展开第二个领域，Server 不使用概率模型预先猜一批 Child。

### 3. List 和 Manifest 要可缓存

MCP 2026-07-28 给 List 结果增加了 `ttlMs` 和 `cacheScope`。

对于同一 Principal、路由和能力代际，Host 可以复用确定顺序的目录，避免无意义地重复拉取。

缓存不能跨越身份、权限和路由边界，`manifest_version` 负责防止陈旧执行。

### 4. 返回结果要有硬上限

查询结果、Profile、日志、节点、分区、索引和语义上下文都应该有行数、字节、文本、深度和集合限制。

大结果使用分页、签名状态句柄、Artifact Service 或 CLI 文件导出，模型只接收与当前决策有关的摘要和引用。

### 5. 错误必须稳定

如果后端每次返回不同原始异常，模型就会反复尝试、改参数、换 Tool，成本很快放大。

稳定 `reason_code`、明确的 Retryable 语义、可用性证据和受控建议，可以让 Host 在第一次失败后做出正确处理。

### 6. 评估单位要改成"成功任务"

单看 `tools/list` 的字节数还不够。

一个目录很小，但模型总是选错 Tool，最后经过三次重试才完成，总成本仍然很高。

一个精确 Child 的 Schema 稍微多几百字节，却能让模型一次选对、一次调用成功，反而更便宜。

所以真正有价值的指标包括：

- 每个成功任务的累积 Token；
- 平均领域展开数；
- 平均 Tool 调用次数；
- Schema 校验失败率；
- 不可用 Child 误调用率；
- 结果截断率；
- 同一问题的重试率；
- 从用户问题到可用答案的总延迟。

**Token 优化的目标，是用尽量少的上下文和调用次数完成一次可验证的任务。**

---

## 十二、一个企业问题会同时经过 MCP 和 A2A

概念都归位以后，可以看一个完整例子。

用户提出：

> "分析昨晚订单指标异常的原因，判断是数据导入、查询性能还是业务本身的问题，给我一份处理建议。"

一个主 Agent 可以这样执行：

```text title="主 Agent 的完整执行链路"
1. 读取 Skill
   -> 获取"指标异常诊断"的检查步骤和证据标准

2. 调用 doris_semantic
   -> 用精确 model_ref 获取订单指标、维度和口径

3. 调用 doris_query
   -> 执行受控指标查询，获取异常时间和分组

4. 调用 doris_pipeline
   -> 检查导入任务、物化视图和数据新鲜度

5. 调用 doris_cluster / doris_query
   -> 检查资源、慢查询、Profile 和工作负载

6. 当需要长时间处理和跨团队协作时，通过 A2A 委托数据运维 Agent
   -> 追踪 Task
   -> 接收处理 Artifact

7. 主 Agent 组装证据、结论、不确定项和建议
```

这条链路里，Function Call 让模型表达结构化调用，Skill 提供诊断方法，MCP 连接 Doris 和语义能力，A2A 将一个可独立追踪的目标委托给领域 Agent。

没有任何一层需要消灭其他层。

成熟架构追求的是每一层合同清楚，同一项能力可以在正确位置被多个上层复用。

---

## 十三、企业级 MCP Server 应该怎么落地

讲完架构，还要回到工程顺序。

我建议按下面七步推进。

### 1. 从稳定问题域划分一级领域

一级领域要对用户问题稳定，不跟着每个小版本特性增加。

可以用真实用户问题做分类测试：查表、查集群、查导入、查血缘、查指标，模型能否一次进入正确领域。

### 2. 通过合同标准决定 Child 的拆与合

不用根据"数量看起来多"做机械合并。

用业务语义、授权边界、版本 Gate、证据源和输出合同审查每个 Child。

### 3. 把发现、可用性和执行拆开

先判断身份能否发现，再根据真实路由计算 Availability，执行时继续复核精确权限和 Manifest 代际。

三个阶段使用同一份不可变目录，避免文档、Flat 模式、Hierarchical 模式和运行时各写一套工具事实。

### 4. 建立能力矩阵和动态 Probe

每个 Child 都记录最低版本、可选高级版本、Provider、配置、部署模式、权限证据和回退路径。

Doris 2.0 以上用户可以继续使用通用基础能力，高版本特性按当前路由动态解锁。

### 5. 把安全控制放到每个信任边界

网络、认证、发现、执行、Provider、SQL、Doris RBAC 和输出各自有策略和负向测试。

任何一层缺失都会留下穿透路径。

### 6. 设置可机械验证的预算

工具目录、单领域 Manifest、Child 数量、Description、Schema、Enum、返回行数、字节和文本长度都要有硬上限，并在启动或 CI 阶段验证。

### 7. 用真实 Host 和真实问题验收

单元测试可以证明 Schema 和策略符合预期，它无法独立证明模型在 Dify、IDE、桌面 Host 和自建 Agent 里能稳定选对。

验收要使用自然业务问题，记录顶层选择、领域展开、Child 调用、错误恢复、累积 Token、延迟和最终证据。

一个可用的企业 MCP Server，应该能回答下面这些问题：

- Host 默认注册多少 Tool？
- 模型为什么能从顶层领域进入正确 Child？
- Child 不可用时，能否给出结构化原因？
- 版本、Provider、权限和路由变化后，Manifest 如何失效？
- 未授权用户能否猜出隐藏能力？
- SQL Guard 能否在最终执行边界 Fail Closed？
- Doris RBAC 是否仍然是数据权限的最终事实？
- 一次成功任务累积花费多少 Token？
- 大结果如何从模型上下文切换到分页、Artifact 或 CLI？
- 快速切换问题领域时，Host 是否仍然可以及时发现正确能力？

这些问题一旦没有答案，工具数量再少，Demo 再顺，也很难长期进入企业生产环境。

---

## 十四、企业落地的四个核心问题

企业在 AI 应用过程中经常会遇到的生产设计问题，可以归结为四个方向：

- 如何避免上下文爆栈?
- 如何提升工具使用准确度?
- 如何构建企业安全权限防控体系?
- 如何降低 Token 消耗?

这正是本文前述四个目标的另一种表达——上下文有界、调用可确定、安全分层、Token 可持续。把这些本应该扎扎实实落地到企业应用面的技术栈讲明白，是本文的出发点。

---

## 十五、写在最后：把每一层放回正确的位置

Agent 产品走向成熟以后，一定会同时需要多种能力形态。

Function Call 让模型可以结构化地表达调用。

Skill 让方法、知识、脚本和流程可以复用。

CLI 让软件获得低成本、可组合的命令行操作面。

MCP 让 Agent 和应用之间有统一的能力发现、调用和治理合同。

Agent 负责围绕目标进行判断、分解、执行和恢复。

A2A 让多个独立 Agent 可以发现对方、委托任务、追踪状态并交付产物。

语义层让数据能力获得稳定的业务语言和计算口径。

一个企业 Agent 最后会同时使用这些层。

到这一步，更值得追问的是：

- 当前目标应该由哪个 Agent 承担？
- 任务分解权应该留在调用方，还是委托给远程 Agent？
- 外部能力应该以 API、CLI 还是 MCP 开放？
- 方法和流程应该怎么沉淀成 Skill？
- 语义、权限、审计、成本和状态由哪一层保持权威？
- 一次调用失败后，谁有足够证据恢复？

对 MCP Server 来说，关键不在于尽可能多地包装工具。

它需要把有价值的软件能力变成一套稳定、可发现、可授权、可观测、可限界、可持续的 Agent 合同。

**当每一层都能守住自己的边界，Agent 才能在企业系统里走得更远。**
