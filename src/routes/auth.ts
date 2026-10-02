import { Router, type Request, type Response } from 'express';
import type { OidcClient } from '../auth/oidc.js';
import type { Config } from '../config/env.js';
import { issueCsrfToken } from '../middleware/csrf.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { cookieOptions } from '../middleware/session.js';

const regenerate = (req: Request) =>
  new Promise<void>((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
const save = (req: Request) =>
  new Promise<void>((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
const destroy = (req: Request) =>
  new Promise<void>((resolve, reject) => req.session.destroy((err) => (err ? reject(err) : resolve())));

const PLACEHOLDER_ORIGIN = 'http://return-to.invalid';

/** Only same-site paths ("/inventory/x"), never "//evil.com", "/\evil.com" or absolute URLs (open redirect). */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/';
  try {
    const url = new URL(value, PLACEHOLDER_ORIGIN);
    return url.origin === PLACEHOLDER_ORIGIN ? url.pathname + url.search + url.hash : '/';
  } catch {
    return '/';
  }
}

// Only echo well-formed OAuth error codes back into the URL.
const loginError = (res: Response, code: unknown) =>
  res.redirect(`/?loginError=${typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : 'failed'}`);

export function authRouter(config: Config, oidc: OidcClient) {
  const router = Router();

  router.get('/csrf', (req, res) => {
    res.json({ csrfToken: issueCsrfToken(req) });
  });

  // Starts sign-in: remember state/nonce/PKCE in the session, then send the browser to the IdP.
  router.get('/login', async (req, res) => {
    let authRequest;
    try {
      authRequest = await oidc.createAuthRequest();
    } catch (err) {
      req.log.error({ err }, 'cannot reach identity provider');
      loginError(res, 'unavailable');
      return;
    }
    const { url, ...checks } = authRequest;
    req.session.oidc = { ...checks, returnTo: safeReturnTo(req.query.returnTo) };
    await save(req);
    res.redirect(url.href);
  });

  // The IdP redirects back here with ?code&state (or ?error when the user cancels).
  router.get('/callback', async (req, res) => {
    const pending = req.session.oidc;
    if (req.query.error) {
      delete req.session.oidc;
      loginError(res, req.query.error);
      return;
    }
    if (!pending) {
      res.status(400).json({ error: 'No login in progress' });
      return;
    }

    let user;
    try {
      // Rebuild the URL from the configured origin, not the Host header.
      user = await oidc.completeAuth(new URL(req.originalUrl, config.PUBLIC_BASE_URL), pending);
    } catch (err) {
      req.log.warn({ err }, 'login callback rejected');
      delete req.session.oidc;
      loginError(res, 'failed');
      return;
    }

    // New session ID on privilege change prevents session fixation; drops the pending OIDC values too.
    await regenerate(req);
    req.session.user = user;
    issueCsrfToken(req);
    await save(req);
    req.log.info({ userId: user.id }, 'user logged in');
    res.redirect(pending.returnTo);
  });

  // Ends the local session and returns the IdP sign-out URL for the browser to visit.
  router.post('/logout', async (req, res) => {
    await destroy(req);
    res.clearCookie(config.SESSION_NAME, cookieOptions(config));
    const logoutUrl = await oidc.endSessionUrl().catch((err: unknown) => {
      req.log.warn({ err }, 'cannot build IdP logout URL');
      return undefined;
    });
    res.json({ logoutUrl: logoutUrl?.href ?? '/' });
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.session.user });
  });

  return router;
}
