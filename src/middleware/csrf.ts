import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';

export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Returns the session's CSRF token, creating one if needed (synchronizer token pattern). */
export function issueCsrfToken(req: Request): string {
  req.session.csrfToken ??= randomBytes(32).toString('base64url');
  return req.session.csrfToken;
}

export const csrfProtection: RequestHandler = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();

  const expected = req.session?.csrfToken;
  const received = req.get(CSRF_HEADER);
  if (expected && received) {
    const a = Buffer.from(expected);
    const b = Buffer.from(received);
    if (a.length === b.length && timingSafeEqual(a, b)) return next();
  }
  res.status(403).json({ error: 'Invalid CSRF token' });
};
