import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { testEnv } from './helpers.js';

const base = testEnv('mongodb://localhost:27017');

describe('loadConfig', () => {
  it('parses and coerces values with defaults', () => {
    const config = loadConfig({ ...base, PORT: '8080', TRUST_PROXY: '1', CORS_ORIGINS: 'https://a.test, https://b.test' });
    expect(config.PORT).toBe(8080);
    expect(config.TRUST_PROXY).toBe(1);
    expect(config.CORS_ORIGINS).toEqual(['https://a.test', 'https://b.test']);
    expect(config.SESSION_NAME).toBe('sid');
    expect(config.COOKIE_SECURE).toBe(false);
  });

  it('parses deployment tuning with safe defaults', () => {
    expect(loadConfig(base)).toMatchObject({ MONGO_MAX_POOL_SIZE: 20, SHUTDOWN_DELAY_MS: 0 });
    expect(loadConfig({ ...base, MONGO_MAX_POOL_SIZE: '10', SHUTDOWN_DELAY_MS: '30000' })).toMatchObject({
      MONGO_MAX_POOL_SIZE: 10,
      SHUTDOWN_DELAY_MS: 30000,
    });
    expect(() => loadConfig({ ...base, MONGO_MAX_POOL_SIZE: '0' })).toThrow(/MONGO_MAX_POOL_SIZE/);
    expect(() => loadConfig({ ...base, SHUTDOWN_DELAY_MS: '-1' })).toThrow(/SHUTDOWN_DELAY_MS/);
  });

  describe('OIDC', () => {
    it('normalizes PUBLIC_BASE_URL and defaults the scopes', () => {
      const config = loadConfig({ ...base, PUBLIC_BASE_URL: 'https://app.example.com/' });
      expect(config.PUBLIC_BASE_URL).toBe('https://app.example.com');
      expect(config.OIDC_SCOPES).toBe('openid profile email');
    });

    it.each(['PUBLIC_BASE_URL', 'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'])('requires %s', (name) => {
      expect(() => loadConfig({ ...base, [name]: '' })).toThrow(new RegExp(name));
    });

    it('rejects non-http(s) URLs', () => {
      expect(() => loadConfig({ ...base, PUBLIC_BASE_URL: 'javascript:alert(1)' })).toThrow(/PUBLIC_BASE_URL/);
    });

    it('requires https in production', () => {
      const prod = { ...base, NODE_ENV: 'production' };
      expect(() => loadConfig({ ...prod, PUBLIC_BASE_URL: 'http://app.example.com' })).toThrow(/PUBLIC_BASE_URL/);
      expect(() => loadConfig({ ...prod, OIDC_ISSUER: 'http://idp.example.com' })).toThrow(/OIDC_ISSUER/);
      expect(loadConfig(prod).PUBLIC_BASE_URL).toBe('https://app.test');
    });
  });

  it('supports multiple session secrets for rotation', () => {
    const config = loadConfig({ ...base, SESSION_SECRETS: `${'a'.repeat(32)},${'b'.repeat(32)}` });
    expect(config.SESSION_SECRETS).toHaveLength(2);
  });

  it('rejects short session secrets', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRETS: 'short' })).toThrow(/SESSION_SECRETS/);
  });

  it('rejects a missing MONGO_URI', () => {
    expect(() => loadConfig({ ...base, MONGO_URI: '' })).toThrow(/MONGO_URI/);
  });

  describe('SPA_APPS', () => {
    const inventory = path.resolve('tests/fixtures/spa/inventory');

    it('parses name:dir pairs, including absolute Windows paths with a drive colon', () => {
      const config = loadConfig({ ...base, SPA_APPS: `inventory:${inventory}, sale:tests/fixtures/spa/sale` });
      expect(config.SPA_APPS).toEqual([
        { name: 'inventory', dir: inventory },
        { name: 'sale', dir: path.resolve('tests/fixtures/spa/sale') },
      ]);
    });

    it('defaults to no apps', () => {
      expect(loadConfig(base).SPA_APPS).toEqual([]);
    });

    it.each([
      ['reserved name', `api:${inventory}`, /reserved/],
      ['duplicate name', `a:${inventory},a:${inventory}`, /duplicate/],
      ['invalid name', `Inventory:${inventory}`, /lowercase/],
      ['missing dir', 'inventory', /name:dir/],
      ['dir without index.html', 'inventory:tests/fixtures', /index\.html/],
    ])('rejects %s', (_label, value, message) => {
      expect(() => loadConfig({ ...base, SPA_APPS: value })).toThrow(message);
    });
  });

  it('defaults to secure cookies in production and refuses to disable them', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).COOKIE_SECURE).toBe(true);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
  });
});
