---
source:
  type: "源码解读"
  project: "SeekDB"
  url: "https://github.com/oceanbase/seekdb"
title: "全文检索与 ik 分词"
date: "2026-09-29T22:10:29+08:00"
category: [Database, VectorSearch, SeekDB, CodeWiki, "1.4.0"]
contentType: "CodeWiki"
tags: ["SeekDB", "OceanBase", "全文检索", "ik 分词", "倒排索引"]
description: "X-macro 注册的 5 种分词器插件、ik 内部的 processor 流水线与 Arbitrator 智能判优、27 万词内嵌词典的 DAT 分 range KVCache、倒排 = 4 张隐藏辅助表 + DML 实时分词"
readingTime: "35 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/00-overview)

---

## 模块定位

全文检索的质量上限由分词器决定——seekdb 把它做成插件（`ObIFTParserDesc` 两个纯虚方法），内置 5 种分词器，其中 **ik 是从 elasticsearch-analysis-ik 体系移植重写的中文分词器**（Arbitrator 判优/多 processor 流水线与 ES IK Analyzer 一一对应，代码内无来源注明）。倒排的存储答案是**复用而非新建**：FTS 索引是 domain index 的 4 张隐藏辅助表，词项写路径完全复用 DAS，因此免费获得事务/MVCC/compaction 全套能力。本模块覆盖 `src/storage/fts/`（实现）、`src/data_plane/api/data_plane/fts/`（接口真源，`storage/fts/*.h` 全是一行转发垫片）、`src/rootserver/ddl_task/ob_fts_index_build_task.cpp`（构建任务）、`src/sql/das/ob_das_domain_utils.cpp`（DML 分词写路径）。

先澄清一个容易误判的事实：`storage/fts/dict/` 的 5.2M 不是二进制词典文件，而是 `ob_ik_dic.cpp`（5,272,001 字节）——**以 C 字符串数组内嵌的 IK 词典源码**（`main_dic[]` 约 27.6 万词起于第 31 行、`quan_dict[]` 第 275950 行、`stop_dic[]` 第 276013 行），外加载入器代码。

## 模块架构

```shell
src/data_plane/api/data_plane/fts/     # 接口真源（8 头文件 + dict/ 3 个）
├── ob_fts_parser.h                   # ObITokenIterator + ObIFTParserDesc + ObFTParserParam
├── ob_fts_parser_helper.h            # FTS_BUILD_IN_PARSER_LIST X-macro 注册表
├── ob_fts_parser_property.h          # WITH PARSER 的 JSON 属性
├── ob_fts_struct.h                   # ObFTWord/ObFTWordMap/ObAddWordFlag
└── ob_doc_id.h / ob_fts_doc_word_scan.h / ob_fts_literal.h / ob_fts_parser_name.h

src/storage/fts/                      # 实现
├── ob_fts_parser_helper.cpp          # 工厂：get_desc() if-else 返回函数级 static const 单例
├── ob_ik_ft_parser.cpp               # ik（12.8K）
├── ob_ngram_ft_parser / ob_ngram2 / ob_beng / ob_whitespace_ft_parser
├── ik/                               # ik 内部：letter/quantifier/cjk/surrogate processor + arbitrator + token + char_util
├── dict/                             # ob_ik_dic.cpp（内嵌词表）+ DAT 构建/缓存 + 词典 loader
├── ob_fts_stop_word.cpp              # 停用词 + ObAddWord 后处理
├── ob_fts_doc_word_iterator.cpp     # doc_word 辅助表扫描（构建期词流出口）
└── utils/                            # ob_ft_ngram_impl（ngram/ngram2 共享滑窗）、unicode_utils
```

接口小而锋利——**没有 init/destroy 虚方法**（生命周期由 `segment()` 内部一次性完成）：

```cpp title="src/data_plane/api/data_plane/fts/ob_fts_parser.h"
class ObITokenIterator {
  virtual int get_next_token(const char *&word, int64_t &word_len,
                             int64_t &char_cnt, int64_t &word_freq) = 0;
};
class ObIFTParserDesc {
  virtual int segment(ObFTParserParam *param, ObITokenIterator *&iter) const = 0;
  virtual int get_add_word_flag(ObAddWordFlag &flag) const = 0;   // 声明分词后的过滤策略
};
```

注册用 X-macro（名字/枚举/判定宏自动生成），工厂是返回函数级单例的 if-else 链；**默认 parser 是 `space`**（`OB_DEFAULT_FULLTEXT_PARSER_NAME = "space"`，`oblib/lib/ob_define.h:1444`）——对齐 MySQL 默认全文行为。parser 名带版本：`ObFTParser::parse_from_str()` 按 `.` 切出 `name.version`（如 `ik.1`）写进 schema，`check_is_the_same()` 据此判定词典/算法升级是否需要重建索引。

```cpp title="src/storage/fts/ob_fts_parser_helper.h"
#define FTS_BUILD_IN_PARSER_LIST   \
  FT_PARSER_TYPE(FTP_SPACE, space) \
  FT_PARSER_TYPE(FTP_NGRAM, ngram) \
  FT_PARSER_TYPE(FTP_BENG, beng)    \
  FT_PARSER_TYPE(FTP_IK, ik)        \
  FT_PARSER_TYPE(FTP_NGRAM2, ngram2)
```

## 调用链路

### ik 分词流程（写路径与查询串共用）

```
ObIKFTParserDesc::segment() (ob_ik_ft_parser.cpp:226)
└─ ObIKFTParser::init()
   ├─ init_dict()          # 经 ObFTDictHub 取三本词典（main/quan/stop）——miss 时构建 DAT 缓存
   ├─ init_ctx()           # TokenizeContext(cursor + token_list_ + result_list_)
   └─ init_segmenter()     # 顺序装配: Letter → Quantifier → CJK → Surrogate
ObIKFTParser::get_next_token() → produce() → process_next_batch()   # 每批 SEGMENT_LIMIT=1000 字
   ├─ 循环 current_char → process_one_char：每字符广播给 4 个 processor（叠加产生重叠候选）
   └─ ObIKArbitrator arb; arb.process() → output_result()
      ├─ smart 模式: 按 offset 冲突分组 ObIKTokenChain → optimize() 回溯搜索无冲突组合
      │            → ObIKTokenChain::better_than() 判优 → 存入 chains_ 哈希表
      └─ max_word 模式: 每条冲突链整体输出全部候选词
      输出: 按文本 offset 顺序；未覆盖字符做单字补齐（CHINESE 单字/OTHER_CJK 按 is_ignore_single_cjk）
```

### DML 写路径（倒排为什么不需要独立 build）

```
INSERT → DAS 写路径 → ObFTIndexRowCache::segment() (das/ob_das_domain_utils.cpp)
├─ ObFTParseHelper::segment(meta, fulltext, len, doc_len, ObFTWordMap&)   # 对每行全文分词
│    （静态方法：构造 ObFTParserParam → iter->get_next_token 循环 → ObAddWord::process_word）
│    process_word 由 ObAddWordFlag 四个 bit 控制: casedown / min-max 长度过滤 / 停用词 / 词频聚合
└─ generate_fulltext_word_rows() 产出 ObDatumRow → 标准写入两张 aux 表
     FTS_INDEX:    [WORD], [DOC_ID], [WORD_COUNT], [DOC_LENGTH]
     FTS_DOC_WORD: [DOC_ID], [WORD], [WORD_COUNT], [DOC_LENGTH]
```

### 4 张隐藏辅助表与构建任务

| 辅助表 | 语义 |
| --- | --- |
| rowkey_doc_aux | rowkey → doc_id |
| doc_rowkey_aux | doc_id → rowkey（反向） |
| domain_index_aux（倒排本体） | rowkey=(token, docid) + 词频/doc_length 列 |
| fts_doc_word_aux | doc_id → token 明细（正排） |

构建入口 `ObFtsIndexBuildTask : ObDDLTask`（`rootserver/ddl_task/ob_fts_index_build_task.cpp`，2001 行）复用 domain index 状态机：`PREPARE → GENERATE_ROWKEY_DOC_SCHEMA(25) → WAIT_ROWKEY_DOC_TABLE_COMPLEMENT(26) → GENERATE_DOC_AUX_SCHEMA(27) → WAIT_AUX_TABLE_COMPLEMENT(28)`。`LOAD_DICTIONARY(46)` 是**条件状态**：`get_next_status()` 在 `WAIT_ROWKEY_DOC_TABLE_COMPLEMENT` 后先调 `ObFtsIndexBuilderUtil::check_need_to_load_dic`（`resolver/ddl/ob_fts_index_builder_util.cpp`），需要装载才进入，否则直接 `GENERATE_DOC_AUX_SCHEMA`；装载事务超时 `MIN(GCONF._ob_ddl_timeout, MAX(ObDicLoader::DEFAULT_TIMEOUT_US, GCONF.internal_sql_execute_timeout))`，且 `ObGenDicLoader::get_dic_loader` 只支持 ik + utf8mb4（生成 `ObIKUTF8DicLoader`，其余组合报 `OB_NOT_SUPPORTED`）。词典表以 `ObDicLock::lock_dic_tables_out_trans` 加 SHARE 表锁（owner 为 task_id_）防并发重装，`cleanup_impl` 中 `unlock_dic_tables` 解锁。检索侧 `MATCH AGAINST` 对**查询串**用同一个 `ObFTParseHelper` 做相同分词（`das/iter/ob_das_text_retrieval_merge_iter.cpp:248-254`）再扫倒排表——写读同一分词器保证语义对齐。SQL 函数 `TOKENIZE()`（`sql/engine/expr/ob_expr_tokenize.cpp`）也走同一条路，输出词数组 JSON 或词频明细 JSON。

## 核心实现

### ik 内部：processor 流水线 + Arbitrator

四个 processor 各管一种字符类别（`ik/` 子目录）：**`ObIKLetterProcessor`**——状态机追踪连续英文字母（IK_ENGLISH_TOKEN）、阿拉伯数字 + 连接符（IK_ARABIC_TOKEN）、字母数字混合（IK_MIX_TOKEN）三段；**`ObIKQuantifierProcessor`**——中文数字与量词（`process_CN_number` → IK_CNNUM_TOKEN、`process_CN_count` → IK_COUNT_TOKEN），用 quantifier 词典（`quan_dict_`）做 DAT 增量匹配；**`ObIKCJKProcessor`**——核心汉语匹配：维护 `ObList<ObDATrieHit>` 活跃命中列表，逐字调主词典 `dict_main_.match_with_hit()` 续匹配，`is_match()` 即把**所有长度的候选词（含互相重叠的）**都塞进 `token_list_`——这是「细粒度」词候选的来源；**`ObIKSurrogateProcessor`**——UTF16 代理对配单 token。

smart 模式的判优六元组（`ObIKTokenChain::better_than`，`ik/ob_ik_token.cpp`）与 elasticsearch-analysis-ik 完全一致：**payload（覆盖有效文本长度）更大 → 词数更少 → offset 跨度更大 → 逆向切分优先 → x_weight（各词 char_cnt 乘积）更大 → p_weight（位置加权）更大**。语法层 `"ik_mode": "smart"/"max_word"`（`ObFTSLiteral::FT_IK_MODE_*`）经 `ObFTParserProperty` 解析进 `TokenizeContext::is_smart_`；smart 模式还在 `compound()` 里把相邻「阿拉伯数字 + 中文数字/量词」合并（IK_CNNUM/IK_CNQUAN）。

### 词典：内嵌词表 → 内部表 → 分 range DAT → KVCache

两段式装载与缓存：

```
装载期（DDL 状态 LOAD_DICTIONARY，ob_fts_index_build_task.cpp:793 附近）
  ObGenDicLoader::get_instance().get_dic_loader(parser_name, charset)
  → ObIKUTF8DicLoader 把 ob_ik_dic.cpp 内嵌数组按 DEFAULT_BATCH_SIZE=8192
    经 ObDicLoader::load_dictionary_in_trans() + ObDMLSqlSplicer
    写内部表 oceanbase.__ft_dict_ik_utf8 / __ft_stopword_ik_utf8 / __ft_quantifier_ik_utf8
  （ObDicLock + 引用计数防并发重装）

运行期（分 range 的 DAT 进 KVCache，查询期零拷贝匹配）
  ObIKFTParser::init_dict() → hub_->load_cache()
  → ObFTDictHub::build_cache()（bucket 写锁）
     → ObFTRangeDict::build_cache_from_ik_dict()
        ├─ 迭代内部表 → build_ranges_concurrently_thread_pool()  # 按首字分段，每 5 万词一个 range
        ├─ 每 range: ObFTDATBuilder::build_from_trie() → ObFTDAT（Double-Array base/check）
        └─ ObFTCacheDict::make_and_fetch_cache_entry() → 通用 ObKVCache
  parser 侧 ObFTCacheRangeContainer 持 ObKVCacheHandle pin 住整个查询生命周期
  匹配: find_first_char_range() 定位 range → ObFTDATReader::match_with_hit()
       状态由 ObDATrieHit 携带（base_idx_/current_check_ + is_match_/is_prefix_/is_unmatch() 三态）
```

分 range 的动机是控制单个 DAT 内存块大小（27 万词不一次性占大块内存）+ 并行构建；`should_read_newest_table()` 恒为 false（注释 "always false now"）——查询中途不刷词典，保证单条查询内分词一致性（热更新词典是预留未启用路径）。`ObDicLoader` 头文件注释明示 `get_dic_item/fill_dic_item` 虚方法是词典表结构差异的扩展点。

### WITH PARSER 属性传递

```
CREATE ... FULLTEXT INDEX idx (content) WITH PARSER ik PROPERTIES(...)
 → resolver: ob_create_index_resolver.cpp:639-650 填 index_arg.index_option_.parser_name_/properties
 → share::ObFtsIndexBuilderUtil::generate_fts_parser_name_and_property()
   （resolver/ddl/ob_fts_index_builder_util.cpp:1841）
   ├─ 空 parser → "space"（默认）
   ├─ generate_fts_parser_name(): ObFTParser::serialize_to_str → "ik.1" 写进 schema
   └─ ObFTParserJsonProps::rebuild_props_for_ddl() 按 parser 分发（ik_/ngram_/space_/beng_/ngram2_）
       白名单校验（ik 只认 dict_table/quantifier_table/stopword_table/ik_mode 四项）
       + 缺省填充（ik → ik_mode="smart"、dict_table=oceanbase.__ft_dict_ik_utf8；
                  ngram → ngram_token_size=2；space → min=3/max=84）
 → 运行时: ObFTParserProperty::parse_for_parser_helper() JSON → 扁平结构体 → ObFTParserParam
```

各 parser 声明自己的后处理策略（`get_add_word_flag`）：beng/space 用 `min_max_word + stop_word`（对齐 MySQL 默认全文行为），ik/ngram/ngram2 只 `casedown + groupby_word`——且有一个值得注意的冷事实：**ik 在 `get_next_token` 里的 stop 词典匹配代码被整段注释**（`ob_ik_ft_parser.cpp:98-101`，`bool is_stop = false` 后直接 `if (!is_stop)`——`is_stop` 恒为 false），v1.4.0 中 ik 的停用词过滤实际不生效，只有 beng/space 走 `ObAddWord::process_word` 的停用词位（内置 36 词英文表 `ob_stop_word_list`）。ngram 片段则天然不受英文停用词约束。边界常量集中在 `ob_fts_literal.h`：min_token_size∈[1,16]、max∈[10,84]、ngram_token_size∈[1,10]。一个原样保留的细节：配置键 `CONFIG_NAME_QUANTIFIER_TABLE = "quanitfier_table"`——上游拼写错误，配置名以此为准。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 插件 + X-macro 注册表 | `FTS_BUILD_IN_PARSER_LIST` + `get_desc()` 单例 | 新增分词器零侵入框架；版本号编进 parser 名支持升级判定 |
| 策略声明 | `get_add_word_flag()` 归 parser 声明后处理 | 分词与过滤策略同源——ik 与 space 对停用词的语义差异由各自声明而非中心配置 |
| 两段式词典管线 | 内嵌源码 → DDL 灌内部表 → DAT 分 range → KVCache pin | 词典不发明文件格式，免费获得事务性装载与通用缓存；DAT 匹配 O(1)/字符 |
| 流水线 + 仲裁 | 4 processor 叠加候选 + Arbitrator 判优 | 多词类并行的中文分词标准做法；smart/max_word 一个开关两种召回 |
| 门面 | `ObFTParseHelper::segment()` 静态方法 | 写路径/查询串/TOKENIZE() 三处共用一套分词语义 |

## 模块间交互

接口三方各取所需：实现方（`storage/fts/` 的 5 个 parser）include api 头实现 `ObIFTParserDesc`；消费方（SQL 层：`ob_expr_tokenize.cpp`、DML 写路径 `ob_das_domain_utils.cpp`、DDL resolver `ob_fts_parser_resolver.h`）**只 include `data_plane/fts/...`，从不 include `storage/fts/` 内部头**；装配方（`ObServer::init_fts()`）完成注册。构建任务由 rootserver 的 `ObDDLScheduler` 调度；检索读侧交棒给[统一检索原语](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/07-retrieval)——`ObFTDocWordScanIterator`（注意实际类名不是 ObFTSDocWordIterator）在索引构建期按 doc_id 回扫 doc_word 辅助表读出词流供倒排 aux 表构建，是「词流」的存储侧出口。

## 扩展方式

新增 jieba 分词器（8 步）：① `data_plane/api/data_plane/fts/ob_fts_parser.h` 的 `ObFTParserParam` 加 `jieba_param_`（仿 `ObFTIKParam`）；② `ob_fts_parser_helper.h` 的 X-macro 加 `FT_PARSER_TYPE(FTP_JIEBA, jieba)`（`is_jieba` 等宏自动生成）；③ `ob_fts_literal.h` 加 `PARSER_NAME_JIEBA` 与配置字面量；④ 新建 `storage/fts/ob_jieba_ft_parser.{h,cpp}`（`ObJiebaFTParser : ObITokenIterator` + `ObJiebaFTParserDesc : ObIFTParserDesc`）；⑤ `ob_fts_parser_helper.cpp` 的 `get_desc()` 加分支 + `ObFTParseHelper::segment()` 填 jieba 参数；⑥ `ob_fts_parser_property.cpp` 加 `jieba_rebuild_props_for_ddl()`（白名单 + 默认值）与分发分支；⑦ 词典走内部表则加 `ob_jieba_dic.cpp` 内嵌词表 + loader（仿 `ob_ik_utf8_dic_loader.cpp`）+ `ObFTDictType` 枚举 + `ObGenDicLoader` 注册；⑧ 若词典表结构不同于 ik 的单列 word，需实现 `ObDicLoader` 的 `get_dic_item/fill_dic_item` 虚方法。resolver 层（`parser_name_` 透传）无需改动。
