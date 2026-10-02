import type { ErrorRequestHandler, RequestHandler } from 'express';

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'Not Found' });
};

interface HttpLikeError {
  status?: number;
  statusCode?: number;
  expose?: boolean;
  message?: string;
}

export function errorHandler({ exposeDetails }: { exposeDetails: boolean }): ErrorRequestHandler {
  return (err: HttpLikeError, req, res, next) => {
    if (res.headersSent) return next(err);

    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');

    // Client errors from body-parser etc. set `expose` when their message is safe to show.
    let message: string;
    if (status < 500) message = err.expose && err.message ? err.message : 'Bad Request';
    else message = exposeDetails && err.message ? err.message : 'Internal Server Error';

    res.status(status).json({ error: message });
  };
}
