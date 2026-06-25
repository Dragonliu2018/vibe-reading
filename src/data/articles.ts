export type Category = 'code' | 'paper' | 'system';

export interface Article {
  slug: string;        // 对应 /articles/{slug} 路径
  title: string;
  date: string;        // YYYY-MM-DD
  category: Category;
  tags: string[];
  description: string;
  readingTime?: string;
  aiModel?: string;    // 生成该文章的 AI 模型
}

export const CATEGORY_LABEL: Record<Category, string> = {
  code:   '代码解读',
  paper:  '论文解读',
  system: '系统设计',
};

export const CATEGORY_COLOR: Record<Category, { text: string; bg: string; border: string }> = {
  code:   { text: '#58a6ff', bg: 'rgba(88,166,255,.1)',  border: 'rgba(88,166,255,.28)'  },
  paper:  { text: '#bc8cff', bg: 'rgba(188,140,255,.1)', border: 'rgba(188,140,255,.28)' },
  system: { text: '#3fb950', bg: 'rgba(63,185,80,.1)',   border: 'rgba(63,185,80,.28)'   },
};

// ────────────────────────────────────────────────────
// 在这里添加新文章：复制一条记录并填写对应字段即可
// ────────────────────────────────────────────────────
export const articles: Article[] = [
  {
    slug:        'paperclip-intro',
    title:       'Paperclip — AI 智能体公司控制平面',
    date:        '2026-06-25',
    category:    'system',
    tags:        ['AI Agent', 'MCP', 'Claude', 'Kubernetes', 'PostgreSQL', '系统设计'],
    description: '像运营一家真实公司一样管理 AI 智能体团队——任务分配、预算控制、审批治理，Paperclip 开源 AI 智能体编排平台全景解读。',
    readingTime: '12 min',
    aiModel:     'Claude Opus 4.8',
  },
  {
    slug:        'markdown-demo',
    title:       'Markdown 文章示例',
    date:        '2026-06-24',
    category:    'paper',
    tags:        ['Markdown', 'Astro', 'Demo'],
    description: '这是一篇用于测试 Markdown 渲染效果的示例文章，覆盖常用语法元素。',
    readingTime: '2 min',
    aiModel:     'Claude Opus 4.8',
  },
  {
    slug:        'multica-codebase-overview',
    title:       'Multica 源码全景解读',
    date:        '2026-06-24',
    category:    'code',
    tags:        ['Go', 'Next.js', 'Electron', 'PostgreSQL', 'AI Agent'],
    description: 'AI 原生任务管理平台 Multica 的源码全景解读——Go 后端、Next.js 前端、Electron 桌面端、iOS 移动端的跨端架构深度剖析。',
    readingTime: '18 min',
    aiModel:     'Claude Opus 4.8',
  },
  {
    slug:        'mycli-architecture',
    title:       'mycli 架构解析（Markdown 版）',
    date:        '2026-06-24',
    category:    'code',
    tags:        ['Python', 'MySQL', 'CLI', 'prompt_toolkit', 'Pygments'],
    description: 'MySQL/MariaDB 命令行客户端 mycli v1.73.0 源码全面拆解——自动补全、语法高亮、SSH 隧道、LLM 集成的架构设计解读。',
    readingTime: '20 min',
    aiModel:     'Claude Opus 4.8',
  },
  {
    slug:        'mycli-architecture-html',
    title:       'mycli 架构解析（HTML 版）',
    date:        '2026-06-24',
    category:    'code',
    tags:        ['Python', 'MySQL', 'CLI', 'prompt_toolkit', 'Pygments'],
    description: '原始 HTML 版本，保留完整自定义样式——与 Markdown 版对比展示两种发布格式的渲染效果差异。',
    readingTime: '20 min',
    aiModel:     'Claude Opus 4.8',
  },
  {
    slug:        'langfuse-codebase-overview',
    title:       'Langfuse 源码深度解析',
    date:        '2026-06-24',
    category:    'code',
    tags:        ['Langfuse', 'Next.js', 'tRPC', 'ClickHouse', 'TypeScript'],
    description: '开源 LLM 工程平台 Langfuse v3.194.1 的完整源码解析——追踪、评估、提示词管理到自动化集成的全栈深度解读。',
    readingTime: '25 min',
    aiModel:     'Claude Opus 4.8',
  },
  {
    slug:        'litefuse-codebase-overview',
    title:       'Litefuse 代码库深度解读',
    date:        '2026-06-23',
    category:    'code',
    tags:        ['Next.js', 'tRPC', 'ClickHouse', 'BullMQ', 'TypeScript'],
    description: '开源 LLM 工程平台 Litefuse 的完整技术架构解析——从数据注入到评估、从提示词管理到自动化集成的全栈深度解读。',
    readingTime: '20 min',
    aiModel:     'Claude Opus 4.8',
  },
];
