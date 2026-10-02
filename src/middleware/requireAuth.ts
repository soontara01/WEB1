import type { RequestHandler } from 'express';

export const requireAuth: RequestHandler = (req, res, next) => {
  if (!req.session?.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
};
