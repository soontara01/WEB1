import { pino } from 'pino';
import { createApp } from './app.js';
import { loadConfig } from './config/env.js';
import { connectMongo } from './db/mongo.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main() {
  const config = loadConfig();
  // Pretty logs only for humans at a terminal; containers and log collectors get JSON.
  // (pino-pretty is a dev dependency and is not installed in the production image.)
  const pretty = !config.isProduction && process.stdout.isTTY;
  const logger = pino({
    level: config.LOG_LEVEL,
    transport: pretty ? { target: 'pino-pretty' } : undefined,
  });

  const { client } = await connectMongo(config);
  const lifecycle = { shuttingDown: false };
  const app = createApp({ config, client, logger, lifecycle });

  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info(`listening on http://${config.HOST}:${config.PORT} (${config.NODE_ENV})`);
  });
  // Keep idle connections open longer than the load balancer's timeout to avoid 502s on reuse.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  const closeServer = () => {
    server.close(async (err) => {
      if (err) logger.error({ err }, 'error closing HTTP server');
      await client.close().catch((e: unknown) => logger.error({ err: e }, 'error closing MongoDB'));
      process.exit(err ? 1 : 0);
    });
    server.closeIdleConnections();
  };

  // SIGTERM (Kubernetes): fail /readyz, keep serving for SHUTDOWN_DELAY_MS while the load balancer
  // drains this pod, then stop accepting connections. SIGINT (Ctrl+C) skips the delay.
  const shutdown = (signal: string, delayMs: number) => {
    if (lifecycle.shuttingDown) return;
    lifecycle.shuttingDown = true;
    logger.info({ signal, delayMs }, 'shutting down');

    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, delayMs + SHUTDOWN_TIMEOUT_MS);
    force.unref();

    setTimeout(closeServer, delayMs);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM', config.SHUTDOWN_DELAY_MS));
  process.on('SIGINT', () => shutdown('SIGINT', 0));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
