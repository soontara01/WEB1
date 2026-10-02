import { Router } from 'express';
import { z } from 'zod';

// Plain decimal notation only: Number() alone would also accept '', '0x10' and 'Infinity'.
const DECIMAL = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

const decimal = z
  .string()
  .trim()
  .regex(DECIMAL)
  .transform(Number)
  .pipe(z.number().finite());

// ?numbers=1,2,3.5 — at most 100 numbers.
const sumQuery = z.object({
  numbers: z
    .string()
    .max(2000)
    .transform((v) => v.split(','))
    .pipe(z.array(decimal).min(1).max(100)),
});

export function mathRouter() {
  const router = Router();

  router.get('/sum', (req, res) => {
    const parsed = sumQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'numbers must be a comma-separated list of 1-100 numbers' });
      return;
    }

    const { numbers } = parsed.data;
    const sum = numbers.reduce((total, n) => total + n, 0);
    if (!Number.isFinite(sum)) {
      res.status(400).json({ error: 'Result is out of range' });
      return;
    }
    res.json({ numbers, sum });
  });

  return router;
}
