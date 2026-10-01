import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import GithubSlugger from 'github-slugger';
import { markdownEntries, markdownEntryBySlug } from './article-modules';
import { encodeArticleSlug } from './paths';

type ArticleLinkRelation = 'direct' | 'related' | 'reference';

export interface ArticleBacklink {
  sourceSlug: string;
  sourceTitle: string;
  sourceDate: string;
  sourceHref: string;
  sourceHeading?: string;
  relation: ArticleLinkRelation;
  company?: string;
  team?: string;
  round?: string;
  occurrenceDate?: string;
  origin?: 'Public' | 'Private';
}

interface HeadingContext {
  depth: number;
  text: string;
  slug: string;
}

const BASE = '/vibe-reading';
const HEADING_NUMBER_PREFIX = /^\s*(?:\d+(?:\.\d+)+[.、]?|\d+[.、])\s+/;

function numberedHeadingText(text: string, depth: number, counters: number[]): string {
  for (let current = 2; current < depth; current++) {
    if (counters[current] === 0) counters[current] = 1;
  }
  counters[depth] += 1;
  for (let current = depth + 1; current <= 6; current++) counters[current] = 0;
  const number = counters.slice(2, depth + 1).join('.');
  return `${number}${depth === 2 ? '.' : ''} ${text.replace(HEADING_NUMBER_PREFIX, '')}`;
}

function nodeText(node: any): string {
  if (typeof node?.value === 'string') return node.value;
  if (!Array.isArray(node?.children)) return '';
  return node.children.map(nodeText).join('');
}

function markdownBody(markdown: string): string {
  return markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
}

function decodePath(value: string): string {
  return value.split('/').map(segment => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  }).join('/');
}

function normalizeTarget(href: string): { slug: string; fragment?: string } | null {
  if (!href || href.startsWith('#')) return null;

  let url: URL;
  try {
    url = new URL(href, 'https://vibe-reading.local');
  } catch {
    return null;
  }

  const prefixes = [`${BASE}/articles/`, '/articles/'];
  const prefix = prefixes.find(value => url.pathname.startsWith(value));
  if (!prefix) return null;

  const slug = decodePath(url.pathname.slice(prefix.length))
    .replace(/\/$/, '')
    .replace(/\.md$/, '');
  if (!slug || !markdownEntryBySlug.has(slug)) return null;

  let fragment: string | undefined;
  if (url.hash.length > 1) {
    try { fragment = decodeURIComponent(url.hash.slice(1)); }
    catch { fragment = url.hash.slice(1); }
  }
  return { slug, fragment };
}

function interviewIdentity(category: string[]): { company?: string; team?: string } | null {
  const index = category.indexOf('面经');
  if (index === -1) return null;
  const company = category[index + 1];
  const team = category.slice(index + 2).join(' / ') || undefined;
  return { company, team };
}

function interviewRound(section?: HeadingContext, fallbackDate?: string): {
  round?: string;
  occurrenceDate?: string;
} {
  if (!section) return { occurrenceDate: fallbackDate?.slice(0, 10) };
  const date = section.text.match(/[（(](\d{4}-\d{2}-\d{2})[）)]/)?.[1]
    ?? fallbackDate?.slice(0, 10);
  const round = section.text
    .replace(/^\s*\d+(?:\.\d+)*[.、]?\s*/, '')
    .replace(/\s*[（(]\d{4}-\d{2}-\d{2}[）)]\s*$/, '')
    .trim();
  return { round: round || undefined, occurrenceDate: date };
}

interface MarkdownLink {
  url: string;
  context: string;
}

function collectLinks(
  node: any,
  definitions: Map<string, string>,
  output: MarkdownLink[],
  source: string,
  context = '',
) {
  if (!node || typeof node !== 'object') return;
  const currentContext = node.type === 'paragraph' ? nodeText(node).trim() : context;
  const linkContext = () => {
    const offset = node.position?.start?.offset;
    if (typeof offset !== 'number') return currentContext;
    const lineStart = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    return source.slice(lineStart, offset).trim() || currentContext;
  };
  if (node.type === 'link' && typeof node.url === 'string') {
    output.push({ url: node.url, context: linkContext() });
    return;
  }
  if (node.type === 'linkReference') {
    const url = definitions.get(String(node.identifier ?? '').toLowerCase());
    if (url) output.push({ url, context: linkContext() });
    return;
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectLinks(child, definitions, output, source, currentContext);
  }
}

function linkRelation(hasInterviewIdentity: boolean, context: string): ArticleLinkRelation {
  if (!hasInterviewIdentity) return 'reference';
  if (/(?:相关模型|延伸阅读|可参考|类似题|相关题)/.test(context)) {
    return 'related';
  }
  return 'direct';
}

function buildBacklinks(): Map<string, ArticleBacklink[]> {
  const result = new Map<string, ArticleBacklink[]>();
  const seen = new Set<string>();

  for (const entry of markdownEntries) {
    const sourceArticle = entry.module.frontmatter;
    const sourceCategory = sourceArticle.category ?? [];

    const sourceRoot = entry.source === 'private'
      ? join(process.cwd(), 'src/pages/articles/_private/articles')
      : join(process.cwd(), 'src/pages/articles/_md');
    const sourcePath = join(sourceRoot, `${entry.slug}.md`);
    const markdown = readFileSync(sourcePath, 'utf8');
    if (!markdown.includes('/articles/')) continue;

    const body = markdownBody(markdown);
    const tree: any = unified().use(remarkParse).parse(body);
    const definitions = new Map<string, string>();
    for (const child of tree.children ?? []) {
      if (child.type === 'definition' && typeof child.url === 'string') {
        definitions.set(String(child.identifier ?? '').toLowerCase(), child.url);
      }
    }

    const slugger = new GithubSlugger();
    const headingStack = new Map<number, HeadingContext>();
    const headingCounters = Array(7).fill(0);
    const identity = interviewIdentity(sourceCategory);

    for (const child of tree.children ?? []) {
      if (child.type === 'heading') {
        const rawText = nodeText(child).trim();
        const text = sourceArticle.autoNumberHeadings === true && child.depth >= 2 && child.depth <= 6
          ? numberedHeadingText(rawText, child.depth, headingCounters)
          : rawText;
        const heading: HeadingContext = {
          depth: child.depth,
          text,
          slug: slugger.slug(text),
        };
        for (const depth of [...headingStack.keys()]) {
          if (depth >= heading.depth) headingStack.delete(depth);
        }
        headingStack.set(heading.depth, heading);
        continue;
      }

      const links: MarkdownLink[] = [];
      collectLinks(child, definitions, links, body);
      if (links.length === 0) continue;

      const contexts = [...headingStack.values()].sort((a, b) => a.depth - b.depth);
      const nearest = contexts.at(-1);
      const section = headingStack.get(2);
      const round = interviewRound(section, sourceArticle.date);

      for (const link of links) {
        const target = normalizeTarget(link.url);
        if (!target || target.slug === entry.slug) continue;

        const key = [target.slug, entry.slug, nearest?.slug ?? '', target.fragment ?? ''].join('\u0000');
        if (seen.has(key)) continue;
        seen.add(key);

        const sourceHref = `${BASE}/articles/${encodeArticleSlug(entry.slug)}`
          + (nearest?.slug ? `#${encodeURIComponent(nearest.slug)}` : '');
        const backlink: ArticleBacklink = {
          sourceSlug: entry.slug,
          sourceTitle: sourceArticle.title,
          sourceDate: sourceArticle.date,
          sourceHref,
          sourceHeading: nearest?.text,
          relation: linkRelation(!!identity, link.context),
          company: identity?.company,
          team: identity?.team,
          round: identity ? round.round : undefined,
          occurrenceDate: identity ? round.occurrenceDate : undefined,
          origin: identity ? (sourceArticle.visibility === 'private' ? 'Private' : 'Public') : undefined,
        };

        const current = result.get(target.slug) ?? [];
        current.push(backlink);
        result.set(target.slug, current);
      }
    }
  }

  for (const backlinks of result.values()) {
    backlinks.sort((a, b) =>
      (b.occurrenceDate ?? b.sourceDate).localeCompare(a.occurrenceDate ?? a.sourceDate)
      || a.sourceTitle.localeCompare(b.sourceTitle, 'zh-CN'),
    );
  }
  return result;
}

const backlinksByTarget = buildBacklinks();

export function getBacklinksForSlug(slug: string): ArticleBacklink[] {
  return backlinksByTarget.get(slug) ?? [];
}
