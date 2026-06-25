export interface Quote {
  text:    string;
  author?: string;
}

export const quotes: Quote[] = [
  {
    text:   '技术文档深度解读——代码库架构、论文精读。',
  },
  {
    text:   'Talk is cheap. Show me the code.',
    author: 'Linus Torvalds',
  },
  {
    text:   '不积跬步，无以至千里；不积小流，无以成江海。',
    author: '荀子',
  },
  // ── 设计准则 ───────────────────────────────────────────────────────
  {
    text:   '不要重复自己。代码中每一份知识都应有唯一、权威的表达。',
    author: 'DRY 原则',
  },
  {
    text:   '对扩展开放，对修改关闭。',
    author: '开闭原则 · SOLID',
  },
  {
    text:   '一个模块，只有一个改变的理由。',
    author: '单一职责原则 · Robert C. Martin',
  },
  {
    text:   '针对接口编程，而非针对实现。',
    author: 'GoF 设计模式',
  },
  {
    text:   '优先使用组合，而非继承。',
    author: 'GoF 设计模式',
  },
  {
    text:   '不要为尚未存在的需求编写代码。',
    author: 'YAGNI 原则',
  },
  {
    text:   '关注点分离：把不同的问题交给不同的部分来解决，程序便会走向简单。',
    author: '软件设计原则',
  },

  // ── 优雅编程思想 ───────────────────────────────────────────────────
  {
    text:   '先让它工作，再让它正确，最后让它快。',
    author: 'Kent Beck',
  },
  {
    text:   '计算机科学只有两件难事：缓存失效，以及命名。',
    author: 'Phil Karlton',
  },
  {
    text:   '没有测试的代码就是遗留代码，无论它多么新鲜。',
    author: 'Michael Feathers',
  },
  {
    text:   '好的架构，让正确的事情容易，让错误的事情困难。',
    author: '软件架构思想',
  },
  {
    text:   '重构：在不改变外部行为的前提下，持续改善代码内部结构。',
    author: 'Martin Fowler',
  },
];
