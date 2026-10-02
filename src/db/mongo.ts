import { MongoClient } from 'mongodb';
import type { Config } from '../config/env.js';

// MongoDB holds only sessions (database MONGO_DB); users come from the OIDC provider.
export const COLLECTIONS = {
  sessions: 'sessionsNewTest',
} as const;

export async function connectMongo(config: Pick<Config, 'MONGO_URI' | 'MONGO_MAX_POOL_SIZE'>) {
  const client = new MongoClient(config.MONGO_URI, {
    serverSelectionTimeoutMS: 5_000,
    maxPoolSize: config.MONGO_MAX_POOL_SIZE,
    appName: 'web1-appserver',
  });
  await client.connect();
  return { client };
}

