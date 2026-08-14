---
source:
  type: "源码解读"
  project: "Linux"
  url: "https://github.com/torvalds/linux"
title: "网络协议栈"
date: "2026-08-14T21:30:28+08:00"
category: [OS, Linux, CodeWiki, "7.1"]
tags: ["Linux", "内核", "网络", "socket", "sk_buff", "NAPI"]
description: "Linux 网络协议栈——socket/sock 分离、sk_buff 数据包、四重注册表、NAPI 收发路径、分层架构。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/00-overview)

## 模块定位

`net/` 是 Linux 内核中与进程管理、内存管理并列的核心子系统之一。它之所以独立成模块，源于一个根本设计决策：**网络数据通路的分层性**。从用户态 `send()` 系统调用到网卡驱动 DMA 描述符，数据包要穿越传输层（L4）、网络层（L3）、数据链路层（L2）和物理层（L1）四级处理，每一层有独立的头部格式、路由逻辑和协议选择。将这四级处理统一放在 `net/` 下，使得层间接口成为函数调用而非跨模块消息，开销最小化。

`net/` 内部的目录结构直接映射 OSI 分层：

| 目录 | OSI 层 | 职责 |
|---|---|---|
| `net/core/` | 跨层 | sk_buff 管理、设备注册、NAPI 软中断 |
| `net/ipv4/` `net/ipv6/` | L3 | IP 路由、分片、iptables |
| `net/ipv4/tcp_*.c` | L4 | TCP 拥塞控制、状态机 |
| `net/socket.c` | 用户接口 | VFS 桥接、系统调用入口 |

收发路径是两条方向相反的流水线：

- **发送路径（send）**：用户态 `sendmsg()` → L4 构造 skb → L3 IP 路由 → L2 选队列/排队列 → L1 `ndo_start_xmit` 网卡驱动。自上而下逐层 push 协议头。
- **接收路径（receive）**：网卡硬中断 → NAPI 软中断轮询 → L2 `netif_receive_skb` → L3 `ip_rcv` → L4 `tcp_v4_rcv` 放入 `sk_receive_queue`。自下而上逐层 pull 协议头。

两条路径共享同一套基础设施——sk_buff 数据包表示和四重协议注册表——但走完全不同的调用链。

## 模块架构

`net/` 的核心架构由四个支柱构成：sk_buff 统一数据包表示、socket/sock 双层抽象、net_device 设备接口、以及贯穿协议栈的四重注册表。

### sk_buff：数据包的统一表示

`sk_buff`（简称 skb）是网络协议栈中唯一的数据包载体。从用户态数据被拷入 skb 的那一刻起，直到网卡驱动读取 DMA 完成标记，同一个 skb 对象贯穿所有层——没有任何层间数据拷贝。其设计精髓在于 `head`/`data`/`tail`/`end` 四指针定义的弹性缓冲区布局：

```
[head, data) = headroom    ← 各层 prepend 协议头时向前 push
[data, tail) = 用户数据     ← 实际载荷
[tail, end)  = tailroom     ← 各层 append 尾部时向后扩展
```

每层通过 `skb_push()` / `skb_pull()` / `skb_reserve()` 移动 `data` 指针来添加或剥离协议头，操作复杂度 O(1)，零拷贝。`cb[48]` 字段为每层提供私有元数据存储（如 TCP 序列号），跨层 clone 时需重新设置。`skb_shared_info` 结构位于 `end` 指针之后，记录分片（scatter-gather）信息和引用计数。

### socket 与 sock：用户态/内核态分离

Linux 将网络 socket 拆成两个结构体，这是整个协议栈最关键的架构决策之一：

- **`struct socket`**（`include/linux/net.h:137`）：面向 VFS 的用户态可见抽象。持有 `state`/`type`/`flags`/`file`（VFS 反向指针）/`sk`（指向 sock）/`ops`（指向 `proto_ops` 策略表）/`wq`（等待队列）。用户态拿到的 fd 关联的就是这个结构。
- **`struct sock`**（`include/net/sock.h:365`）：面向协议栈的内核态对象。持有 `__sk_common`（family/state/daddr/saddr/num 本地端口/dport/prot/net）/`sk_receive_queue`/`sk_write_queue`/`sk_error_queue`/`sk_backlog`/`sk_socket`（反向指针）/`sk_rcvbuf`/`sk_sndbuf`/`sk_wmem_alloc`/`sk_protocol`/`sk_type`/`sk_data_ready` 等回调/`sk_prot`（指向 `struct proto`）。协议栈所有操作都围绕这个结构。

两者通过 `sock_init_data()`（`sock.c:3779`）双向关联：`sk_set_socket(sk, sock)` 设置 sock 的反向指针，`sock->sk = sk` 设置 socket 的正向指针，同时设置默认回调 `sk_data_ready = sock_def_readable`。

**为什么分离**：socket 面向 VFS（fd/file/ops），sock 面向协议栈（队列/路由/拥塞/回调）。分离后，内核内部 socket（`kern=1`）不需要 fd 即可通信；不同协议按各自 slab 分配（`tcp_sock` 比 `udp_sock` 大）；回调机制将 VFS 层与协议层解耦。

### net_device：设备接口

`struct net_device`（`include/linux/netdevice.h:2124`）是所有网络设备的统一抽象，持有 `netdev_ops`/`name`/`ifindex`/`_tx`/`_rx`/`mtu` 等字段。`net_device_ops`（`netdevice.h:1436`）定义了驱动要实现的函数指针表，其中 `ndo_start_xmit`（`:1441`）是发包入口，由网卡驱动实现。驱动在 `probe` 阶段通过 `alloc_etherdev` 分配 net_device，设置 `netdev_ops`，调用 `register_netdev` 完成注册。

### 四重注册表

协议栈用四张注册表将协议族、socket 类型、L4 协议和 L2 packet handler 串联起来，全部以 RCU 保护并发读、spinlock 保护写：

| 层级 | 注册表 | 注册函数 | 查找位置 |
|---|---|---|---|
| 协议族 | `net_families[NPROTO]`（`socket.c:230`） | `sock_register()`（`:3318`） | `__sock_create()`（`:1650`） |
| socket 类型↔协议 | `inetsw[SOCK_MAX]`（`af_inet.c:135`） | `inet_register_protosw()`（`:1202`） | `inet_create()`（`:279`） |
| L4 收包 | `inet_protos[MAX_INET_PROTOS]`（`protocol.h:95`） | `inet_add_protocol()` | `ip_local_deliver` |
| L2 packet | `ptype_base[PTYPE_HASH_SIZE=16]`（`dev.c:172`） | `dev_add_pack()`（`:624`） | `__netif_receive_skb_core()`（`:6146`） |

`inet_init()`（`af_inet.c:1887`，通过 `fs_initcall` 在 `:2022` 注册）一次性完成三重注册：`proto_register(tcp_prot/udp_prot)` 创建协议 slab → `sock_register(inet_family_ops)` 注册 PF_INET → `inet_add_protocol(tcp_protocol)` 注册 L4 handler → `inetsw` 注册 socket 类型映射 → `dev_add_pack(ip_packet_type)` 注册 ETH_P_IP packet handler。整个网络栈从 `subsys_initcall(net_dev_init)`（`dev.c:13317`）初始化 per-CPU `softnet_data` 和 NET_RX/TX_SOFTIRQ 开始，到 `inet_init` 注册协议族结束。

## 调用链路

### 发送路径（L4 → L3 → L2）

用户态调用 `sendmsg()` 后的数据流，自上而下穿越三层：

```c title="net/socket.c"
// 入口：系统调用 → 取 socket → 安全检查 → 策略分派
__sys_sendmsg(socket.c:2768)
  → sock_from_file(:590)           // file* → struct socket*
  → ____sys_sendmsg(:2642)         // 构造 msghdr
  → __sock_sendmsg(:797)
    → security_socket_sendmsg(:799) // LSM hook
    → sock->ops->sendmsg            // 第一层策略分派：proto_ops
```

```c title="net/ipv4/af_inet.c"
// L4：proto_ops 分派到具体协议
inet_sendmsg(af_inet.c:857)
  → sk->sk_prot->sendmsg            // 第二层策略分派：struct proto
    → INDIRECT_CALL_2(tcp_sendmsg / udp_sendmsg)
```

```c title="net/ipv4/tcp.c + net/core/dev.c"
// L4 → L3 → L2 完整路径
tcp_sendmsg                        // 将用户数据放入 sk_write_queue 构造 skb
  → ip_queue_xmit                  // L3：IP 路由 + 构造 IP 头
    → ip_local_out → ip_output
      → ip_finish_output2 → neigh_output
        → dev_queue_xmit → __dev_queue_xmit(dev.c:4766)
          → skb_reset_mac_header    // L2：构造以太网头
          → netdev_core_pick_tx      // 选发送队列
          → qdisc 入队 / dev_hard_start_xmit(:3894)
            → xmit_one → netdev_start_xmit(netdevice.h:5371)
              → ops->ndo_start_xmit  // L1：网卡驱动发包
```

数据类型标注：用户态 `struct msghdr`（分散/聚集 I/O 向量）→ L4 构造 `struct sk_buff`（含 `frag_list` 分片，底层可能指向 `struct bio` 或 page）→ L3 `skb_push()` 添加 IP 头 → L2 `skb_push()` 添加以太网头 → 驱动 DMA 映射。

### 接收路径（L2 → L3 → L4）

接收路径由硬件中断触发，经 NAPI 软中断轮询后自下而上穿越三层：

```c title="net/core/dev.c"
// L1 硬中断 → NAPI 调度 → 软中断轮询
网卡硬中断 → 驱动 IRQ handler
  → napi_schedule(dev.c:6710)
    → ____napi_schedule(:4957)       // 挂入 poll_list + raise NET_RX_SOFTIRQ
      → net_rx_action(:7914)          // NET_RX_SOFTIRQ 处理函数
        → napi_poll(:7786)
          → __napi_poll(:7719)
            → n->poll(n, weight)       // 驱动轮询函数，如 e1000_clean
              → netif_receive_skb(:6295)
```

```c title="net/core/dev.c + net/ipv4/ip_input.c + net/ipv4/tcp_ipv4.c"
// L2 → L3 → L4 完整路径
__netif_receive_skb_core(dev.c:5972)
  → skb_reset_network_header
  → ptype_all (抓包 tap)
  → VLAN 处理
  → rx_handler (bridge/bonding)
  → deliver_ptype_list_skb           // 按 protocol 查 ptype_base 哈希
    → deliver_skb(:2485)
      → pt->func = ip_rcv             // L3 入口
        → ip_rcv → ip_local_deliver   // IP 分片重组后
          → inet_protos[protocol]     // 查 L4 注册表
            → tcp_v4_rcv               // L4 入口
              → 放入 sk_receive_queue   // 用户态 recvmsg 取走
```

非 NAPI 设备走 `netif_rx()`（`:5764`）：数据包放入 per-CPU `softnet_data.input_pkt_queue`，由 backlog NAPI 的 `process_backlog` 轮询后调用 `netif_receive_skb`，最终汇入同一条路径。

<details>
<summary>方法速查表</summary>

| 函数 | 文件:行号 | 职责 |
|---|---|---|
| `__sys_sendmsg` | `socket.c:2768` | sendmsg 系统调用入口 |
| `__sock_sendmsg` | `socket.c:797` | LSM 检查 + 策略分派 |
| `inet_sendmsg` | `af_inet.c:857` | proto_ops → proto 分派 |
| `tcp_sendmsg` | `tcp.c` | 构造 skb 放入 sk_write_queue |
| `ip_queue_xmit` | `ip_output.c` | IP 路由 + IP 头构造 |
| `__dev_queue_xmit` | `dev.c:4766` | 选队列 + qdisc/直接发送 |
| `dev_hard_start_xmit` | `dev.c:3894` | 调用驱动 ndo_start_xmit |
| `napi_schedule` | `dev.c:6710` | 调度 NAPI 轮询 |
| `____napi_schedule` | `dev.c:4957` | 挂 poll_list + raise softirq |
| `net_rx_action` | `dev.c:7914` | NET_RX_SOFTIRQ 处理 |
| `napi_poll` | `dev.c:7786` | 调用驱动 poll 函数 |
| `__netif_receive_skb_core` | `dev.c:5972` | L2 分发：VLAN/bridge/ptype_base |
| `ip_rcv` | `ip_input.c` | L3 IP 收包入口 |
| `tcp_v4_rcv` | `tcp_ipv4.c` | L4 TCP 收包入口 |
| `sock_from_file` | `socket.c:590` | file* → struct socket* |
| `sock_map_fd` | `socket.c:564` | 分配 fd + file 关联 socket |
| `security_socket_sendmsg` | `socket.c:799` | LSM sendmsg hook |
| `deliver_skb` | `dev.c:2485` | 调用 packet_type handler |
| `netif_receive_skb` | `dev.c:6295` | L2 分发入口 |

</details>

## 核心实现

### sk_buff 结构与生命周期

`sk_buff` 定义在 `include/linux/skbuff.h:886-1105`，关键字段分为四组：

**缓冲区指针**——定义数据包在线性内存中的布局：

| 字段 | 含义 |
|---|---|
| `head` | 缓冲区起始地址（分配后不变） |
| `data` | 当前数据起始（各层 push/pull 移动） |
| `tail` | 当前数据结尾 |
| `end` | 缓冲区结束地址（`skb_shared_info` 紧随其后） |

**头偏移字段**——记录各层协议头位置，相对 `head` 的偏移量：

| 字段 | 含义 |
|---|---|
| `transport_header` | L4 头偏移 |
| `network_header` | L3 头偏移 |
| `mac_header` | L2 头偏移 |
| `mac_len` | L2 头长度 |

**元数据**——`len`（总长度）/`data_len`（分片数据长度）/`protocol`（L2 协议类型）/`dev`（当前关联设备）/`sk`（关联 sock）/`cloned`/`fclone`/`truesize`（含 overhead 的总占用）/`users`（结构体引用计数）。

**零拷贝操作**——三函数在协议栈各层反复调用：

```c title="include/linux/skbuff.h"
skb_reserve(skb, len)   // data += len, tail += len  ← 预留 headroom
skb_push(skb, len)      // data -= len               ← 前面腾空间加头
skb_pull(skb, len)      // data += len               ← 剥离头部
```

**分配**：`alloc_skb()`（`skbuff.h:1382`）→ `__alloc_skb()`（`skbuff.c:672`）分三步——NAPI per-CPU 缓存 `napi_skb_cache_get` 取 skb 结构体 → `skbuff_cache` slab 分配（miss 时 `kmem_cache_alloc`）→ `kmalloc_reserve` 分配数据缓冲区 → `__finalize_skb_around()`（`:388`）设置 `head`/`data`/`tail`/`end` 并预留 `skb_shared_info`。

**Clone 与共享**：`skb_clone()`（`skbuff.c:2088`）共享数据缓冲区，`fclone` 快速路径（`:2098` 使用预分配 skb2）；`__copy_skb_header` 拷贝头部字段，`dataref` 递增，`cloned=1`。`skb_copy()`（`:2168`）做完全深拷贝。Clone 用于组播（同一包发多接口）和抓包（tcpdump 复制一份）。

**双重引用计数**：

- `skb->users`：skb 结构体本身的引用计数，`skb_get()` 递增，`kfree_skb()` 递减。
- `skb_shinfo(skb)->dataref`：共享数据缓冲区的引用计数，clone 时递增。

`kfree_skb()` → `kfree_skb_reason()` → `__kfree_skb()`（`skbuff.c:1201`）：`skb_unref` 递减 users → 归零后 `skb_release_all` 释放数据 → `kfree_skbmem` 归还 slab。两个 slab cache：`skbuff_head_cache`（普通 skb）和 `skbuff_fclone_cache`（fclone 预分配），在 `skb_init()`（`skbuff.c:5187`）中创建。

### socket 与 sock 分离

**`struct socket`**（`include/linux/net.h:137`）是 VFS 面向的结构体，用户态 `socket()` 系统调用返回的 fd 关联的就是它。关键字段：`state`/`type`/`flags`/`file`（VFS 反向指针）/`sk`（指向 sock）/`ops`（指向 `proto_ops` 策略表）/`wq`（等待队列）。

**`struct sock`**（`include/net/sock.h:365`）是协议栈面向的对象，包含所有协议运行时状态：`__sk_common`（family/state/daddr/saddr/num/dport/prot/net）/三个收发队列（`sk_receive_queue`/`sk_write_queue`/`sk_error_queue`）/`sk_backlog`/`sk_socket`（反向指针）/收发缓冲区大小（`sk_rcvbuf`/`sk_sndbuf`/`sk_wmem_alloc`）/协议回调（`sk_data_ready` 等）/`sk_prot`（指向 `struct proto`）。

**创建流程**：`__sys_socket()`（`socket.c:1802`）→ `sock_create()` → `__sock_create()`（`:1594`）：`security_socket_create()`（`:1620` LSM 检查）→ `sock_alloc()`（`:1629` 从 socket inode slab 分配）→ `request_module` 按需加载协议模块 → `net_families[family]` 查找 → `pf->create()`（`:1665` 如 `inet_create`）→ `security_socket_post_create`。

**`inet_create`**（`af_inet.c:259`）装配过程：遍历 `inetsw[type]` 匹配 protocol（`:279`，`IPPROTO_IP` 作通配符）→ `sock->ops = answer->ops`（`:325` 设置 proto_ops）→ `sk_alloc()`（`:333` 从协议 slab 分配，TCP 用 `tcp_sock` slab）→ `sock_init_data()`（`:362` 双向关联 + 设默认回调）。

**为什么分离**：关注点分离——socket 面向 VFS（fd/file/ops），sock 面向协议栈（队列/路由/拥塞/回调）。内核内部 socket（`kern=1`）不需要 fd 即可通信。按协议 slab 分配（`tcp_sock` 包含拥塞窗口等额外字段，比 `udp_sock` 大）。回调机制（`sk_data_ready` 等）将 VFS 层与协议层解耦，协议层可以独立更换回调。

### 四重注册表

协议栈用四张注册表实现协议的可扩展性，从用户态 `socket(AF_INET, SOCK_STREAM, 0)` 到最终找到 TCP 实现的完整查找链：

**第一重：协议族注册表 `net_families`**——`net_proto_family`（`net.h:255`）含 `family`/`create`/`owner`。`sock_register()`（`socket.c:3318`）注册到 `net_families[NPROTO]`。`inet_family_ops`（`af_inet.c:1155`）将 `PF_INET` 映射到 `inet_create`。`__sock_create()` 在 `:1650` 查此表。

**第二重：socket 类型注册表 `inetsw`**——`inetsw_array`（`af_inet.c:1164`）预定义三种映射：

| socket 类型 | 协议号 | proto | proto_ops |
|---|---|---|---|
| `SOCK_STREAM` | `IPPROTO_TCP` | `tcp_prot` | `inet_stream_ops` |
| `SOCK_DGRAM` | `IPPROTO_UDP` | `udp_prot` | `inet_dgram_ops` |
| `SOCK_RAW` | `IPPROTO_IP` | `raw_prot` | `inet_sockraw_ops` |

`inet_register_protosw()`（`:1202`）注册到 `inetsw[SOCK_MAX]`。`inet_create()` 在 `:279` 查此表。

**第三重：L4 收包注册表 `inet_protos`**——`inet_add_protocol()` 注册到 `inet_protos[MAX_INET_PROTOS]`（`protocol.h:95`）。IP 层 `ip_local_deliver` 分片重组后查此表，找到 `tcp_v4_rcv`/`udp_rcv` 等 handler。

**第四重：L2 packet 注册表 `ptype_base`**——`dev_add_pack()`（`:624`）注册 `packet_type` 到 `ptype_base[PTYPE_HASH_SIZE=16]`（`dev.c:172`）哈希表。`__netif_receive_skb_core()` 在 `:6146` 按 Ethernet protocol 字段查此表，`ip_packet_type` 将 `ETH_P_IP` 映射到 `ip_rcv`。

`inet_init()`（`af_inet.c:1887`）在 `fs_initcall`（`:2022`）阶段一次性完成三重注册：`proto_register` → `sock_register` → `inet_add_protocol` → `inetsw` 注册 → `dev_add_pack`。

### NAPI 收包机制

**为什么需要 NAPI**：传统收包模式每包一个硬中断，万兆网卡 14.8Mpps 速率下中断风暴会耗尽 CPU。NAPI（New API）采用中断+轮询混合模式——低流量时中断触发轮询；高流量时 poll 用完 weight 后 repoll，不重新触发硬中断，用软中断持续处理。`net_rx_action` 设置 `time_limit`（2 jiffies）+ `budget`（300）双重限制防止单次软中断独占 CPU。

**核心结构**：`napi_struct`（`netdevice.h:381`）含 `state`/`poll_list`/`weight`（默认 64）/`poll`（驱动轮询函数）/`dev`/`gro`/`timer`/`thread`（threaded NAPI）。

**注册**：`netif_napi_add()`（`netdevice.h:2865`）→ `netif_napi_add_weight_locked()`（`dev.c:7558`）：`INIT_LIST_HEAD(poll_list)` + 设置 `poll`/`weight` + 置 `NAPI_STATE_SCHED`。

**调度**：网卡硬中断 → 驱动 IRQ handler → `napi_schedule()`（`dev.c:6710`）→ `__napi_schedule()` → `____napi_schedule()`（`:4957`）：threaded NAPI 模式 `wake_up_process`，否则挂入 `sd->poll_list` 并 `raise NET_RX_SOFTIRQ`。

**轮询**：`net_rx_action()`（`dev.c:7914`）从 per-CPU `softnet_data` 取 poll_list，循环调用 `napi_poll()`（`:7786`）→ `__napi_poll()`（`:7719`）：`n->poll(n, weight)` 返回处理数量，`work < weight` 表示完成（从 poll_list 移除），`work == weight` 表示还有包（repoll）。每次扣除 budget，超 `time_limit` 则 `time_squeeze` 并重新调度 `NET_RX_SOFTIRQ`。

### net_device 与驱动交互

`struct net_device`（`netdevice.h:2124`）是网卡硬件的统一抽象。关键字段：`netdev_ops`（`:2137` 操作函数表）/`name`/`ifindex`/`_tx`（发送队列数组）/`_rx`（接收队列数组）/`mtu`。

`net_device_ops`（`netdevice.h:1436`）定义驱动要实现的接口：`ndo_start_xmit`（`:1441` 发包入口）/`ndo_open`/`ndo_stop`/`ndo_init`/`ndo_set_mac_address`/`ndo_change_mtu` 等。

**注册流程**：`register_netdev()`（`dev.c:11531`）→ `register_netdevice()`（`:11304`）：验证参数 → `dev_get_valid_name` 分配接口名 → `ndo_init` 驱动初始化 → `dev_index_reserve` 分配 ifindex → 发送 `NETDEV_REGISTER` notifier 通知链。

**驱动交互模式**：网卡驱动 `probe` 阶段：`alloc_etherdev()` 分配 net_device → 设置 `dev->netdev_ops = &e1000_netdev_ops` → `netif_napi_add()` 注册 NAPI poll 函数 → `register_netdev()` 完成注册。发送时 `__dev_queue_xmit` 调用 `ops->ndo_start_xmit`；接收时硬中断 → `napi_schedule` → `net_rx_action` → 驱动 `poll` 函数 → `netif_receive_skb`。

## 设计模式

### 分层架构（OSI 对应）

协议栈严格映射 OSI 七层模型：L4（`tcp.c`/`udp.c`）→ L3（`ip_input.c`/`ip_output.c`）→ L2（`dev.c`）→ L1（`drivers/net/`）。每层只与相邻层交互，通过 `skb_push`/`skb_pull` 逐层添加/剥离协议头。层间通过函数指针（注册表查找结果）调用，而非显式 import。

### sk_buff 统一数据包表示

一个 skb 对象贯穿整个收发路径，无需层间数据拷贝。`headroom`/`tailroom` 预留空间让各层 O(1) push/pull 头部。`cb[48]` 为每层提供私有元数据。头偏移字段（`transport_header`/`network_header`/`mac_header`）记录各层头位置，支持回溯解析。分片（`frag_list`/`skb_shared_info`）支持 scatter-gather I/O，避免大数据拷贝。clone 机制实现组播（一包多发）和抓包（tcpdump 复制）的零拷贝共享。

### 注册表模式（四重）

四张注册表（`net_families`/`inetsw`/`inet_protos`/`ptype_base`）将协议从硬编码变为可注册模块。全部以 RCU 保护并发读、spinlock 保护写，支持运行时动态加载协议模块（`request_module`）。`inet_init` 一次性注册整个 PF_INET 协议族，新协议只需调用对应注册函数即可接入。

### 策略模式（三层分派链）

协议栈用三层策略表实现协议无关的分派：

1. **`proto_ops`**（socket 层）：`bind`/`connect`/`accept`/`listen`/`sendmsg`/`recvmsg` 等函数指针。`inet_stream_ops` vs `inet_dgram_ops`。
2. **`struct proto`**（L4 层，`sk->sk_prot`）：`connect`/`disconnect`/`sendmsg`/`recvmsg`/`hash`/`unhash` 等。`tcp_prot` vs `udp_prot`。
3. **`net_device_ops`**（设备层）：`ndo_start_xmit`/`ndo_open`/`ndo_stop` 等。每张网卡驱动提供自己的实现。

分派链：socket `ops->sendmsg` → 协议族 `sk_prot->sendmsg` → 具体协议 `tcp_sendmsg` → 设备 `ndo_start_xmit`。每一层可以独立替换，例如换 TCP 拥塞算法只改 `sk_prot`，换网卡驱动只改 `net_device_ops`。

## 模块间交互

### net/ ↔ drivers/（网卡驱动）

驱动通过 `register_netdev`/`netif_napi_add`/`net_device_ops` 接入协议栈。发送方向：`__dev_queue_xmit` → `ndo_start_xmit` 调用驱动发包函数。接收方向：驱动硬中断 → `napi_schedule` → `net_rx_action` → 驱动 `poll` → `netif_receive_skb`。驱动与协议栈之间的接口完全通过 `net_device_ops` 和 NAPI 回调定义，驱动无需了解 L3/L4 细节。

### net/ ↔ fs/（VFS 桥接）

socket fd 通过 VFS 桥接用户态和内核态。`socket_file_ops`（`socket.c:157`）定义了 `read_iter = sock_read_iter`/`write_iter = sock_write_iter`/`poll`/`release` 等 VFS 操作。`sock_map_fd()`（`:564`）分配 fd 和 file 结构并关联 socket。`sock_from_file()`（`:590`）通过 `file->f_op == socket_file_ops` 判断 file 是否为 socket，反向取回 `struct socket`。这使得 socket 可以像普通文件一样用 `read`/`write`/`poll`/`close` 操作。

### net/ ↔ mm/（内存管理）

skb 分配使用 `kmalloc_reserve`（数据缓冲区）和 `kmem_cache_alloc`（skb 结构体，来自 `skbuff_head_cache`/`skbuff_fclone_cache` slab）。发送流控中 `sock_alloc_send_pskb` 检查 `sk_wmem_alloc < sk_sndbuf`，超出则阻塞等待内存释放。skb 的 scatter-gather 分片直接引用 page 指针，避免大块连续内存分配。

### net/ ↔ security/（LSM hooks）

LSM（Linux Security Modules）在 socket 生命周期的关键点插入 hook：`security_socket_create`（创建时）、`security_socket_sendmsg`（发送时，`socket.c:799`）、`security_socket_recvmsg`（接收时）。这些 hook 允许 SELinux/AppArmor 等安全模块基于进程上下文和 socket 属性进行访问控制。

## 扩展方式

新增一个网络协议（例如自定义传输层协议）需要注册到四重注册表中的对应位置：

**第一步：注册协议族**（如果使用新的 AF_FAMILY）——实现 `struct net_proto_family`，设置 `family` 号和 `create` 回调，调用 `sock_register()` 注册到 `net_families`。如果复用 `AF_INET`，跳过此步。

**第二步：实现 proto_ops**——定义 `struct proto_ops`，实现 `bind`/`connect`/`sendmsg`/`recvmsg` 等函数指针。如果是 `AF_INET` 下的新 socket 类型，构造 `struct inet_protosw` 并调用 `inet_register_protosw()` 注册到 `inetsw`。

**第三步：实现 struct proto**——定义协议的 `struct proto`，实现 `sendmsg`/`recvmsg`/`hash`/`unhash` 等。调用 `proto_register()` 创建协议专用 slab（为 `sock` 结构分配独立 kmem_cache）。

**第四步：注册 L4 收包 handler**（如果需要在 IP 层接收数据包）——构造 `struct net_protocol`，设置 `handler` 函数（类似 `tcp_v4_rcv`），调用 `inet_add_protocol()` 注册到 `inet_protos`。IP 层 `ip_local_deliver` 分片重组后会查此表分发。

**第五步：注册 L2 packet handler**（如果需要绕过 IP，直接处理二层包）——构造 `struct packet_type`，设置 `protocol`（EtherType）和 `func`，调用 `dev_add_pack()` 注册到 `ptype_base`。

```c title="扩展示例：注册自定义 L4 协议"
// 1. proto_ops：socket 层操作
static const struct proto_ops my_proto_ops = {
    .family     = AF_INET,
    .sendmsg    = my_sendmsg,
    .recvmsg    = my_recvmsg,
    .bind       = my_bind,
    .connect    = my_connect,
    /* ... */
};

// 2. struct proto：L4 协议实现
static struct proto my_prot = {
    .name       = "MYPROTO",
    .sendmsg    = my_sendmsg,
    .obj_size   = sizeof(struct my_sock),
    .slab_flags = SLAB_ACCOUNT,
};

// 3. L4 收包 handler
static struct net_protocol my_protocol = {
    .handler    = my_rcv,      // ip_local_deliver 调用
    .err_handler = my_err,
};

// 注册（模块 init）
proto_register(&my_prot, 1);              // 创建 slab
inet_add_protocol(&my_protocol, IPPROTO_MYPROTO);  // 注册 L4 收包
inet_register_protosw(&my_protosw);       // 注册 socket 类型映射
```

注册完成后，用户态 `socket(AF_INET, SOCK_MYTYPE, IPPROTO_MYPROTO)` 即可创建自定义协议的 socket，数据包在收发路径中自动走 `my_sendmsg`/`my_rcv`，与 TCP/UDP 平行。
