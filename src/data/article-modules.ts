/**
 * Unified Markdown discovery for public and local-private articles.
 *
 * Security properties:
 * - CONTENT_MODE defaults to `public` (fail closed).
 * - Public articles and Corvus articles live under different roots.
 * - Private modules are Vite-aliased to an empty stub in public mode,
 *   so Corvus sources never enter the public module graph.
 * - A private article accidentally placed in the public root fails the build.
 */

import privateModulesRaw from '@private-articles';

export type ContentMode = 'public' | 'private';
export type ContentVisibility = 'public' | 'private';
export type MarkdownSource = 'public' | 'private';

export interface MarkdownFrontmatter {
  title: string;
  date: string;
  category?: string[];
  alsoCategories?: string[][];
  tags?: string[];
  description?: string;
  readingTime?: string;
  aiModel?: string;
  source?: unknown;
  reviewed?: boolean;
  pinned?: boolean;
  visibility?: ContentVisibility;
  comments?: boolean;
}

export interface MarkdownModule {
  default: unknown;
  frontmatter: MarkdownFrontmatter;
  getHeadings?: () => { depth: number; slug: string; text: string }[];
}

export interface MarkdownEntry {
  source: MarkdownSource;
  slug: string;
  path: string;
  module: MarkdownModule;
}

const rawMode = process.env.CONTENT_MODE ?? 'public';
if (rawMode !== 'public' && rawMode !== 'private') {
  throw new Error(`Invalid CONTENT_MODE=${JSON.stringify(rawMode)}; expected "public" or "private".`);
}

export const contentMode: ContentMode = rawMode;
export const includesPrivateContent = contentMode === 'private';

const publicModules = import.meta.glob<MarkdownModule>(
  '../pages/articles/_md/**/*.md',
  { eager: true },
);

const privateModules = privateModulesRaw as Record<string, MarkdownModule>;

function entriesFrom(
  modules: Record<string, MarkdownModule>,
  source: MarkdownSource,
  prefix: string,
): MarkdownEntry[] {
  return Object.entries(modules).map(([path, module]) => ({
    source,
    path,
    slug: path.replace(prefix, '').replace(/\.md$/, ''),
    module,
  }));
}

const publicEntries = entriesFrom(publicModules, 'public', '../pages/articles/_md/');
const privateEntries = entriesFrom(
  privateModules,
  'private',
  '../pages/articles/_private/articles/',
);

for (const entry of publicEntries) {
  if (entry.module.frontmatter.visibility === 'private') {
    throw new Error(
      `Private article ${entry.path} is inside the public Markdown root. Move it to Corvus.`,
    );
  }
}

if (includesPrivateContent) {
  for (const entry of privateEntries) {
    if (entry.module.frontmatter.visibility !== 'private') {
      throw new Error(
        `Corvus article ${entry.path} must declare frontmatter visibility: private.`,
      );
    }
  }
  if (privateEntries.length === 0) {
    console.warn(
      '[vibe-reading] CONTENT_MODE=private but no Corvus articles found. Run `npm run setup:private`.',
    );
  }
}

export const markdownEntries: MarkdownEntry[] = includesPrivateContent
  ? [...publicEntries, ...privateEntries]
  : publicEntries;

export const markdownEntryBySlug = new Map<string, MarkdownEntry>();
for (const entry of markdownEntries) {
  const previous = markdownEntryBySlug.get(entry.slug);
  if (previous) {
    throw new Error(
      `Duplicate article slug ${entry.slug}: ${previous.path} and ${entry.path}.`,
    );
  }
  markdownEntryBySlug.set(entry.slug, entry);
}
