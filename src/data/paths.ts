/**
 * Path encoding for in-site article/category URLs.
 *
 * `encodeURIComponent` turns `+` into `%2B`. GitHub Pages decodes that
 * and finds `C-C++`, but Astro's local Vite router does not, so the same
 * sidebar link 404s on localhost. Keep `+` literal in the path.
 */

export function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%2B/gi, '+');
}

export function encodeArticleSlug(slug: string): string {
  return slug.split('/').map(encodePathSegment).join('/');
}
