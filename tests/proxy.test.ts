import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeClientIp, stripPort } from '../src/middleware/clientIp.js';
import { sessionCookie, setupTestServer } from './helpers.js';

let server: Awaited<ReturnType<typeof setupTestServer>>;

beforeAll(async () => {
  server = await setupTestServer();
});
afterAll(() => server.teardown());

describe('stripPort', () => {
  it.each([
    ['203.0.113.7:51234', '203.0.113.7'],
    ['203.0.113.7', '203.0.113.7'],
    ['[2001:db8::1]:443', '2001:db8::1'],
    ['[2001:db8::1]', '2001:db8::1'],
    ['2001:db8::1', '2001:db8::1'],
    ['::ffff:127.0.0.1', '::ffff:127.0.0.1'],
  ])('%s -> %s', (input, expected) => {
    expect(stripPort(input)).toBe(expected);
  });
});

describe('behind Azure Application Gateway (X-Forwarded-For includes the client port)', () => {
  // Same setup as createApp: trust one proxy hop, then normalize.
  const echoIp = express()
    .set('trust proxy', 1)
    .use(normalizeClientIp)
    .get('/', (req, res) => {
      res.json({ ip: req.ip });
    });

  it.each([
    ['203.0.113.7:51234', '203.0.113.7'],
    ['[2001:db8::1]:443', '2001:db8::1'],
    ['198.51.100.9', '198.51.100.9'],
  ])('req.ip for %s is %s', async (forwardedFor, expected) => {
    const res = await request(echoIp).get('/').set('X-Forwarded-For', forwardedFor).expect(200);
    expect(res.body.ip).toBe(expected);
  });

  it('does not send rate-limit headers (rate limiting is done at the gateway)', async () => {
    const res = await request(server.makeApp()).get('/api/auth/csrf').expect(200);
    expect(res.headers['ratelimit']).toBeUndefined();
    expect(res.headers['ratelimit-policy']).toBeUndefined();
  });
});

describe('TRUST_PROXY as a CIDR (the App Gateway subnet)', () => {
  it('trusts forwarded headers from inside the subnet', async () => {
    const app = server.makeApp({ NODE_ENV: 'production', TRUST_PROXY: '127.0.0.0/8,::1/128' });
    const res = await request(app).get('/api/auth/csrf').set('X-Forwarded-Proto', 'https').expect(200);
    expect(sessionCookie(res)).toMatch(/Secure/);
  });

  it('ignores forwarded headers from outside the subnet', async () => {
    const app = server.makeApp({ NODE_ENV: 'production', TRUST_PROXY: '10.225.0.0/24' });
    const res = await request(app).get('/api/auth/csrf').set('X-Forwarded-Proto', 'https').expect(200);
    // Not trusted → request is plain HTTP → express-session refuses to send a Secure cookie.
    expect(sessionCookie(res)).toBeUndefined();
  });
});
