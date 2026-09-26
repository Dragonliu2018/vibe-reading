import {
  cpSync,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const IMAGE_PREFIXES = ['/vibe-reading/imgs/', '/imgs/'];
const IMAGE_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Resolve an image request without allowing it to escape sourceDir. */
export function resolvePrivateImageFile(sourceDir, requestUrl) {
  const pathname = (requestUrl ?? '').split('?')[0];
  const prefix = IMAGE_PREFIXES.find((candidate) => pathname.startsWith(candidate));
  if (!prefix) return null;

  let requested;
  try {
    requested = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }

  if (!requested || requested.includes('\0')) return null;
  // Treat URL backslashes as separators on every host so the Linux check is
  // equally safe when the project runs on Windows.
  requested = requested.replace(/\\/g, '/');

  try {
    const root = realpathSync(resolve(sourceDir));
    const candidate = resolve(root, requested);
    if (!isInside(root, candidate) || !existsSync(candidate)) return null;

    // A lexical containment check is not enough when an image is a symlink.
    const realCandidate = realpathSync(candidate);
    if (!isInside(root, realCandidate) || !statSync(realCandidate).isFile()) return null;
    return realCandidate;
  } catch {
    return null;
  }
}

export function privateImagesIntegration({ enabled, sourceDir }) {
  return {
    name: 'copy-private-imgs',
    hooks: {
      'astro:build:done': async ({ dir }) => {
        if (!enabled || !existsSync(sourceDir)) return;
        cpSync(sourceDir, resolve(fileURLToPath(dir), 'imgs'), { recursive: true });
      },
    },
  };
}

export function privateImagesDevPlugin({ enabled, sourceDir }) {
  return {
    name: 'private-imgs-dev-server',
    configureServer(server) {
      if (!enabled) return;
      server.middlewares.use((req, res, next) => {
        const filePath = resolvePrivateImageFile(sourceDir, req.url);
        if (!filePath) return next();

        try {
          res.setHeader('Content-Type', IMAGE_MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.end(readFileSync(filePath));
        } catch (error) {
          next(error);
        }
      });
    },
  };
}
