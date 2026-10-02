import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestServer } from './helpers.js';

let server: Awaited<ReturnType<typeof setupTestServer>>;

beforeAll(async () => {
  server = await setupTestServer();
});
afterAll(() => server.teardown());

const sum = (numbers: string) => request(server.makeApp()).get('/api/math/sum').query({ numbers });

describe('GET /api/math/sum', () => {
  it('adds the numbers', async () => {
    const res = await sum('1,2,3').expect(200);
    expect(res.body).toEqual({ numbers: [1, 2, 3], sum: 6 });
  });

  it('handles decimals, negatives and whitespace', async () => {
    const res = await sum(' 1.5, -4 ,10').expect(200);
    expect(res.body.sum).toBe(7.5);
  });

  it('accepts a single number', async () => {
    expect((await sum('42').expect(200)).body.sum).toBe(42);
  });

  it.each([
    ['missing parameter', undefined],
    ['empty value', ''],
    ['non-numeric value', '1,abc'],
    ['empty item', '1,,2'],
    ['Infinity', '1,Infinity'],
    ['hex notation', '0x10'],
    ['more than 100 numbers', Array.from({ length: 101 }, () => '1').join(',')],
  ])('rejects %s', async (_label, numbers) => {
    const req = request(server.makeApp()).get('/api/math/sum');
    await (numbers === undefined ? req : req.query({ numbers })).expect(400);
  });

  it('rejects a sum that overflows', async () => {
    await sum('1e308,1e308').expect(400, { error: 'Result is out of range' });
  });

  it('rejects the parameter given as an array', async () => {
    await request(server.makeApp()).get('/api/math/sum?numbers=1&numbers=2').expect(400);
  });
});
