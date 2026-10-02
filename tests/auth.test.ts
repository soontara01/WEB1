import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeReturnTo } from '../src/routes/auth.js';
import {
  FAKE_IDP,
  FakeOidcClient,
  TEST_USER,
  VALID_CODE,
  getCsrf,
  login,
  sessionCookie,
  setupTestServer,
  startLogin,
} from './helpers.js';

let server: Awaited<ReturnType<typeof setupTestServer>>;

beforeAll(async () => {
  server = await setupTestServer();
});
afterAll(() => server.teardown());

describe('GET /api/auth/login', () => {
  it('redirects to the identity provider', async () => {
    const { res } = await startLogin(request.agent(server.makeApp()));
    expect(res.headers.location).toMatch(new RegExp(`^${FAKE_IDP}/authorize\\?state=`));
    expect(sessionCookie(res)).toBeDefined();
  });

  it('sends the user back with an error when the IdP is unreachable', async () => {
    const app = server.makeApp({}, { oidc: new FakeOidcClient(TEST_USER, false) });
    const res = await request(app).get('/api/auth/login').expect(302);
    expect(res.headers.location).toBe('/?loginError=unavailable');
  });
});

describe('GET /api/auth/callback', () => {
  it('signs the user in and redirects to returnTo', async () => {
    const { agent, res } = await login(server.makeApp(), { returnTo: '/inventory/orders?x=1' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/inventory/orders?x=1');

    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.user).toEqual(TEST_USER);
  });

  it('redirects to / by default', async () => {
    const { res } = await login(server.makeApp());
    expect(res.headers.location).toBe('/');
  });

  it.each(['//evil.com', 'https://evil.com/x', '/\\evil.com', 'javascript:alert(1)'])(
    'ignores unsafe returnTo %s',
    async (returnTo) => {
      const { res } = await login(server.makeApp(), { returnTo });
      expect(res.headers.location).toBe('/');
    },
  );

  it('rejects a callback whose state does not match the session', async () => {
    const agent = request.agent(server.makeApp());
    await startLogin(agent);
    const res = await agent.get('/api/auth/callback').query({ code: VALID_CODE, state: 'forged' }).expect(302);
    expect(res.headers.location).toBe('/?loginError=failed');
    await agent.get('/api/auth/me').expect(401);
  });

  it('rejects an invalid code and cannot be retried with the same state', async () => {
    const agent = request.agent(server.makeApp());
    const { state } = await startLogin(agent);
    const bad = await agent.get('/api/auth/callback').query({ code: 'bad', state });
    expect(bad.headers.location).toBe('/?loginError=failed');
    await agent.get('/api/auth/callback').query({ code: VALID_CODE, state }).expect(400);
  });

  it('returns 400 without a login in progress', async () => {
    await request(server.makeApp()).get('/api/auth/callback').query({ code: VALID_CODE, state: 'x' }).expect(400);
  });

  it('passes through IdP errors such as a cancelled sign-in', async () => {
    const agent = request.agent(server.makeApp());
    await startLogin(agent);
    const res = await agent.get('/api/auth/callback').query({ error: 'access_denied' }).expect(302);
    expect(res.headers.location).toBe('/?loginError=access_denied');
  });

  it('does not reflect arbitrary error text', async () => {
    const res = await request(server.makeApp())
      .get('/api/auth/callback')
      .query({ error: '<script>alert(1)</script>' })
      .expect(302);
    expect(res.headers.location).toBe('/?loginError=failed');
  });
});

describe('session', () => {
  it('sets hardened cookie flags', async () => {
    const { res } = await login(server.makeApp());
    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('sets Secure cookies in production behind a TLS-terminating proxy', async () => {
    const app = server.makeApp({ NODE_ENV: 'production', TRUST_PROXY: '1' });
    const res = await request(app).get('/api/auth/csrf').set('X-Forwarded-Proto', 'https').expect(200);
    expect(sessionCookie(res)).toMatch(/Secure/);
  });

  it('rotates the session ID on login (session fixation)', async () => {
    const agent = request.agent(server.makeApp());
    const { res: pre, state } = await startLogin(agent);
    const res = await agent.get('/api/auth/callback').query({ code: VALID_CODE, state });

    const before = sessionCookie(pre)!.split(';')[0];
    const after = sessionCookie(res)!.split(';')[0];
    expect(after).not.toBe(before);
  });

  it('requires authentication for /me', async () => {
    await request(server.makeApp()).get('/api/auth/me').expect(401);
  });

  it('logs out, returns the IdP logout URL and invalidates the old cookie', async () => {
    const app = server.makeApp();
    const { agent, res } = await login(app);
    const oldCookie = sessionCookie(res)!.split(';')[0]!;
    const csrf = await getCsrf(agent);

    const out = await agent.post('/api/auth/logout').set('X-CSRF-Token', csrf).expect(200);
    expect(out.body).toEqual({ logoutUrl: `${FAKE_IDP}/logout` });
    await agent.get('/api/auth/me').expect(401);
    await request(app).get('/api/auth/me').set('Cookie', oldCookie).expect(401);
  });

  it('is shared across app instances (horizontal scaling)', async () => {
    const instanceA = server.makeApp();
    const instanceB = server.makeApp();

    const { agent, res } = await login(instanceA);
    const cookie = sessionCookie(res)!.split(';')[0]!;
    const csrf = await getCsrf(agent);

    const me = await request(instanceB).get('/api/auth/me').set('Cookie', cookie).expect(200);
    expect(me.body.user.email).toBe(TEST_USER.email);

    // CSRF token issued by A is accepted by B too.
    await request(instanceB).post('/api/auth/logout').set('Cookie', cookie).set('X-CSRF-Token', csrf).expect(200);
    await request(instanceA).get('/api/auth/me').set('Cookie', cookie).expect(401);
  });

  it('a login started on one instance can complete on another', async () => {
    const agentA = request.agent(server.makeApp());
    const { res, state } = await startLogin(agentA);
    const cookie = sessionCookie(res)!.split(';')[0]!;

    const callback = await request(server.makeApp())
      .get('/api/auth/callback')
      .set('Cookie', cookie)
      .query({ code: VALID_CODE, state })
      .expect(302);
    expect(callback.headers.location).toBe('/');
  });
});

describe('CSRF', () => {
  it('rejects state-changing requests without a token', async () => {
    const { agent } = await login(server.makeApp());
    await agent.post('/api/auth/logout').expect(403);
    await agent.get('/api/auth/me').expect(200);
  });

  it('rejects a wrong token', async () => {
    const { agent } = await login(server.makeApp());
    await agent.post('/api/auth/logout').set('X-CSRF-Token', 'forged').expect(403);
  });

  it('rejects a token without a session', async () => {
    const { agent } = await login(server.makeApp());
    const csrf = await getCsrf(agent);
    await request(server.makeApp()).post('/api/auth/logout').set('X-CSRF-Token', csrf).expect(403);
  });
});

describe('request body limit', () => {
  it('rejects oversized JSON bodies before any handler runs', async () => {
    const agent = request.agent(server.makeApp({ BODY_LIMIT: '1kb' }));
    const csrf = await getCsrf(agent);
    await agent
      .post('/api/auth/logout')
      .set('X-CSRF-Token', csrf)
      .send({ padding: 'x'.repeat(2048) })
      .expect(413);
  });
});

describe('safeReturnTo', () => {
  it.each([
    ['/inventory/orders?x=1#top', '/inventory/orders?x=1#top'],
    ['/', '/'],
    ['//evil.com', '/'],
    ['/\\evil.com', '/'],
    ['https://evil.com', '/'],
    ['inventory', '/'],
    [undefined, '/'],
    [['/a', '/b'], '/'],
  ])('%j -> %s', (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });
});
