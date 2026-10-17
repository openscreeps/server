import Database from 'better-sqlite3';
import type { DataSourceOptions } from 'typeorm';
import type { ServerConfig } from './contracts.ts';
import { RoomHistoryFrame } from './entities/room-history-frame.entity.ts';
import { WorldSnapshot } from './entities/world-snapshot.entity.ts';
import { ServerSnapshot1791417600000 } from './migrations/1791417600000-server-snapshot.ts';

/**
 * Hold SQLite's exclusive lock for the connection's lifetime, so a second server on the same file
 * fails at startup instead of overwriting this world. Commits are fully synchronous (durable).
 */
function lockSqlite(database: Database.Database): void {
  try {
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = FULL');
    database.pragma('locking_mode = EXCLUSIVE');
    // Acquire the write lock now, even for an existing database that has nothing to write yet.
    database.transaction(() => undefined).immediate();
  } catch (error) {
    // TypeORM does not close a connection whose preparation failed; never leak the file handle.
    database.close();
    throw error;
  }
}

/** TypeORM options shared by the Nest-managed and the headless (CLI) data source. */
export function dataSourceOptions(config: ServerConfig): DataSourceOptions {
  const shared = {
    entities: [WorldSnapshot, RoomHistoryFrame],
    migrations: [ServerSnapshot1791417600000],
    migrationsTableName: 'server_migrations',
    // StateStore migrates only after it holds the writer lease; never synchronize from entities.
    migrationsRun: false,
    migrationsTransactionMode: 'all' as const,
    synchronize: false,
  };
  if (config.databaseUrl !== undefined) {
    return {
      type: 'postgres',
      url: config.databaseUrl,
      applicationName: 'openscreeps-server',
      connectTimeoutMS: 10000,
      ...shared,
    };
  }
  return {
    type: 'better-sqlite3',
    // Use this package's N-API driver even when an embedder installs TypeORM's older peer.
    driver: Database,
    database: config.database,
    timeout: 1000,
    prepareDatabase: lockSqlite,
    ...shared,
  };
}

/** Operator-facing name of the world database; never includes PostgreSQL credentials. */
export function databaseLabel(config: ServerConfig): string {
  if (config.databaseUrl === undefined) return config.database;
  const url = new URL(config.databaseUrl);
  return `PostgreSQL ${url.host}${url.pathname}`;
}
