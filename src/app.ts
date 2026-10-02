import path from 'node:path';
import express, { type Request } from 'express';
import type { MongoClient } from 'mongodb';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { createOidcClient, type OidcClient } from './auth/oidc.js';
import type { Config } from './config/env.js';
import { normalizeClientIp } from './middleware/clientIp.js';
import { csrfProtection } from './middleware/csrf.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { corsPolicy, securityHeaders } from './middleware/security.js';
import { createSessionMiddleware } from './middleware/session.js';
import { spaApp } from './middleware/spa.js';
import { authRouter } from './routes/auth.js';
import { healthRouter, type Lifecycle } from './routes/health.js';
import { mathRouter } from './routes/math.js';

export interface AppDeps {
  config: Config;
  client: MongoClient;
  logger: Logger;
  /** Set `shuttingDown` to fail readiness while the load balancer drains this instance. */
  lifecycle?: Lifecycle;
  /** Defaults to an OpenID Connect client built from config (Entra ID); tests inject a fake. */
  oidc?: OidcClient;
}

/**
 * Builds the Express app. All shared state (sessions, including CSRF tokens and the signed-in user)
 * is in MongoDB, so any number of instances can run behind a plain round-robin load balancer.
 */
export function createApp({
  config,
  client,
  logger,
  lifecycle = { shuttingDown: false },
  oidc = createOidcClient(config),
}: AppDeps) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);
  app.use(normalizeClientIp);

  app.use(
    pinoHttp({
      logger,
      redact: ['req.headers.cookie', 'req.headers.authorization', `req.headers["x-csrf-token"]`, 'res.headers["set-cookie"]'],
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
      // remoteAddress is the gateway's IP; log the real client too.
      customProps: (req) => ({ clientIp: (req as Request).ip }),
    }),
  );
  app.use(securityHeaders(config));

  // Probes and static assets come before the session so they never touch the session store.
  app.use(healthRouter(client, lifecycle));
  for (const spa of config.SPA_APPS) app.use(`/${spa.name}`, spaApp(spa.dir, config));
  app.use(
    express.static(path.resolve(config.STATIC_DIR), {
      dotfiles: 'deny',
      index: 'index.html',
      maxAge: config.STATIC_MAX_AGE,
      setHeaders: (res, filePath) => {
        // HTML must be revalidated so a deploy is picked up immediately; other assets use maxAge.
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  const api = express.Router();
  api.use(corsPolicy(config));
  api.use(express.json({ limit: config.BODY_LIMIT }));
  api.use(createSessionMiddleware(config, client));
  api.use(csrfProtection);
  api.use('/auth', authRouter(config, oidc));
  api.use('/math', mathRouter());
  app.use('/api', api);

  app.use(notFound);
  app.use(errorHandler({ exposeDetails: !config.isProduction }));

  return app;
}
