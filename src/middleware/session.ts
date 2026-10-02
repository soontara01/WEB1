import session from 'express-session';
import { MongoStore } from 'connect-mongo';
import type { MongoClient } from 'mongodb';
import type { AuthRequestChecks, SessionUser } from '../auth/oidc.js';
import type { Config } from '../config/env.js';
import { COLLECTIONS } from '../db/mongo.js';

declare module 'express-session' {
  interface SessionData {
    user?: SessionUser;
    csrfToken?: string;
    /** Pending OIDC login, from /api/auth/login until the callback. */
    oidc?: AuthRequestChecks & { returnTo: string };
  }
}

export function cookieOptions(config: Config) {
  return {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax' as const,
    path: '/',
    domain: config.COOKIE_DOMAIN,
  };
}

/**
 * Sessions live in MongoDB, so any instance behind the load balancer can serve any request
 * (no sticky sessions). connect-mongo creates a TTL index to expire them.
 */
export function createSessionMiddleware(config: Config, client: MongoClient) {
  const ttl = config.SESSION_TTL_SECONDS;
  const store = MongoStore.create({
    client,
    dbName: config.MONGO_DB,
    collectionName: COLLECTIONS.sessions,
    ttl,
    autoRemove: 'native',
    // Limit writes for unchanged sessions; keep it well below the TTL so rolling cookies stay valid.
    touchAfter: Math.min(3600, Math.floor(ttl / 10)),
  });

  return session({
    name: config.SESSION_NAME,
    secret: config.SESSION_SECRETS,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { ...cookieOptions(config), maxAge: ttl * 1000 },
  });
}
