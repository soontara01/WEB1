import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { pino } from 'pino';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createApp } from '../src/app.js';
import type { AuthRequestChecks, OidcClient, SessionUser } from '../src/auth/oidc.js';
import { loadConfig, type Config } from '../src/config/env.js';
import { connectMongo } from '../src/db/mongo.js';
import type { Lifecycle } from '../src/routes/health.js';

export const TEST_USER: SessionUser = {
  id: '00000000-0000-0000-0000-00000000a11c',
  name: 'Alice',
  email: 'alice@example.com',
  roles: [],
};

export const FAKE_IDP = 'https://idp.test';
export const VALID_CODE = 'valid-code';

/**
 * Stands in for Entra ID. Like the real client it keeps no state of its own: the app stores
 * state/nonce/verifier in the session and hands them back in completeAuth.
 */
export class FakeOidcClient implements OidcClient {
  constructor(
    public user: SessionUser = TEST_USER,
    public available = true,
  ) {}

  async createAuthRequest() {
    if (!this.available) throw new Error('IdP unreachable');
    const state = randomUUID();
    return { url: new URL(`${FAKE_IDP}/authorize?state=${state}`), state, nonce: randomUUID(), codeVerifier: randomUUID() };
  }

  async completeAuth(callbackUrl: URL, expected: AuthRequestChecks) {
    if (callbackUrl.searchParams.get('state') !== expected.state) throw new Error('state mismatch');
    if (callbackUrl.searchParams.get('code') !== VALID_CODE) throw new Error('invalid_grant');
    return this.user;
  }

  async endSessionUrl() {
    return new URL(`${FAKE_IDP}/logout`);
  }
}

export function testEnv(mongoUri: string, overrides: Record<string, string> = {}) {
  return {
    NODE_ENV: 'test',
    MONGO_URI: mongoUri,
    MONGO_DB: 'test',
    SESSION_SECRETS: 'test-secret-that-is-at-least-32-characters-long',
    LOG_LEVEL: 'silent',
    STATIC_DIR: 'tests/fixtures/public',
    PUBLIC_BASE_URL: 'https://app.test',
    OIDC_ISSUER: FAKE_IDP,
    OIDC_CLIENT_ID: 'test-client',
    OIDC_CLIENT_SECRET: 'test-client-secret',
    ...overrides,
  };
}

/** Starts an in-memory MongoDB and returns a factory for app instances that share it. */
export async function setupTestServer() {
  const mongod = await MongoMemoryServer.create();
  const baseConfig = loadConfig(testEnv(mongod.getUri()));
  const { client } = await connectMongo(baseConfig);
  const logger = pino({ level: 'silent' });

  return {
    client,
    mongoUri: mongod.getUri(),
    /** Each call is an independent app instance, like a separate process behind a load balancer. */
    makeApp(
      overrides: Record<string, string> = {},
      { lifecycle, oidc = new FakeOidcClient() }: { lifecycle?: Lifecycle; oidc?: OidcClient } = {},
    ) {
      const config: Config = loadConfig(testEnv(mongod.getUri(), overrides));
      return createApp({ config, client, logger, lifecycle, oidc });
    },
    async teardown() {
      await client.close();
      await mongod.stop();
    },
  };
}

export async function getCsrf(agent: ReturnType<typeof request.agent>) {
  const res = await agent.get('/api/auth/csrf').expect(200);
  return res.body.csrfToken as string;
}

/** Starts a login and returns the state the (fake) IdP was given. */
export async function startLogin(agent: ReturnType<typeof request.agent>, returnTo?: string) {
  const res = await agent.get('/api/auth/login').query(returnTo === undefined ? {} : { returnTo }).expect(302);
  return { res, state: new URL(res.headers.location!).searchParams.get('state')! };
}

/** Full sign-in through /login and /callback; `res` is the callback response. */
export async function login(app: App, { returnTo, code = VALID_CODE }: { returnTo?: string; code?: string } = {}) {
  const agent = request.agent(app);
  const { state } = await startLogin(agent, returnTo);
  const res = await agent.get('/api/auth/callback').query({ code, state });
  return { agent, res };
}

export function sessionCookie(res: request.Response, name = 'sid') {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  return cookies.find((c) => c.startsWith(`${name}=`));
}
