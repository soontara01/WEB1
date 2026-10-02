import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestServer } from './helpers.js';

const SPA_APPS = 'inventory:tests/fixtures/spa/inventory,sale:tests/fixtures/spa/sale';
const HTML = 'text/html,application/xhtml+xml';

let server: Awaited<ReturnType<typeof setupTestServer>>;
let app: ReturnType<typeof server.makeApp>;

beforeAll(async () => {
  server = await setupTestServer();
  app = server.makeApp({ SPA_APPS });
});
afterAll(() => server.teardown());

describe('SPA hosting', () => {
  it('redirects the bare prefix to a trailing slash for <base href>', async () => {
    const res = await request(app).get('/inventory').expect(301);
    expect(res.headers.location).toBe('/inventory/');
  });

  it('serves each app at its own prefix', async () => {
    const inv = await request(app).get('/inventory/').expect(200);
    expect(inv.text).toContain('inventory app');
    expect(inv.headers['cache-control']).toBe('no-cache');

    const sale = await request(app).get('/sale/').expect(200);
    expect(sale.text).toContain('sale app');
  });

  it('falls back to index.html for client-side routes', async () => {
    const deep = await request(app).get('/inventory/products/42').set('Accept', HTML).expect(200);
    expect(deep.text).toContain('inventory app');
    expect(deep.headers['cache-control']).toBe('no-cache');

    const sale = await request(app).get('/sale/orders/new').expect(200);
    expect(sale.text).toContain('sale app');
  });

  it('treats navigations to dotted routes as client-side routes', async () => {
    const res = await request(app).get('/inventory/users/john.doe').set('Accept', HTML).expect(200);
    expect(res.text).toContain('inventory app');
  });

  it('caches hashed bundles and media forever, other assets per STATIC_MAX_AGE', async () => {
    const main = await request(app).get('/inventory/main-ABCD1234.js').expect(200);
    expect(main.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    const font = await request(app).get('/inventory/media/font.woff2').expect(200);
    expect(font.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    const icon = await request(app).get('/inventory/favicon.ico').expect(200);
    expect(icon.headers['cache-control']).toBe('public, max-age=3600');
  });

  it('returns 404 (not HTML) for missing assets', async () => {
    const res = await request(app).get('/inventory/main-OLDHASH1.js').expect(404);
    expect(res.body).toEqual({ error: 'Not Found' });
  });

  it('keeps apps isolated from each other', async () => {
    await request(app).get('/sale/main-ABCD1234.js').expect(404);
  });

  it('does not serve dotfiles or accept non-GET requests', async () => {
    const dot = await request(app).get('/inventory/.secret').set('Accept', HTML).expect(404);
    expect(dot.text).not.toContain('SECRET');
    await request(app).post('/inventory/products').expect(404);
  });

  it('does not create sessions and leaves the rest of the server unchanged', async () => {
    const res = await request(app).get('/inventory/products/1');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");

    await request(app).get('/api/auth/me').expect(401);
    const root = await request(app).get('/').expect(200);
    expect(root.text).toContain('fixture index');
  });
});
