import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Provider from 'oidc-provider';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createOidcClient } from '../src/auth/oidc.js';
import { loadConfig } from '../src/config/env.js';
import { sessionCookie, setupTestServer, testEnv } from './helpers.js';

/**
 * Full Authorization Code + PKCE flow against a real OpenID Provider (oidc-provider), exercising the
 * production OIDC client: discovery, PKCE, state, nonce and ID token validation.
 */

const APP_BASE = 'https://app.test';
const CLIENT = { id: 'web1', secret: 'integration-secret' };
const ACCOUNT = { sub: 'alice-sub', oid: '11111111-2222-3333-4444-555555555555', name: 'Alice Example', email: 'alice@contoso.test' };

let server: Awaited<ReturnType<typeof setupTestServer>>;
let idp: http.Server;
let issuer: string;

beforeAll(async () => {
  server = await setupTestServer();

  idp = http.createServer();
  await new Promise<void>((resolve) => idp.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;

  const provider = new Provider(issuer, {
    clients: [
      {
        client_id: CLIENT.id,
        client_secret: CLIENT.secret,
        redirect_uris: [`${APP_BASE}/api/auth/callback`],
        post_logout_redirect_uris: [`${APP_BASE}/`],
        token_endpoint_auth_method: 'client_secret_post',
      },
    ],
    // Like Entra ID: identity claims (including oid) are in the ID token itself.
    conformIdTokenClaims: false,
    claims: { openid: ['sub', 'oid'], profile: ['name'], email: ['email'] },
    findAccount: async (_ctx, sub) => ({
      accountId: sub,
      claims: async () => ({ ...ACCOUNT, sub }),
    }),
    cookies: { keys: ['integration-test-cookie-key'] },
  });

  // Replace the interactive login/consent pages: sign the account in and grant the requested scopes.
  idp.on('request', async (req, res) => {
    if (!req.url?.startsWith('/interaction/')) return provider.callback()(req, res);
    const details = await provider.interactionDetails(req, res);
    const grant = new provider.Grant({ accountId: ACCOUNT.sub, clientId: CLIENT.id });
    grant.addOIDCScope(String(details.params.scope));
    const grantId = await grant.save();
    await provider.interactionFinished(req, res, { login: { accountId: ACCOUNT.sub }, consent: { grantId } });
  });
});

afterAll(async () => {
  await new Promise((resolve) => idp.close(resolve));
  await server.teardown();
});

function makeApp() {
  const config = loadConfig(
    testEnv(server.mongoUri, {
      PUBLIC_BASE_URL: APP_BASE,
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: CLIENT.id,
      OIDC_CLIENT_SECRET: CLIENT.secret,
    }),
  );
  return createApp({
    config,
    client: server.client,
    logger: pino({ level: 'silent' }),
    oidc: createOidcClient(config, { allowInsecure: true }),
  });
}

/** Follows the IdP's redirects (keeping its cookies) until it sends the browser back to the app. */
async function signInAtIdp(authorizeUrl: string) {
  const browser = request.agent(issuer);
  let url = new URL(authorizeUrl);
  for (let hop = 0; hop < 10; hop++) {
    if (url.origin === APP_BASE) return url;
    const res = await browser.get(url.pathname + url.search);
    if (!res.headers.location) throw new Error(`IdP stopped at ${res.status}: ${res.text.slice(0, 200)}`);
    url = new URL(res.headers.location, url);
  }
  throw new Error('too many redirects');
}

describe('OIDC sign-in against a real provider', () => {
  it('signs in with PKCE, validates the ID token and maps Entra-style claims', async () => {
    const app = makeApp();
    const agent = request.agent(app);

    const start = await agent.get('/api/auth/login').query({ returnTo: '/sale/orders' }).expect(302);
    const authorize = new URL(start.headers.location!);
    expect(authorize.origin).toBe(issuer);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${APP_BASE}/api/auth/callback`);
    expect(authorize.searchParams.get('nonce')).toBeTruthy();

    const callback = await signInAtIdp(start.headers.location!);
    expect(callback.pathname).toBe('/api/auth/callback');

    const done = await agent.get(callback.pathname + callback.search).expect(302);
    expect(done.headers.location).toBe('/sale/orders');

    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.user).toEqual({ id: ACCOUNT.oid, name: ACCOUNT.name, email: ACCOUNT.email, roles: [] });
  });

  it('rejects a callback replayed into a different session', async () => {
    const app = makeApp();
    const victim = request.agent(app);
    const attacker = request.agent(app);

    await victim.get('/api/auth/login').expect(302);
    const start = await attacker.get('/api/auth/login').expect(302);
    const callback = await signInAtIdp(start.headers.location!);

    // The attacker's code+state do not match the victim's pending login (login CSRF).
    const res = await victim.get(callback.pathname + callback.search).expect(302);
    expect(res.headers.location).toBe('/?loginError=failed');
    await victim.get('/api/auth/me').expect(401);
  });

  it('returns the provider end-session URL on logout', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    const start = await agent.get('/api/auth/login').expect(302);
    const callback = await signInAtIdp(start.headers.location!);
    const done = await agent.get(callback.pathname + callback.search).expect(302);
    expect(sessionCookie(done)).toBeDefined();

    const csrf = (await agent.get('/api/auth/csrf')).body.csrfToken as string;
    const out = await agent.post('/api/auth/logout').set('X-CSRF-Token', csrf).expect(200);
    const logoutUrl = new URL(out.body.logoutUrl);
    expect(logoutUrl.origin).toBe(issuer);
    expect(logoutUrl.searchParams.get('post_logout_redirect_uri')).toBe(`${APP_BASE}/`);
  });
});
