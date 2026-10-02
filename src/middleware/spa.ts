import path from 'node:path';
import express, { Router } from 'express';
import type { Config } from '../config/env.js';

// Angular's esbuild output fingerprints bundles as e.g. main-ABCD1234.js; media/ holds hashed assets too.
const HASHED_BUNDLE = /-[A-Z0-9]{8}\.(?:js|mjs|css)$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Serves one built SPA (e.g. Angular `dist/<app>/browser`) mounted under its own path prefix.
 * Unknown client-side routes get index.html so deep links and page refreshes work.
 */
export function spaApp(dir: string, config: Pick<Config, 'STATIC_MAX_AGE'>) {
  const router = Router();

  router.use(
    express.static(dir, {
      index: 'index.html',
      dotfiles: 'deny',
      maxAge: config.STATIC_MAX_AGE,
      setHeaders: (res, filePath) => {
        const rel = path.relative(dir, filePath);
        if (rel.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
        else if (HASHED_BUNDLE.test(rel) || rel.startsWith(`media${path.sep}`)) res.setHeader('Cache-Control', IMMUTABLE);
      },
    }),
  );

  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const segments = req.path.split('/');
    if (segments.some((s) => s.startsWith('.'))) return next();

    // A missing asset (e.g. an old main-XXXX.js) must 404 rather than return HTML the browser
    // would try to run. Browser navigations ask for text/html, so routes like /users/john.doe still work.
    const isNavigation = (req.get('accept') ?? '').includes('text/html');
    if (path.posix.extname(req.path) && !isNavigation) return next();

    res.sendFile('index.html', { root: dir, cacheControl: false, headers: { 'Cache-Control': 'no-cache' } }, (err) => {
      if (err) next(err);
    });
  });

  return router;
}
