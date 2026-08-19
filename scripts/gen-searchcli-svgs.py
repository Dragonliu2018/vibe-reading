#!/usr/bin/env python3
"""Generate SearchCLI CodeWiki SVG diagrams following svg-design.md spec."""
import os

OUT = "/Users/ace/code/vibe-reading/public/images/articles/searchcli-internals"
os.makedirs(OUT, exist_ok=True)

# Palette
BG = "#0b0d14"
NODE = "#13162a"
LINE = "#7a86b3"
C_ENTRY = "#4ecdc4"   # 青 入口
C_DISP = "#6c8ef5"    # 蓝 分发
C_CMD = "#6c8ef5"     # 蓝 命令
C_CORE = "#f9ca24"    # 黄 核心
C_SUB = "#ff6b9d"     # 粉 子系统
C_EXT = "#80c7ff"     # 浅蓝 外部
C_LL = "#b388ff"      # 紫 LLM

DEFS = f'''<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
    <path d="M0,0 L10,5 L0,10 z" fill="{LINE}"/>
  </marker>
</defs>'''

def node(x, y, w, h, lines, fill=NODE, stroke=LINE, fs=13, sw=1.5):
    """Rounded rect with centered text (lines = list of str)."""
    t = ""
    n = len(lines)
    # vertical centering: middle line at y + h/2
    start = y + h/2 - (n-1)*9
    for i, ln in enumerate(lines):
        t += f'<text x="{x+w/2}" y="{start + i*18}" text-anchor="middle" fill="#e6e8f0" font-size="{fs}" font-family="system-ui, sans-serif">{ln}</text>\n'
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>\n'
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="none" stroke="{stroke}" stroke-width="{sw}"/>\n{t}')

def band_label(x, y, text, color):
    return f'<text x="{x}" y="{y}" text-anchor="start" fill="{color}" font-size="13" font-weight="600" font-family="system-ui, sans-serif">{text}</text>'

def arrow_v(x, y1, y2, marker="arrow"):
    """Vertical arrow from (x,y1) down to (x,y2)."""
    return f'<path d="M{x},{y1} L{x},{y2}" stroke="{LINE}" stroke-width="1.5" fill="none" marker-end="url(#{marker})"/>'

def arrow_h(x1, x2, y, marker="arrow"):
    return f'<path d="M{x1},{y} L{x2},{y}" stroke="{LINE}" stroke-width="1.5" fill="none" marker-end="url(#{marker})"/>'

def path_d(d, color=LINE, marker=None, sw=1.5, dash=None):
    dashattr = f' stroke-dasharray="{dash}"' if dash else ''
    m = f' marker-end="url(#{marker})"' if marker else ''
    return f'<path d="{d}" stroke="{color}" stroke-width="{sw}" fill="none"{m}{dashattr}/>'

def write_svg(name, w, h, body):
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" font-family="system-ui, sans-serif">\n'
           f'<rect x="0" y="0" width="{w}" height="{h}" fill="{BG}"/>\n'
           f'{DEFS}\n{body}\n</svg>')
    with open(os.path.join(OUT, name), "w") as f:
        f.write(svg)
    print(f"wrote {name} ({w}x{h})")

# ── 1. architecture.svg — 分层架构 ──
def arch():
    w, h = 820, 600
    body = []
    # title
    body.append(f'<text x="{w/2}" y="30" text-anchor="middle" fill="#e6e8f0" font-size="16" font-weight="600">SearchCLI 分层架构</text>')
    layers = [
        ("入口层", C_ENTRY, ["bin/run.js", "standalone.ts", "index.ts"]),
        ("命令分发层", C_DISP, ["app/platform-commands.ts", "app/product-commands.ts", "app/skill-commands.ts"]),
        ("命令实现层", C_CMD, ["commands/**/*.ts  (102 oclif Command)"]),
        ("核心服务层", C_CORE, [["openapi-client", "runtime-api-client"], ["data-client", "search-client", "llm-client"], ["config", "credential-store", "output-format"]]),
        ("子系统层", C_SUB, ["core/connector/", "core/search-tuning/"]),
        ("外部服务", C_EXT, ["火山引擎 AI Search", "OpenAI 兼容 LLM", "MySQL/MongoDB/Redis"]),
    ]
    y = 56
    rowh = 70
    gap = 18
    centers_x = []
    for label, color, nodes in layers:
        # band label on left
        body.append(band_label(16, y + rowh/2 + 4, label, color))
        # nodes row
        n = len(nodes)
        nx_start = 150
        nx_area = w - nx_start - 30
        nw = nx_area / n - 12
        cy = y + rowh/2
        for i, nd in enumerate(nodes):
            x = nx_start + i * (nw + 12)
            lines = nd if isinstance(nd, list) else [nd]
            body.append(node(x, y, nw, rowh, lines, fill=NODE, stroke=color, fs=11))
        centers_x.append(y + rowh)
        y += rowh + gap
    # arrows between layers (vertical), at x = 410 center
    ax = 410
    for i in range(len(layers)-1):
        y_top = 56 + (i+1)*(rowh) + i*gap  # bottom of layer i
        y_bot = y_top + gap  # top of layer i+1
        body.append(arrow_v(ax, y_top, y_bot))
    write_svg("architecture.svg", w, y+10, "".join(body))

# ── 2. module-dependencies.svg — 模块依赖 ──
def deps():
    w, h = 820, 420
    body = []
    body.append(f'<text x="{w/2}" y="30" text-anchor="middle" fill="#e6e8f0" font-size="16" font-weight="600">模块依赖关系</text>')
    # 3 modules vertical center column + external left + subsystems
    # Top: 命令分发层
    bw, bh = 220, 56
    disp_x, disp_y = 300, 60
    body.append(node(disp_x, disp_y, bw, bh, ["命令分发层", "app/*-commands.ts"], stroke=C_DISP, fs=12))
    # Middle: 核心服务层
    core_x, core_y = 300, 200
    body.append(node(core_x, core_y, bw, bh, ["核心服务层", "core/*.ts"], stroke=C_CORE, fs=12))
    # Left external
    ext_x, ext_y = 40, 130
    body.append(node(ext_x, ext_y, 180, 76, ["@volcengine/openapi", "zod  (签名/校验)"], stroke=C_EXT, fs=11))
    # Right subsystems
    conn_x, conn_y = 580, 110
    body.append(node(conn_x, conn_y, 200, 56, ["数据连接器", "core/connector/"], stroke=C_SUB, fs=12))
    tune_x, tune_y = 580, 200
    body.append(node(tune_x, tune_y, 200, 56, ["搜索调优引擎", "core/search-tuning/"], stroke=C_SUB, fs=12))
    # Bottom external: 火山引擎
    vs_x, vs_y = 300, 320
    body.append(node(vs_x, vs_y, bw, bh, ["火山引擎 AI Search", "(控制面 + 数据面)"], stroke=C_EXT, fs=12))
    # Arrows
    # 分发 → 核心 (vertical down)
    body.append(arrow_v(410, disp_y+bh, core_y))
    # 核心 ← external (left, arrow from ext to core)
    body.append(arrow_h(ext_x+180, core_x, core_y+bh/2-10))
    # 分发 → 连接器 (up-right)
    body.append(path_d(f"M{disp_x+bw},{disp_y+20} L{conn_x},{conn_y+28}", marker="arrow"))
    # 分发 → 调优 (right)
    body.append(path_d(f"M{disp_x+bw},{disp_y+40} L{tune_x},{tune_y+28}", marker="arrow"))
    # 连接器 → 核心 (down-left)
    body.append(path_d(f"M{conn_x+100},{conn_y+bh} L{core_x+bw},{core_y+10}", marker="arrow"))
    # 调优 → 核心 (left)
    body.append(arrow_h(tune_x, core_x+bw, tune_y+28))
    # 核心 → 火山引擎 (down)
    body.append(arrow_v(410, core_y+bh, vs_y))
    write_svg("module-dependencies.svg", w, h, "".join(body))

# ── 3. data-flow.svg — 数据流 (search run + item apply) ──
def dataflow():
    w, h = 860, 520
    body = []
    body.append(f'<text x="{w/2}" y="30" text-anchor="middle" fill="#e6e8f0" font-size="16" font-weight="600">核心运行流程数据流</text>')
    # Left column: vs search run chain (5 nodes)
    body.append(band_label(30, 60, "vs search run", C_DISP))
    sn = [["bin/run.js"], ["standalone.ts main()"], ["runProductDomainFromArgv"], ["runSearchRunCommand"], ["VikingRuntimeApiClient.search"], ["printOutput"]]
    x, y0, nw, nh, g = 40, 78, 200, 40, 14
    ys = []
    for i, nd in enumerate(sn):
        yy = y0 + i*(nh+g)
        ys.append(yy+nh)
        body.append(node(x, yy, nw, nh, nd, stroke=C_DISP, fs=11))
    # arrows down
    for i in range(len(sn)-1):
        body.append(arrow_v(x+nw/2, ys[i], ys[i]+g-0))
    # Right column: vs item apply chain
    body.append(band_label(470, 60, "vs item plan / apply", C_SUB))
    it = [["item profile"], ["item-onboarding.ts", "(schema 推断双路)"], ["buildApplyDryRunSummary", "(dry-run 预览)"], ["三道确认门", "validation/review/entry"], ["上架 + 6 次", "read-after-write"], ["wait-ready 就绪"]]
    x2 = 480
    ys2 = []
    for i, nd in enumerate(it):
        yy = y0 + i*(nh+g)
        ys2.append(yy+nh)
        body.append(node(x2, yy, nw, nh, nd, stroke=C_SUB, fs=11))
    for i in range(len(it)-1):
        body.append(arrow_v(x2+nw/2, ys2[i], ys2[i]+g-0))
    # Bottom converging: both → 火山引擎 API
    vs_y = y0 + 6*(nh+g) + 6
    body.append(node(300, vs_y, 260, 44, ["火山引擎 AI Search API"], stroke=C_EXT, fs=12))
    # bridge arrows from left bottom and right bottom to volcano
    last_left_y = ys[-1]
    last_right_y = ys2[-1]
    body.append(path_d(f"M{x+nw/2},{last_left_y} L{x+nw/2},{vs_y-14} L{360},{vs_y-14} L{360},{vs_y}", marker="arrow"))
    body.append(path_d(f"M{x2+nw/2},{last_right_y} L{x2+nw/2},{vs_y-14} L{500},{vs_y-14} L{500},{vs_y}", marker="arrow"))
    write_svg("data-flow.svg", w, vs_y+44+20, "".join(body))

# ── 4. dispatch-flow.svg — 三域分发 ──
def dispatch():
    w, h = 820, 460
    body = []
    body.append(f'<text x="{w/2}" y="30" text-anchor="middle" fill="#e6e8f0" font-size="16" font-weight="600">命令分发：双入口与三域分发</text>')
    # Entry node
    body.append(node(310, 56, 200, 44, ["bin/run.js → standalone.ts"], stroke=C_ENTRY, fs=12))
    # main() dispatch
    body.append(node(310, 130, 200, 44, ["main() argv 分发"], stroke=C_DISP, fs=12))
    body.append(arrow_v(410, 100, 130))
    # Three domains
    dw, dh = 200, 50
    dy = 220
    dx_list = [(40, "skill 域", C_DISP, "skill init/install"),
               (310, "platform 域", C_ENTRY, "auth / llm / doctor"),
               (580, "product 域", C_SUB, "app/dataset/search/...")]
    for dx, name, c, sub in dx_list:
        body.append(node(dx, dy, dw, dh, [name, sub], stroke=c, fs=11))
        body.append(path_d(f"M410,174 L{dx+dw/2},{dy}", marker="arrow"))  # fan out from main() to each domain top center
    # Actually fan from main bottom center
    # Replace with fan-out paths
    # remove the 3 vertical above and add fan
    # (simpler: keep 3 lines from 410,174 to each domain top center)
    # commands layer
    cy = 320
    body.append(node(310, cy, 200, 44, ["runXxxCommand()", "app/*-commands.ts"], stroke=C_DISP, fs=11))
    for dx, name, c, sub in dx_list:
        body.append(arrow_v(dx+dw/2, dy+dh, cy))
    # core
    body.append(node(310, 400, 200, 44, ["core: clients / config / output"], stroke=C_CORE, fs=11))
    body.append(arrow_v(410, cy+44, 400))
    write_svg("dispatch-flow.svg", w, 454, "".join(body))

# ── 5. api-client-layers.svg — 核心服务层 ──
def apiclients():
    w, h = 820, 460
    body = []
    body.append(f'<text x="{w/2}" y="30" text-anchor="middle" fill="#e6e8f0" font-size="16" font-weight="600">核心服务层：API 客户端分层</text>')
    # http.ts base
    body.append(node(280, 60, 260, 44, ["http.ts  签名引擎 (纯函数)", "buildHeaders / postJson"], stroke=C_CORE, fs=11))
    # 5 clients row
    clients = [("openapi-client", "控制面", C_CORE), ("runtime-api-client", "数据面", C_CORE),
               ("data-client", "数据面", C_CORE), ("search-client", "数据面", C_CORE), ("llm-client", "LLM", C_LL)]
    cw = 140
    cy = 160
    xs = 30
    for i, (n, sub, c) in enumerate(clients):
        x = xs + i*(cw+10)
        body.append(node(x, cy, cw, 50, [n, sub], stroke=c, fs=10))
        body.append(arrow_v(x+cw/2, 104, cy))
    # config & credential
    body.append(node(40, 270, 240, 50, ["user-config / service-config / config", "resolveCliDefaults() 五级优先级"], stroke=C_CORE, fs=10))
    body.append(node(300, 270, 220, 50, ["credential-store", "keychain / 加密文件 / ephemeral"], stroke=C_CORE, fs=10))
    body.append(node(540, 270, 240, 50, ["output-format", "json/table/yaml/pretty/ndjson/csv"], stroke=C_CORE, fs=10))
    # arrows: clients → config (they use config)
    body.append(arrow_v(160, 210, 270))
    body.append(arrow_v(410, 210, 270))
    # external: 火山引擎 + LLM API
    body.append(node(40, 380, 320, 50, ["火山引擎 AI Search", "控制面 OpenAPI + 数据面 Runtime"], stroke=C_EXT, fs=11))
    body.append(node(460, 380, 320, 50, ["OpenAI 兼容 LLM API", "(方舟 Ark 等)"], stroke=C_EXT, fs=11))
    body.append(arrow_v(200, 320, 380))
    body.append(arrow_v(620, 320, 380))
    write_svg("api-client-layers.svg", w, 450, "".join(body))

# ── 6. connector-pipeline.svg ──
def connector():
    w, h = 860, 420
    body = []
    body.append(f'<text x="{w/2}" y="30" text-anchor="middle" fill="#e6e8f0" font-size="16" font-weight="600">数据连接器管道</text>')
    # Sources column (left)
    body.append(band_label(30, 60, "Source (策略)", C_SUB))
    srcs = ["mysql.ts", "mongo.ts", "redis-stream.ts", "jsonl.ts"]
    for i, s in enumerate(srcs):
        yy = 78 + i*46
        body.append(node(30, yy, 150, 38, [s], stroke=C_SUB, fs=11))
    # Runner center
    body.append(node(250, 120, 200, 70, ["Runner", "runConnector()", "for await readChanges"], stroke=C_DISP, fs=11))
    # Sink right
    body.append(node(520, 120, 200, 50, ["Sink", "ConnectorSink.flush()", "批量 upsert"], stroke=C_CORE, fs=11))
    # StateStore bottom (checkpoint)
    body.append(node(250, 250, 200, 50, ["StateStore", "saveConnectorState()", "state.json 游标"], stroke=C_LL, fs=11))
    # External target
    body.append(node(520, 250, 200, 50, ["火山引擎 dataWrite", "POST /api/v1/dataset/{id}/write"], stroke=C_EXT, fs=10))
    # arrows: sources → runner (fan in)
    for i in range(4):
        yy = 78 + i*46 + 19
        body.append(path_d(f"M180,{yy} L250,{140}", marker="arrow"))
    # runner → sink
    body.append(arrow_h(450, 520, 145))
    # sink → external
    body.append(arrow_v(620, 170, 250))
    # runner → statestore
    body.append(arrow_v(350, 190, 250))
    # checkpoint feedback: statestore → runner (dashed)
    body.append(path_d(f"M250,{275} L220,{275} L220,155 L250,155", color=C_LL, dash="4 3"))
    body.append(f'<text x="195" y="220" text-anchor="end" fill="{C_LL}" font-size="10" font-family="system-ui, sans-serif">resume</text>')
    write_svg("connector-pipeline.svg", w, 320, "".join(body))

# ── 7. tuning-pipeline.svg ──
def tuning():
    w, h = 900, 440
    body = []
    body.append(f'<text x="{w/2}" y="30" text-anchor="middle" fill="#e6e8f0" font-size="16" font-weight="600">搜索调优流水线 (runSearchTuning)</text>')
    # Pipeline stages horizontal
    stages = [("query-generate", C_CMD), ("search", C_DISP), ("label / judge", C_LL), ("metrics", C_CORE), ("report", C_SUB), ("apply", C_ENTRY)]
    sw_, sh_ = 120, 50
    sy = 130
    sx0 = 30
    gap = 18
    prev_right = 0
    for i, (s, c) in enumerate(stages):
        x = sx0 + i*(sw_+gap)
        body.append(node(x, sy, sw_, sh_, [s], stroke=c, fs=11))
        if i > 0:
            body.append(arrow_h(prev_right, x, sy+sh_/2))
        prev_right = x + sw_
    # setup node above first
    body.append(node(sx0, sy-70, sw_, 40, ["setup", "createNewRunSetup"], stroke=C_DISP, fs=10))
    body.append(arrow_v(sx0+sw_/2, sy-30, sy))
    # LabelCache below judge
    jx = sx0 + 2*(sw_+gap)
    body.append(node(jx, sy+sh_+40, sw_, 44, ["LabelCache", "跨 run 共享"], stroke=C_LL, fs=10))
    body.append(path_d(f"M{jx+sw_/2},{sy+sh_} L{jx+sw_/2},{sy+sh_+40}", color=C_LL, dash="4 3"))
    body.append(f'<text x="{jx+sw_+8}" y="{sy+sh_+30}" fill="{C_LL}" font-size="10" font-family="system-ui, sans-serif">cache-aside</text>')
    # Checkpoint below search
    ckx = sx0 + 1*(sw_+gap)
    body.append(node(ckx, sy+sh_+40, sw_, 44, ["Checkpoint", "--resume-run-id"], stroke=C_CORE, fs=10))
    body.append(path_d(f"M{ckx+sw_/2},{sy+sh_} L{ckx+sw_/2},{sy+sh_+40}", color=C_CORE, dash="4 3"))
    # LLM external (feeds query-generate + judge)
    body.append(node(sx0, 270, sw_, 44, ["LLM API", "(query 生成 + judge)"], stroke=C_EXT, fs=10))
    body.append(path_d(f"M{sx0+sw_/2},{sy} L{sx0+sw_/2},{sy-30} L{sx0+sw_/2},{270}", color=C_EXT, dash="4 3"))
    # search external
    body.append(node(sx0+sw_+gap, 270, sw_, 44, ["VikingSearchClient", "并发检索"], stroke=C_EXT, fs=10))
    body.append(arrow_v(sx0+sw_+gap+sw_/2, sy+sh_, 270))
    # apply → scene
    body.append(node(sx0+5*(sw_+gap), 270, sw_, 44, ["SearchSceneV2", "Create/Publish"], stroke=C_EXT, fs=10))
    body.append(arrow_v(sx0+5*(sw_+gap)+sw_/2, sy+sh_, 270))
    write_svg("tuning-pipeline.svg", w, 320, "".join(body))

arch()
deps()
dataflow()
dispatch()
apiclients()
connector()
tuning()
print("done")
