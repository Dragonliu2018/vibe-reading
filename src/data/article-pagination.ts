import { articles } from './articles';

export const ARTICLE_PAGE_SIZE = 60;
export const articlesByDate = [...articles].sort(
  (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
);
export const articlePageCount = Math.max(1, Math.ceil(articlesByDate.length / ARTICLE_PAGE_SIZE));

export function getArticlePage(page: number) {
  const start = (page - 1) * ARTICLE_PAGE_SIZE;
  return articlesByDate.slice(start, start + ARTICLE_PAGE_SIZE);
}
