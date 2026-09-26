import type { APIRoute } from 'astro';
import { renderArticleSidebarTree } from '../data/sidebar-tree';

export const prerender = true;

export const GET: APIRoute = () => new Response(renderArticleSidebarTree(), {
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
  },
});
