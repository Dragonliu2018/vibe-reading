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
