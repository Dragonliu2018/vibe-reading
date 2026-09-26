---
source:
  type: "源码解读"
  project: "polardb-pg"
  url: "https://github.com/polardb/PolarDB-for-PostgreSQL"
title: "TDE 透明加密"
date: "2026-09-26T23:11:29+08:00"
category: [Database, OLTP, PolarDB, CodeWiki, "17.11.1.0"]
contentType: "CodeWiki"
tags: ["PolarDB", "PostgreSQL", "TDE", "透明加密", "AES-CTR", "SM4", "pg_kmgr"]
description: "PolarDB TDE：passphrase→KEK/HMAC key→RDEK/WDEK 三级密钥（无 file key），页级部分加密（页头明文 + PD_IS_ENCRYPTED 逐页标记），加密点藏在 checksum 函数内自动覆盖所有刷盘路径。"
readingTime: "18 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/00-overview)

---

## 模块定位

PolarDB 的存储加密能力（TDE, Transparent Data Encryption），实现于 `src/backend/storage/encryption/`（5 个文件共 1220 行）。起源说明：`kmgr.c`/`enc_openssl.c` 头部版权同时含 `PostgreSQL Global Development Group (2019)` 与 `Alibaba Group (2020)`——该模块脱胎于社区 Masahiko Sawada 的 cluster encryption 补丁（`pg_kmgr` 设计），PolarDB 在其上做了共享存储适配与在线启用能力。

**防护边界**：仅 data file（MAIN/INIT fork）。WAL 在本版本**未接加密**——三个证据：`walenc.c` 全文 `#ifdef NOT_USED`；`KmgrGetWALEncryptionKey()` 除定义外零调用；测试 `src/test/encryption/t/001_base.pl` 的 WAL 断言被注释。WDEK 仍被生成、wrap、存进 pg_kmgr，但无消费点。

## 模块架构

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `kmgr.c` | 538 | 密钥管理：bootstrap、启动验证、passphrase 命令执行、`pg_kmgr` 文件读写 |
| `enc_openssl.c` | 401 | OpenSSL EVP 封装：加解密、HMAC、密钥 wrap/unwrap、cipher 表 |
| `enc_cipher.c` | 159 | 后端无关入口 `pg_tde_encrypt/pg_decrypt`、cipher 名字映射 |
| `bufenc.c` | 79 | **数据页加解密本体**：IV 构造 + 页面加密 |
| `walenc.c` | 43 | WAL 加密——未启用（`#ifdef NOT_USED`） |

真实密钥层级（**没有 file key / page key 层**）：

```text
passphrase (≤1024B, 外部命令输出)
   │  get_kek_and_hmackey_from_passphrase()   kmgr.c:295
   │  = 单次 SHA-512(passphrase)（64B）拆两半 —— 无盐、无迭代
   ├──> KEK (32B, TDE_KEK_SIZE)        ← 用于 wrap/unwrap DEK
   └──> HMAC key (32B, TDE_HMAC_KEY_SIZE) ← 用于校验 passphrase

RDEK / WDEK (各 16/32B, pg_strong_random 随机生成)
   │  generate_key_and_hmac()          kmgr.c:515
   │  AES-256 Key Wrap (RFC3394, KEK) + HMAC-SHA256(密文)
   └──> global/pg_kmgr 文件落盘（密文形态存储）

每个数据页：无独立 key，只有 per-page IV（nonce）
```

**pg_kmgr 文件**（`KMGR_FILENAME`，`global/pg_kmgr`）的 `KmgrFileData` 布局：`kmgr_version_no`（`KMGR_VERSION_NO` = 201912301）→ `data_encryption_cipher` → `tde_rdek`/`tde_wdek`（各一个 `WrappedEncKeyWithHmac{wrapped_key, hmac}`）→ 末尾 crc。写入时 CRC 覆盖 `offsetof(KmgrFileData, crc)` 之前的全部内容；读取时 CRC 不匹配报 `ERRCODE_DATA_CORRUPTED`。`BootStrapKmgr` 在 cipher 为 `TDE_ENCRYPTION_OFF` 时直接 return 不写文件。

- **没有 file key**：全部关系共用一个 RDEK（Relation Data Encryption Key），所有 WAL 段共用一个 WDEK——`KmgrGetRelationEncryptionKey()` 返回的就是集群级单钥；
- **没有 page key**：页面级只有 IV，`set_buffer_encryption_iv()`（`bufenc.c:61`）构造 16 字节 nonce = `pd_lsn(8B) || blocknum(4B) || counter(4B 全零)`。**不含 relfilenode/tablespace**——理论上两个不同关系若有相同 `(pd_lsn, blocknum)` 组合会复用 keystream（CTR 模式），这是沿用社区补丁的设计，属观察性结论；
- HKDF 上下文建而未用：`enc_openssl.c:141 create_ossl_derive_ctx()` 创建 `EVP_PKEY_HKDF + SHA256` 的 `derive_ctx`，但全树无任何调用 `EVP_PKEY_derive` 的实际派生——预留接口（**待核实**：是否为未来 per-file key 派生准备）。

密钥**不进共享内存**：`keyEncKey`（全局导出变量）、`relEncKey`/`walEncKey`（static）是 postmaster 进程的普通静态变量，子进程经 `fork()` 继承。`postmaster.c:1433` 注释明说："kmgr initialize should start before checkpointer and bgwriter start since data_encryption_cipher is forked from postmaster"。

## 调用链路

加密发生在**计算 checksum 之前**——checksum 覆盖密文。写路径（主路径）：

```text
FlushBuffer()                              # bufmgr.c:4205（改造版含 write-combine 批量刷盘）
└─ bufsToWrite[i] = PageEncryptCopy(page, forkNum, ...)   # bufmgr.c:4363-4369
   │  # bufpage.c:1553 —— 拷贝整页到私有内存再加密
   └─ EncryptBufferBlock(blkno, pageCopy)  # bufenc.c:28
      ├─ PageSetEncrypted                  # 置 PD_IS_ENCRYPTED 标记
      ├─ set_buffer_encryption_iv()        # bufenc.c:61 构造 IV = pd_lsn||blocknum||counter
      └─ pg_tde_encrypt(page+24, page+24, BLCKSZ-24, KmgrGetRelationEncryptionKey(), iv)
         # AES-CTR 无填充，密文等长
└─ bufsToWrite[i] = PageSetChecksumCopy(...)   # checksum 对密文计算
└─ smgrwrite → 共享存储                    # smgr 收到的已是密文页
```

读路径（先验密文 checksum 再解密）：

```text
ReadBuffer_common 批量读完成后            # bufmgr.c:1619
└─ PageIsVerifiedExtended(page, forknum, blkno, ...)   # bufpage.c:87
   ├─ checksum 校验（对密文）
   ├─ PageDecryptInplace(page, forknum, blkno)        # bufpage.c:102-129
   │   检查 PageIsEncrypted(page)：
   │   ├─ 无标记 → 跳过解密（老页）
   │   │   polar_enable_tde_warning 开启时对 relpath 打 WARNING
   │   └─ 有标记 → DecryptBufferBlock → pg_tde_decrypt
   └─ 页头 sanity 检查
```

解密后 `PD_IS_ENCRYPTED` 标记**不清除**（`DecryptBufferBlock` 不动 flags）——内存页带着密文标记生存，下次 flush 幂等重加密。

**md.c/VFS 层零感知**：`grep encrypt src/backend/storage/smgr/md.c` 为空。smgr 收到的已是密文页，`pg_tde_encrypt/pg_decrypt` 的全部调用点仅在 `bufenc.c`（与 wrap 路径）。

**旁路写入点**（全部通过 `PageSetChecksumInplace` → 其内先调 `PageEncryptInplace`，bufpage.c:1594-1600）：`localbuf.c:245`（临时表 buffer 逐出/复用）、`bufmgr.c:5274`（`FlushRelationBuffers` 的 local-rel 分支）、`polar_copybuf.c:488`（POLAR copy buffer 刷盘路径）、`hashpage.c:1032`（`_hash_alloc_buckets` 直接 `smgrextend` 零页）。

## 核心实现

### 页级部分加密与逐页混存

只加密 `pd_linp` 偏移（24B 页头）之后的内容：

```c
/* src/include/storage/bufpage.h:173-174 */
#define PageEncryptOffset      offsetof(PageHeaderData, pd_linp)   /* 24 字节 */
#define SizeOfPageEncryption   (BLCKSZ - PageEncryptOffset)
```

页头（含 LSN、checksum、flags、lower/upper/special、pagesize_version）**明文落盘**——原因：(1) 读侧必须先判定 `PD_IS_ENCRYPTED` 再解密，标记在页头；(2) IV 需要 `pd_lsn` 语义字段。加密标记是 `pd_flags` 最高位 `PD_IS_ENCRYPTED (0x8000)`（bufpage.h:192,448-450），实现逐页判定——这是「在线开启 TDE 后新旧页混存」的基础。

fork 白名单（`src/include/storage/encryption.h:24-25`）：

```c
#define EncryptForkNum(forknum) ((forknum) == MAIN_FORKNUM || (forknum) == INIT_FORKNUM)
```

表/索引主 fork、unlogged 表的 init fork 加密；**VM、FSM 不加密**（纯 hint 数据）。临时表经 local buffer 落盘路径同样加密。

### passphrase 管理与在线启用

`run_cluster_passphrase_command()`（kmgr.c:142，风格同 `archive_command`）：

- `%p` 替换为提示语 `KMGR_PROMPT_MSG`（`"Enter database encryption pass phrase:"`，kmgr.h:48），`%%` 转义百分号（测试 `t/005_exception.pl` 专测三种形态）；
- `OpenPipeStream(command, "r")`（即 popen）+ `fgets` 取一行，上限 `TDE_MAX_PASSPHRASE_LEN=1024`；
- GUC `polar_cluster_passphrase_command`（guc_tables.c:6148）：`PGC_SIGHUP`，隐藏 GUC（`POLAR_GUC_IS_INVISIBLE`），不能 `RESET ALL`。

**轮换（rotation）与在线启用**——由 `external/polar_tde_utils` 扩展提供（405 行 C + 4 个 SQL 函数）：

- `polar_tde_update_kmgr_file(new_passphrase_cmd text)`（`polar_tde_utils.c:66`）：
  - **TDE 已开**（cipher != OFF）：用新 passphrase 派生**新 KEK**，把**内存中现有的 RDEK/WDEK 原样重新 wrap** 后写 pg_kmgr——只轮换 passphrase/KEK 外层，**DEK 不变**，盘上数据无需重写；
  - **TDE 未开**（在线启用）：`pg_strong_random` 生成全新 DEK 写入 pg_kmgr，需 **restart 后生效**（cipher GUC 由 kmgr 文件在下次启动时 override）。测试 `t/002_enable_dynamically.pl` 验证：重启后新表加密、旧表 INSERT 改动页后经 CHECKPOINT 也变加密（**懒加密**：旧页在被改写落盘时才加密）；
- `polar_tde_update_kmgr_file_v2(cmd, cipher_int)` 额外设置 `data_encryption_cipher_online`（enc_cipher.c:28 的隐藏 int，非 GUC），供 `createCipherContext`（enc_openssl.c:89-102）在 cipher==OFF 时选择在线指定的算法包装密钥；
- 辅助函数：`polar_tde_kmgr_info_view()`（以 hex 暴露 RDEK/WDEK/KEK 给超级用户——管理员审计用途，设计使然）、`polar_tde_check_kmgr_file()`（校验文件版本、cipher、双 HMAC、unwrap 后与内存比对）。

### 启动验证：双 HMAC 校验

```text
initdb -e aes-256 -C 'echo ...'            # initdb.c:144, 2668
  └─ bootstrap 子进程 getopt 'e'
       └─ BootStrapCLOG 等之后 → BootStrapKmgr(cipher)   # xlog.c:5740
            派生 KEK/HMAC ← pg_strong_random 生成 RDEK/WDEK → wrap+HMAC → write_kmgr_file

postmaster 启动 → InitializeKmgr()          # postmaster.c:1433，早于 checkpointer/bgwriter fork
  is_kmgr_file_exist()? → polar_read_kmgr_file()   # global/pg_kmgr，CRC32C 校验
  → run_cluster_passphrase_command()
  → verify_passphrase()                     # kmgr.c:322
       SHA-512(passphrase) → (user_kek, user_hmackey)
       pg_compute_hmac(user_hmackey, wrapped_rdek) == rdek->hmac ?  且 wdek 同理 ?
       → 全部匹配才 memcpy(keyEncKey, user_kek)，pg_unwrap_key 解出 RDEK/WDEK 进内存
  失败 → ereport(ERROR "cluster passphrase does not match expected passphrase") → 启动中止
```

验证手段是密文 wrapped key 上的 HMAC-SHA256 双校验（不是数据页 magic/校验页）。绕过 HMAC 直接 unwrap 会因 RFC3394 完整性检查失败（AES-KW wrap 自带 integrity）。

**存算分离适配**：RW + 只读副本从**同一份共享 pg_kmgr** 读取（路径由 `polar_make_file_path_level2` 映射到 `polar_datadir` 即 PolarStore，`src/include/storage/polar_fd.h:433-441`），副本各自在 postmaster 启动时跑一遍 passphrase 验证与 unwrap——同一算法与同一 DEK 保证 RW/RO 都能解密共享数据。

### 加密算法与上下文复用

GUC `polar_data_encryption_cipher`（guc_tables.c:7062）是 `PGC_INTERNAL + GUC_DISALLOW_IN_FILE`——**用户不可设**，仅由代码在启动读 kmgr 文件后 `SetConfigOption(..., PGC_S_OVERRIDE)`（kmgr.c:439）内部设置。枚举选项：`off / aes-128 / aes-256 / sm4`。

```c
/* src/backend/storage/encryption/enc_openssl.c:42-51 —— 索引 = 枚举值 - 1 */
ossl_EVP_cipher_func cipher_func_table[] = {
#ifdef USE_TDE
    EVP_aes_128_ctr,   /* TDE_ENCRYPTION_AES_128 */
    EVP_aes_256_ctr,   /* TDE_ENCRYPTION_AES_256 */
#ifdef HAVE_EVP_SM4_CTR
    EVP_sm4_ctr,       /* TDE_ENCRYPTION_SM4 */
#endif
#endif
};
```

全部 **CTR 模式**（流式、无填充、密文等长——适配变长页面写与 checksum-after-cipher）。SM4 需 OpenSSL 提供 `EVP_sm4_ctr`（configure.ac:1676 探测，OpenSSL 1.1.1+ 国密）。编译开关 `--with-tde` 定义 `USE_TDE`；无 TDE 编译时 `setup_encryption_ossl()`（enc_openssl.c:224）直接 ERROR。密钥 wrap 用 `EVP_aes_256_wrap`（RFC 3394，固定 AES-256/32B，不随数据 cipher 变化）；HMAC 用 `EVP_sha256`。key size 映射在 `assign_data_encryption_cipher`（enc_cipher.c:141）：off→0、aes-128/sm4→16B、aes-256→32B。

上下文复用：`CipherCtx`（enc_openssl.c:53）在 `TopMemoryContext` 的 `EncMemoryCtx` 中一次性建好 enc/dec/wrap/unwrap 四个 `EVP_CIPHER_CTX`，每次调用只 `EVP_EncryptInit_ex(ctx, NULL, NULL, key, iv)` 换 key/iv。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 借道 checksum 钩子 | `PageEncrypt*` 塞进 `PageSetChecksumCopy/Inplace` 内部（bufpage.c:1546/1594） | 上游 4+ 个刷盘调用点自动全覆盖，最小 diff |
| 逐页标记 | `PD_IS_ENCRYPTED` (bufpage.h:448) | 新旧页混存 + 读侧先判后解 |
| 表驱动 cipher | `cipher_func_table[]`（enc_openssl.c:42） | 新算法一处加行 |
| fork 白名单 | `EncryptForkNum`（encryption.h:24） | FSM/VM 等 hint 数据豁免 |

## 模块间交互

- **与 [03 Buffer 一致性](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/03-buffer-consistency) 协作**：copy buffer 刷盘路径 `polar_copybuf.c:488` 调 `PageSetChecksumInplace`（内含 `PageEncryptInplace`），加密对 copy 版本同样生效；write-combine 批量刷盘天然兼容（每页独立 IV）。
- **与 [04 共享存储 VFS](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/04-shared-storage-vfs) 的关系**：加密在 smgr 之上完成，`polar_vfs`/PolarStore 完全无感——RW 与只读副本共享同一份密文数据文件，不要求存储引擎持钥。
- **与 [07 进程与运维](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/07-process-ops)**：postmaster 早期 fork 前初始化；`external/polar_tde_utils` 提供在线轮换 SQL 函数。

## 扩展方式

**新增一种加密算法**（例：加 aes-192 或国密新算法），按 SM4 的现成路径改 7 处（顺序敏感——**`cipher_func_table` 索引 = 枚举值-1，必须同步**）：

1. `src/include/storage/enc_common.h:16-22`——枚举追加 `TDE_ENCRYPTION_XXX`（**追加在尾部**，别插中间，否则 pg_kmgr 里存的旧值错位）；
2. `src/backend/storage/encryption/enc_openssl.c:42-51`——`cipher_func_table[]` 对应索引加 `EVP_xxx_ctr`（OpenSSL 不一定提供时加 `#ifdef HAVE_EVP_XXX_CTR`）；
3. `src/backend/storage/encryption/enc_cipher.c` 三处：`EncryptionCipherValue()`（字符串→枚举，:107）、`EncryptionCipherString()`（枚举→字符串，:122）、`assign_data_encryption_cipher()`（key size 映射，:141）；
4. `src/backend/utils/misc/guc_tables.c:545`——`data_encryption_cipher_options[]` 加名字；
5. `src/bin/initdb/initdb.c:144`——`encryption_ciphers[]` 加名字（initdb `-e` 白名单）；
6. `configure.ac`——仿 :1676 的 `AC_CHECK_FUNC(EVP_sm4_ctr, ...)` 探测 OpenSSL 支持，重新生成 configure；
7. 测试：仿 `src/test/encryption/t/003_algorithm.pl` 的 SM4 SKIP 块。

改密钥层级（如引入 per-file key）需动 `kmgr.c`（`KmgrFileData` + 版本号 `KMGR_VERSION_NO`）、`bufenc.c`（IV/取钥逻辑）与 `polar_tde_utils`（在线转换）三处。

**测试体系**（`src/test/encryption/t/`，TAP，需 `--with-tde`）：`001_base.pl`（密文文件 grep 不到明文关键词断言）、`002_enable_dynamically.pl`（在线启用 + 懒加密）、`003_algorithm.pl`（三算法 + `%%` 转义）、`004_utils.pl`（校验函数/轮换）、`005_exception.pl`（三种命令模板形态）。

**遗留观察**：KDF 用单次 SHA-512 而非 PBKDF2/Argon2（无盐无迭代）——弱 passphrase 抗暴力强度有限；`write_kmgr_file`（kmgr.c:451）直接覆写不 rename（注释："the kmgr file is very small"）——存在小窗口非原子性；绕过 buffer 的字节流（WAL、`pg_dump` 逻辑导出、`pg_basebackup` 文件级拷贝出的密文文件本身）不在保护边界内。
