/**
 * Corvus private Markdown.
 *
 * Only imported when CONTENT_MODE=private. Public builds resolve
 * `@private-articles` to `private-articles-stub.ts` instead, so these
 * files never enter the Vite module graph.
 */
export default import.meta.glob('../pages/articles/_private/articles/**/*.md', {
  eager: true,
});
