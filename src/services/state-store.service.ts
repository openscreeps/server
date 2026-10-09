import { Injectable } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';
import { isRecord } from '../api/guards.ts';
import type { ServerConfig, ServerState } from '../contracts.ts';
import { dataSourceOptions } from '../database.ts';
import { WorldSnapshot } from '../entities/world-snapshot.entity.ts';
import { decodeState } from '../storage.ts';

const SCHEMA_VERSION = 1;
/** PostgreSQL advisory-lock class of world ownership; the second key is the world's schema. */
const POSTGRES_LEASE = 0x4f53;

async function acquireLease(runner: QueryRunner): Promise<void> {
  const rows: unknown = await runner.query(
    'SELECT pg_try_advisory_lock($1, hashtext(current_schema())) AS "locked"',
    [POSTGRES_LEASE],
  );
  const row: unknown = Array.isArray(rows) ? rows[0] : undefined;
  if (!isRecord(row) || row.locked !== true) {
    throw new Error('Another server owns this PostgreSQL world; refusing to start');
  }
}

/**
 * Ends this store's database session: unlocks a held PostgreSQL lease, returns the dedicated
 * connection, and destroys the data source when asked (always when the store created it).
 * A connection TypeORM already released after an error took its session lock with it.
 * SQLite's exclusive file lock belongs to the data source's connection and ends with it.
 */
async function endSession(
  dataSource: DataSource,
  runner: QueryRunner,
  leased: boolean,
  destroy: boolean,
): Promise<void> {
  try {
    try {
      if (leased && !runner.isReleased) {
        await runner.query('SELECT pg_advisory_unlock($1, hashtext(current_schema()))', [
          POSTGRES_LEASE,
        ]);
      }
    } finally {
      if (!runner.isReleased) await runner.release();
    }
  } finally {
    if (destroy && dataSource.isInitialized) await dataSource.destroy();
  }
}

/**
 * Durable home of the single world snapshot. Exactly one server owns a world: SQLite keeps an
 * exclusive file lock for the connection's lifetime; PostgreSQL keeps a session advisory lock on a
 * dedicated connection that also performs every commit, so a lost lease fails the next commit.
 * Each update also requires the committed revision to be unchanged, never overwriting another
 * writer's world.
 */
@Injectable()
export class StateStore {
  readonly #dataSource: DataSource;
  readonly #ownsDataSource: boolean;
  readonly #runner: QueryRunner;
  readonly #leased: boolean;
  #serialized: string | undefined;
  #revision: number;
  #closure: Promise<void> | undefined;

  private constructor(
    dataSource: DataSource,
    ownsDataSource: boolean,
    runner: QueryRunner,
    leased: boolean,
    snapshot: WorldSnapshot | null,
  ) {
    this.#dataSource = dataSource;
    this.#ownsDataSource = ownsDataSource;
    this.#runner = runner;
    this.#leased = leased;
    this.#serialized = snapshot?.state;
    this.#revision = snapshot?.revision ?? 0;
  }

  /**
   * Opens the world, refusing one owned by another server and malformed or unsupported snapshots.
   * From a configuration the store creates and owns its data source (headless use); from an
   * initialized data source (Nest) the caller keeps ownership, and must destroy it on failure.
   */
  static async open(source: ServerConfig | DataSource): Promise<StateStore> {
    if (source instanceof DataSource) return StateStore.attach(source, false);
    const dataSource = new DataSource(dataSourceOptions(source));
    await dataSource.initialize();
    return StateStore.attach(dataSource, true);
  }

  private static async attach(
    dataSource: DataSource,
    ownsDataSource: boolean,
  ): Promise<StateStore> {
    const runner = dataSource.createQueryRunner();
    let leased = false;
    try {
      await runner.connect();
      if (dataSource.options.type === 'postgres') {
        await acquireLease(runner);
        leased = true;
      }
      // Migrate only as the world's owner, so competing servers never race schema changes.
      await dataSource.runMigrations();
      const snapshot = await runner.manager.findOneBy(WorldSnapshot, { id: 1 });
      if (snapshot) {
        // Rows are untrusted: a foreign writer may have stored any SQLite value in these columns.
        const state: unknown = snapshot.state;
        if (snapshot.schemaVersion !== SCHEMA_VERSION || typeof state !== 'string') {
          throw new Error('Unsupported database schema');
        }
        if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) {
          throw new Error('Invalid world snapshot revision');
        }
        decodeState(state);
      }
      return new StateStore(dataSource, ownsDataSource, runner, leased, snapshot);
    } catch (error) {
      try {
        await endSession(dataSource, runner, leased, ownsDataSource);
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'World store failed to open and to close', {
          cause: cleanup,
        });
      }
      throw error;
    }
  }

  /** The committed world, decoded afresh; `undefined` before the first commit. */
  load(): ServerState | undefined {
    return this.#serialized === undefined ? undefined : decodeState(this.#serialized);
  }

  get serialized(): string | undefined {
    return this.#serialized;
  }

  /** Number of committed snapshots; 0 before the first commit. */
  get revision(): number {
    return this.#revision;
  }

  /** Atomically and durably replaces the world; unchanged snapshots are not rewritten. */
  async save(state: ServerState): Promise<void> {
    if (this.#closure) throw new Error('Database is closed');
    const serialized = JSON.stringify(state);
    if (serialized === this.#serialized) return;
    const committed = this.#revision;
    const revision = committed + 1;
    await this.#runner.startTransaction();
    try {
      const snapshots = this.#runner.manager.getRepository(WorldSnapshot);
      if (committed === 0) {
        await snapshots.insert({
          id: 1,
          schemaVersion: SCHEMA_VERSION,
          revision,
          state: serialized,
        });
      } else {
        const result = await snapshots.update(
          { id: 1, revision: committed },
          { revision, state: serialized },
        );
        if (result.affected !== 1) {
          throw new Error('The world was changed by another writer; refusing to overwrite it');
        }
      }
      await this.#runner.commitTransaction();
    } catch (error) {
      try {
        if (this.#runner.isTransactionActive) await this.#runner.rollbackTransaction();
      } catch (rollback) {
        throw new AggregateError([error, rollback], 'World commit and rollback failed', {
          cause: rollback,
        });
      }
      throw error;
    }
    this.#serialized = serialized;
    this.#revision = revision;
  }

  /** Ends the writer lease; destroys the data source only when this store created it. */
  close(): Promise<void> {
    this.#closure ??= endSession(
      this.#dataSource,
      this.#runner,
      this.#leased,
      this.#ownsDataSource,
    );
    return this.#closure;
  }

  /**
   * Startup failed: end the lease and destroy the data source even when borrowed, because a
   * partially created Nest application is never shut down and would keep the world locked.
   */
  abort(): Promise<void> {
    this.#closure ??= endSession(this.#dataSource, this.#runner, this.#leased, true);
    return this.#closure;
  }
}
