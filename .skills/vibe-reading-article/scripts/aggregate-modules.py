#!/usr/bin/env python3
"""aggregate-modules.py — 把 graphify 的社区聚合成模块地图草案。

前置：目标仓库已跑过
  graphify <pkg-dir> --code-only && graphify cluster-only . --no-label
产出 graphify-out/graph.json。本脚本只读 graph.json，不调 graphify CLI、不依赖第三方库。

原理（codewiki-workflow Step 2 的第 4 信号）：
  Leiden 社区粒度太细（mycli 52 个），人工模块只 4-6 个。两步聚合：
    1. 每社区取 local hub（社区内 degree 最高、过滤 file hub/method stub/
       builtin 的节点），用 hub 的 source_file 启发式归模块——与 graphify
       社区命名同源，绕开"跨连全局 god 边数被 file hub 虚高压制"的噪声。
    2. 同模块的社区归并成模块草案。跨模块桥梁社区（连了别的模块的全局 god）
       单独标注，是模块地图「为什么独立」该提的耦合点。

分工：本脚本做一级聚类（图论，通用）；LLM 拿草案做二级语义合并 + 命名 + 边界微调。

用法：
  python3 aggregate-modules.py [GRAPHIFY_OUT_DIR]
  # GRAPHIFY_OUT_DIR 默认 ./graphify-out
"""
import json
import os
import sys
from collections import Counter, defaultdict

# 与 graphify analyze.py 一致的噪声过滤：内置类型 / mock / typing 符号
_BUILTIN_NOISE = {
    "str", "int", "float", "bool", "bytes", "complex", "object", "True", "False", "None",
    "Mock", "MagicMock", "AsyncMock", "patch", "sentinel",
    "Any", "Optional", "List", "Dict", "Set", "Tuple", "Union", "Callable", "Type",
    "ClassVar", "Final", "Literal", "Protocol", "Counter", "defaultdict", "OrderedDict",
    "datetime", "Enum", "Path", "os", "sys", "re", "json", "io", "abc", "typing",
}

GOD_TOP_N = 15      # 全局 god anchors 数量（展示 + 给 Step 3 Agent 重点）
BRIDGE_MIN = 2       # 社区连外部 god 计数 ≥ 此值才标跨模块桥梁


def is_file_hub(label, source_file):
    """file-level hub：label 即源文件名/stem/带目录路径（accumulate import/contains 边，非架构抽象）。"""
    if not source_file or not label:
        return False
    base = os.path.basename(source_file)
    stem = base.rsplit(".", 1)[0] if "." in base else base
    return (label == base or label == stem
            or source_file == label or source_file.endswith("/" + label))


def is_method_stub(label):
    """AST 合成的方法桩：'.method()'（前导点 + 括号）。普通 'func()' 是真实函数，不过滤。"""
    return label.startswith(".") and label.endswith("()")


def is_noise(label):
    """噪声：空、内置类型/mock/typing 符号；含空格的 docstring/描述节点（标识符无空格）。"""
    return not label or label in _BUILTIN_NOISE or " " in label


def guess_module(label, source_file):
    """node -> 模块草案名（启发式，按 source_file 路径 + label 关键词）。

    顺序敏感：special → 补全 → SQL → CLI → 基础设施。
    对 mycli v2.10.0 验证 god/hub 全部命中 codewiki 4 模块。其他项目可能需手调。
    """
    s = (source_file or "").lower()
    l = (label or "").lower()
    if "special" in s or "special_command" in l:
        return "特殊命令"
    if "completer" in s or "suggest" in l or "completion" in s or "refresher" in l or "prefetch" in l:
        return "补全引擎"
    if "execute" in s or "sqlresult" in s or (l == "sqlresult") or ("result" in l and "sql" in l):
        return "SQL执行引擎"
    if "main" in s or "cli_runner" in s or "client" in s or "repl" in s or l == "mycli":
        return "CLI客户端"
    return "基础设施"


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "./graphify-out"
    graph_path = os.path.join(out_dir, "graph.json")
    if not os.path.exists(graph_path):
        sys.stderr.write(
            f"ERROR: 找不到 {graph_path}\n"
            f"先跑: graphify <pkg-dir> --code-only && graphify cluster-only . --no-label\n"
        )
        sys.exit(1)

    with open(graph_path, encoding="utf-8") as f:
        data = json.load(f)
    nodes, links = data["nodes"], data["links"]
    id2node = {n["id"]: n for n in nodes}
    label2source = {}
    for n in nodes:
        lbl = n.get("label", "")
        if lbl and lbl not in label2source:
            label2source[lbl] = n.get("source_file", "")

    # ── degree ─────────────────────────────────────────────
    degree = Counter()
    for lnk in links:
        degree[lnk["source"]] += 1
        degree[lnk["target"]] += 1

    # ── 全局 god anchors（展示 + Step 3 重点，过滤噪声）────
    gods = []
    for nid, deg in sorted(degree.items(), key=lambda x: -x[1]):
        n = id2node.get(nid, {})
        label = n.get("label", "")
        sf = n.get("source_file", "")
        if is_noise(label) or is_file_hub(label, sf) or is_method_stub(label):
            continue
        gods.append({"id": nid, "label": label, "source_file": sf,
                     "degree": deg, "community": n.get("community")})
        if len(gods) >= GOD_TOP_N:
            break
    god_id_set = {g["id"] for g in gods}

    # ── community members ─────────────────────────────────
    comm_members = defaultdict(list)
    for n in nodes:
        c = n.get("community")
        if c is not None:
            comm_members[c].append(n["id"])

    # ── 每 community 连各全局 god 的次数（仅用于桥梁标注）──
    comm_god = defaultdict(Counter)
    for lnk in links:
        u, v = lnk["source"], lnk["target"]
        cu = id2node.get(u, {}).get("community")
        cv = id2node.get(v, {}).get("community")
        if u in god_id_set and cv is not None:
            comm_god[cv][id2node[u]["label"]] += 1
        if v in god_id_set and cu is not None:
            comm_god[cu][id2node[v]["label"]] += 1

    # ── 每 community：local hub 归模块 + 跨模块桥梁 ───────
    rows = []
    for c in sorted(comm_members):
        members = comm_members[c]
        size = len(members)
        # local hub：community 内 degree 最高非噪声节点
        hub = None
        for nid in members:
            n = id2node.get(nid, {})
            label = n.get("label", "")
            sf = n.get("source_file", "")
            if is_noise(label) or is_file_hub(label, sf) or is_method_stub(label):
                continue
            d = degree[nid]
            if hub is None or d > hub["d"]:
                hub = {"d": d, "label": label, "sf": sf}
        if hub:
            mod = guess_module(hub["label"], hub["sf"])
            # 桥梁：连的外部全局 god（排除本 hub），最高且 ≥ BRIDGE_MIN
            cnt = comm_god.get(c, Counter())
            ext = Counter({g: n for g, n in cnt.items() if g != hub["label"]})
            bridge = ""
            if ext:
                bg, bn = ext.most_common(1)[0]
                if bn >= BRIDGE_MIN:
                    bg_mod = guess_module(bg, label2source.get(bg, ""))
                    if bg_mod and bg_mod != mod:
                        bridge = f"{bg}({bn})→{bg_mod}"
            rows.append((c, size, hub["label"], hub["d"], mod, bridge))
        else:
            rows.append((c, size, "", 0, "基础设施(无hub)", ""))

    # ── 输出 Markdown ──────────────────────────────────────
    print(f"# 模块地图草案（自动聚合）\n")
    print(f"输入: `{graph_path}`")
    print(f"社区: {len(comm_members)} · god anchors: {len(gods)} · 节点: {len(nodes)} · 边: {len(links)}\n")

    print("## God Anchors（degree top, 给 Step 3 Agent 当重点对象）")
    print("| # | god | source_file | degree | community |")
    print("|---|---|---|---|---|")
    for i, g in enumerate(gods, 1):
        print(f"| {i} | `{g['label']}` | `{g['source_file']}` | {g['degree']} | C{g['community']} |")

    print("\n## 社区 → 模块草案（按 local hub 归类）")
    print("| 社区 | 节点数 | local hub | degree | 模块(草案) | 跨模块桥梁 |")
    print("|---|---|---|---|---|---|")
    for c, size, h, d, mod, br in rows:
        print(f"| C{c} | {size} | `{h}` | {d} | {mod} | {br} |")

    # ── 模块汇总 ───────────────────────────────────────────
    mod_groups = defaultdict(lambda: {"comms": 0, "nodes": 0, "ids": []})
    for c, size, h, d, mod, br in rows:
        mg = mod_groups[mod]
        mg["comms"] += 1
        mg["nodes"] += size
        mg["ids"].append(c)

    print("\n## 模块汇总")
    print("| 模块(草案) | 社区数 | 节点数 | 社区号 |")
    print("|---|---|---|---|")
    for mod in sorted(mod_groups, key=lambda m: -mod_groups[m]["nodes"]):
        v = mod_groups[mod]
        print(f"| **{mod}** | {v['comms']} | {v['nodes']} | {v['ids']} |")

    bridges = [r for r in rows if r[5]]
    print(
        f"\n---\n"
        f"**草案说明**：模块名由社区 local hub 的 source_file 启发式推断"
        f"（顺序 special→补全→SQL→CLI→基础设施），需 LLM 做二级语义合并 + 命名 + 边界微调。"
        f"跨模块桥梁社区 {len(bridges)} 个（连了别的模块的全局 god ≥ {BRIDGE_MIN}），"
        f"是模块间耦合点，模块地图的「为什么独立」应提及。"
        f"无 local hub 的社区归基础设施层。"
    )


if __name__ == "__main__":
    main()
