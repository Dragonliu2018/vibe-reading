/**
 * 活跃度柱状图 — 构建时与客户端共用的唯一 SVG 绘制实现
 *
 * 页面 frontmatter 与客户端脚本（经 Vite 打包成 module）都 import 本模块，
 * 消除「构建时 TS 版 + 客户端字符串拼接版」的双实现漂移。
 */

export interface ActivityPoint {
  date: string;   // YYYY-MM-DD
  count: number;  // 当日文章数
}

// SVG 几何常量
const SVG_W = 760;
const SVG_H = 260;
const PAD_L = 36;       // 左侧 Y 轴留白
const PAD_R = 12;
const PAD_T = 16;
const PAD_B = 36;       // 底部 X 轴留白
const PLOT_W = SVG_W - PAD_L - PAD_R;
const PLOT_H = SVG_H - PAD_T - PAD_B;

function barX(i: number, n: number): number {
  if (n <= 1) return PAD_L;
  const slot = PLOT_W / n;
  return PAD_L + i * slot + slot * 0.15;
}
function barW(n: number): number {
  if (n <= 1) return PLOT_W * 0.7;
  return (PLOT_W / n) * 0.7;
}

export function buildActivitySvg(points: ActivityPoint[]): string {
  if (!points.length) {
    return `<svg viewBox="0 0 ${SVG_W} ${SVG_H}" class="activity-chart" role="img" aria-label="每日文章数柱状图"><text x="${SVG_W / 2}" y="${SVG_H / 2}" text-anchor="middle" fill="#48484a" font-size="13">无数据</text></svg>`;
  }

  const max = Math.max(...points.map(p => p.count), 1);
  const n = points.length;
  const bw = barW(n);

  const bars = points.map((p, i) => {
    const h = Math.max(1, (p.count / max) * PLOT_H);
    const y = PAD_T + PLOT_H - h;
    return `<rect x="${barX(i, n).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="url(#barGrad)" class="bar"><title>${p.date}：${p.count} 篇</title></rect>`;
  }).join('');

  // X 轴标签：柱子太多则抽样（最多显示 ~8 个）
  const xLabels: string[] = [];
  const labelStep = Math.max(1, Math.ceil(n / 8));
  for (let i = 0; i < n; i += labelStep) {
    const x = barX(i, n) + bw / 2;
    xLabels.push(`<text x="${x.toFixed(1)}" y="${SVG_H - PAD_B + 16}" text-anchor="middle" class="axis-label">${points[i].date.slice(5)}</text>`);
  }

  // Y 轴刻度线 + 标签（0 / max/2 / max）
  const yTicks = [0, Math.round(max / 2), max];
  const yLines = yTicks.map(t => {
    const y = PAD_T + PLOT_H - (t / max) * PLOT_H;
    return `<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${SVG_W - PAD_R}" y2="${y.toFixed(1)}" class="grid-line"/><text x="${PAD_L - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" class="axis-label">${t}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${SVG_W} ${SVG_H}" class="activity-chart" role="img" aria-label="每日文章数柱状图">
    <defs>
      <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#2997ff" stop-opacity="0.9"/>
        <stop offset="100%" stop-color="#2997ff" stop-opacity="0.45"/>
      </linearGradient>
    </defs>
    ${yLines}
    ${bars}
    ${xLabels.join('')}
  </svg>`;
}
