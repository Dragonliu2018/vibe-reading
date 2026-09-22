---
source:
  type: "源码解读"
  project: "mariadb-server"
  url: "https://github.com/MariaDB/server"
title: "MTR 测试框架"
date: "2026-09-22T22:52:00+08:00"
category: [Database, OLTP, MariaDB, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["MariaDB", "Perl", "C++", "MTR", "回归测试", "mysqltest", "combinations"]
description: "MariaDB MTR 测试框架解读——8832 个 .test 的三层架构（driver+解释器+期望输出）、117 命令测试语言、组合机制一键多协议重跑、check-testcase 状态泄漏检测、criteria 聚簇并行调度全解"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

MTR（mariadb-test-run）是数据库行业最大的回归测试体系之一——全仓库 **8832 个 .test**（主 suite 1450 + 45 个子 suite 5434 + 引擎/插件自带 suite），配合 ~644 个共享 include 脚本。它回答的问题不是"这个函数对不对"，而是"**任何可观察行为都没变**"——这是回归测试区别于断言式单测的本质。改 SQL 层代码后跑相关测试也是参与 MariaDB 开发工作流的核心环节。

## 模块架构

三层结构：

```
mysql-test/mariadb-test-run.pl   driver，6176 行 Perl（lib/mtr_cases.pm 用例收集 + My/ConfigFactory 等）
client/mysqltest.cc              测试语言解释器，15414 行 C++（编译目标 mariadb-test）
mysql-test/main/*.test|*.result  主 suite（★扁平布局——MySQL 传统 t/r 分离目录已被 MariaDB 合并）
mysql-test/suite/<name>/         45 个子 suite（rpl 737/galera 501/innodb 459/perfschema 457/sys_vars 759...）
mysql-test/include/               644 个共享脚本（have_innodb.inc 等前置检查）
mysql-test/combinations          my.cnf 格式的组合定义
```

## 核心实现

### 单测试执行流程

`run_testcase()`（mariadb-test-run.pl:3858）：

```
servers_need_restart() 决定是否换配置重启
→ clean_datadir + My::ConfigFactory 从模板生成 var/my.cnf
→ start_servers()
→ check_testcase("before")       --record 跑 include/check-testcase.inc 存快照
→ start_mysqltest(tinfo)         拼出 mariadb-test --test-file=xx.test --result-file=xx.result
→ 等退出码: 0=pass, 62=skip, 65=crash, 1=fail
→ check_testcase("after")        再跑一次与 before 快照 diff   ★状态泄漏检测
→ check_warnings()               grep mysqld 错误日志
```

解释器侧：mysqltest 把全部可观察输出（查询回显、结果集、错误、警告）写入 log，结束时 `check_result()`（client/mysqltest.cc:2662）`compare_files(log, result_file)`；不一致拷出 `.reject` 文件。`--record` 模式直接把 log 拷成新 .result——行为有意变更时 diff 审查后 commit。

### mysqltest 测试语言（~117 个命令）

命令表在 `client/mysqltest.cc` 的 `command_names[]`（:435）。代表命令：

| 命令 | 实现 | 作用 |
|---|---|---|
| `connect(name,host,...)` | do_connect :8951 | 建命名连接（opts 支持 SSL/COMPRESS/SOCKET） |
| `send` / `reap` | :1357/:1367 | 异步执行：send 后切连接，reap 收结果 |
| `error` | do_get_errcodes :8334 | 声明预期错误码——错误文本也进 result 被 diff |
| `let` / `eval` | :7879/:660 | 变量赋值与展开；`$(1+2*3)` 完整递归下降表达式 |
| `replace_result` / `replace_column` / `replace_regex` | :13992 | 输出归一化：时间戳/LSN/线程 id 替换为 `#` |
| `source include/have_innodb.inc` | do_source :3649 | include 共享前置脚本 |
| `sync_with_master` | :5327 | 复制位点同步 |
| `` `SELECT ...` `` | — | 反引号把查询结果存入变量 |

### 组合机制（combinations）：一键多协议重跑

combinations 文件是 **my.cnf 格式**——每个 `[section]` 是一个组合名，section 内是 mysqld 选项：

```ini
# mysql-test/include/innodb_page_size.combinations
[64k]
innodb-page-size=64K
[16k]
innodb-page-size=16K
```

`make_combinations()`（mtr_cases.pm:624）把一个 .test 复制成 N 个 case；结果文件按组合命名 `foo,16k.result`，或用 **`.rdiff`**（对基 result 的 unified patch——避免 5 种页大小 × 5 份 99% 相同的 result）。**--ps-protocol 的角色**：`run_query`（:12666）把所有完整查询改走 prepared statement C API——同一 .test **不改一行**即可在 text/binary/view/sp/cursor 协议下重跑，把"协议维度"的回归从测试作者身上卸掉。

### 决策一：.result 全量 diff 而非断言

**Why**：diff 快照一次覆盖数千个行为点，断言只能覆盖作者想到的点；行为变更时 `--record` 一个文件 diff review 即可。代价是非确定性输出必须归一化——所以语言内置 `replace_column/replace_result/sorted_result`。连"输出为空"本身也是断言（:13830）。

### 决策二：check-testcase 双跑状态快照

before/after 各跑一次 `include/check-testcase.inc` 并 diff。检查内容（`mtr_check.sql` 的 `check_testcase()`）：全局变量快照（GTID pos 等白名单排除）、不得残留新建 schema、mysql 系统表逐列 checksum（防 DDL 泄漏）、事件/触发器/存储过程残留、插件启停状态、遗留 `#sql` 临时文件、innodb_trx 活跃事务。**Why**：7000+ 测试共享长命 server，任何一个测试泄漏状态都会让**后面的**测试随机失败——归因噩梦；此机制把污染变成污染者自己的失败，且非致命（res==1 停 server 重启继续）。

### 决策三：并行 = Manager 调度 + criteria 聚簇

`collect_test_cases` 为每个测试生成 `criteria`（my.cnf 模板 + master_opt/slave_opt 排序拼接），Manager（mariadb-test-run.pl:789）优先把 **criteria 相同**的测试分给同一个 worker——同配置复用已启动的 server，把重启成本从"每测试"摊薄到"每配置组"。配合 `--mem`（vardir 放 tmpfs）消除 datadir 复制 IO 瓶颈。**Why**：MTR 的耗时大头是 server 启停与文件 IO，而非 SQL 本身；`second_best` 兜底优先派长测试避免尾部空转（:885-892）。

## 模块间交互

- **与全部子系统**：每个 suite 对应一个子系统——`suite/rpl/`（737）、`galera/`（501）、`innodb/`（459+fts/gis/i_s/zip 共 560）、`mariabackup/`（101，物理备份全流程含备份期间 DDL 并发）、`encryption/`（73）、`sys_vars/`（759——每个系统变量一个测试）
- **与 DBUG**：`SET GLOBAL debug_dbug='+d,name'` 触发 `DBUG_EXECUTE_IF` 故障注入点（见[平台基础库](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/11-infra)）——测试并发 bug 靠确定性故障注入复现
- **suite 发现**：`collect_default_suites()` 用 File::Find 扫描 `storage/*/mysql-test`、`plugin/*/mysql-test` 的 54 个插件自带 suite，各含 `suite.pm` 声明 skip 条件
- **CI**：`collections/`（default.push/daily/weekly）定义推送矩阵

## 使用速查（改完代码怎么跑）

```bash
./mtr alias                          # 全 name 匹配，main.alias
./mtr --suite=innodb --do-test=ddl   # 前缀/正则
./mtr --force --parallel=auto --mem  # 失败不中断 + 自动并行 + tmpfs
./mtr --record main.foo              # 有意变更后重录 .result（diff 审查后 commit）
./mtr --start alias                  # 只起 server 手动连接调试
```

失败产物：`.reject` 文件、`var/log/current_test`、`save_datadir_after_failure` 保存的现场数据目录。`--extern` 可对已运行 server 跑。

## 阅读建议

想理解某个子系统，优先读它对应的测试：`suite/rpl/rpl_gtid_*.result` 就是 GTID 行为的精确规格；`main/*.test` 里 grep 关键词能找到任何语法的官方用例。测试在这个项目里就是**可执行文档**。
