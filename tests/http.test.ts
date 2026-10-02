import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestServer } from './helpers.js';

let server: Awaited<ReturnType<typeof setupTestServer>>;

beforeAll(async () => {
  server = await setupTestServer();
});
afterAll(() => server.teardown());

describe('health probes', () => {
  it('reports liveness and readiness', async () => {
    const app = server.makeApp();
    await request(app).get('/healthz').expect(200, { status: 'ok' });
    await request(app).get('/readyz').expect(200, { status: 'ready' });
  });

  it('fails readiness but stays live and serving while shutting down', async () => {
    const lifecycle = { shuttingDown: false };
    const app = server.makeApp({}, { lifecycle });
    await request(app).get('/readyz').expect(200);

    lifecycle.shuttingDown = true;
    await request(app).get('/readyz').expect(503, { status: 'shutting-down' });
    await request(app).get('/healthz').expect(200);
    await request(app).get('/api/auth/csrf').expect(200);
  });

  it('does not create a session', async () => {
    const res = await request(server.makeApp()).get('/healthz');
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('security headers', () => {
  it('sets helmet headers and hides the framework', async () => {
    const res = await request(server.makeApp()).get('/healthz');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('sends HSTS in production', async () => {
    const res = await request(server.makeApp({ NODE_ENV: 'production' })).get('/healthz');
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
  });
});

describe('static files', () => {
  it('serves index.html with revalidation', async () => {
    const res = await request(server.makeApp()).get('/').expect(200);
    expect(res.text).toContain('fixture index');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('does not serve dotfiles', async () => {
    const res = await request(server.makeApp()).get('/.secret').expect(404);
    expect(res.text).not.toContain('TOP_SECRET');
  });

  it('rejects path traversal', async () => {
    const res = await request(server.makeApp()).get('/..%2f..%2fpackage.json');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).not.toContain('"dependencies"');
  });

  it('returns JSON 404 for unknown routes', async () => {
    await request(server.makeApp()).get('/nope').expect(404, { error: 'Not Found' });
    await request(server.makeApp()).get('/api/nope').expect(404, { error: 'Not Found' });
  });
});

describe('CORS', () => {
  it('allows only configured origins', async () => {
    const app = server.makeApp({ CORS_ORIGINS: 'https://app.example.com' });
    const allowed = await request(app).get('/api/auth/csrf').set('Origin', 'https://app.example.com');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const denied = await request(app).get('/api/auth/csrf').set('Origin', 'https://evil.example.com');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});
