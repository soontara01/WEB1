import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

// Express accepts a hop count, a boolean, or a comma-separated list of trusted addresses/subnets.
const trustProxy = z.string().transform((v): boolean | number | string => {
  if (v === 'true') return true;
  if (v === 'false' || v === '') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
});

// Top-level paths the server already owns; an SPA mounted there would shadow them.
const RESERVED_SPA_NAMES = new Set(['api', 'healthz', 'readyz']);

export interface SpaApp {
  name: string;
  dir: string;
}

// "name:dir,name:dir". Split on the first ':' only so Windows paths (C:\...) work.
const spaApps = csv.transform((entries, ctx): SpaApp[] => {
  const apps: SpaApp[] = [];
  for (const entry of entries) {
    const sep = entry.indexOf(':');
    const name = entry.slice(0, sep).trim();
    const dir = path.resolve(entry.slice(sep + 1).trim());
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message: `"${entry}": ${message}` });

    if (sep <= 0 || sep === entry.length - 1) fail('expected name:dir');
    else if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail('name must be lowercase letters, digits and dashes');
    else if (RESERVED_SPA_NAMES.has(name)) fail(`name "${name}" is reserved`);
    else if (apps.some((a) => a.name === name)) fail(`duplicate name "${name}"`);
    else if (!existsSync(path.join(dir, 'index.html'))) fail(`${dir} does not contain index.html`);
    else apps.push({ name, dir });
  }
  return apps;
});

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    TRUST_PROXY: trustProxy.default(false),
    // On SIGTERM, fail readiness and keep serving this long before closing, so the load balancer
    // (e.g. AGIC updating Application Gateway) stops routing here first. 0 = close immediately.
    SHUTDOWN_DELAY_MS: z.coerce.number().int().min(0).max(120_000).default(0),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    MONGO_URI: z.string().min(1),
    MONGO_DB: z.string().min(1).default('app'),
    // Per instance. Keep maxReplicas × this below the MongoDB/Atlas tier's connection limit.
    MONGO_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(500).default(20),

    // First secret signs new cookies; the rest are still accepted, so secrets can be rotated.
    SESSION_SECRETS: csv.pipe(
      z
        .array(z.string().min(32, 'each session secret must be at least 32 characters'))
        .min(1, 'at least one session secret is required'),
    ),
    SESSION_NAME: z.string().regex(/^[\w-]+$/).default('sid'),
    SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24),
    COOKIE_DOMAIN: z.string().optional(),
    COOKIE_SECURE: bool.optional(),

    // Public origin users reach the app at (behind the gateway). The OIDC redirect URI is built
    // from this, never from the Host header.
    PUBLIC_BASE_URL: z
      .url({ protocol: /^https?$/ })
      .transform((v) => v.replace(/\/+$/, '')),
    // Entra ID: https://login.microsoftonline.com/<tenant-id GUID>/v2.0
    OIDC_ISSUER: z.url({ protocol: /^https?$/ }),
    OIDC_CLIENT_ID: z.string().min(1),
    OIDC_CLIENT_SECRET: z.string().min(1),
    OIDC_SCOPES: z.string().default('openid profile email'),

    CORS_ORIGINS: csv.default([]),

    STATIC_DIR: z.string().default('public'),
    STATIC_MAX_AGE: z.string().default('1h'),
    SPA_APPS: spaApps.default([]),

    BODY_LIMIT: z.string().default('100kb'),
  })
  .transform((env) => ({
    ...env,
    isProduction: env.NODE_ENV === 'production',
    COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
  }));

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings as unset so `FOO=` in .env falls back to the default.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const config = result.data;
  if (config.isProduction && !config.COOKIE_SECURE) {
    throw new Error('Invalid environment configuration:\n  - COOKIE_SECURE must not be false in production');
  }
  if (config.isProduction && !config.PUBLIC_BASE_URL.startsWith('https://')) {
    throw new Error('Invalid environment configuration:\n  - PUBLIC_BASE_URL must use https in production');
  }
  if (config.isProduction && !config.OIDC_ISSUER.startsWith('https://')) {
    throw new Error('Invalid environment configuration:\n  - OIDC_ISSUER must use https in production');
  }
  return config;
}
