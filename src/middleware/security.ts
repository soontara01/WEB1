import cors from 'cors';
import helmet from 'helmet';
import type { Config } from '../config/env.js';
import { CSRF_HEADER } from './csrf.js';

export function securityHeaders(config: Config) {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'object-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': config.isProduction ? [] : null,
      },
    },
    strictTransportSecurity: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });
}

/** Only origins in CORS_ORIGINS may make credentialed cross-origin calls; same-origin requests are unaffected. */
export function corsPolicy(config: Config) {
  const allowed = new Set(config.CORS_ORIGINS);
  return cors({
    origin: (origin, cb) => cb(null, !origin || allowed.has(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', CSRF_HEADER],
    maxAge: 600,
  });
}
