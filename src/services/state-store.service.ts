import { Injectable } from '@nestjs/common';
import type { HistoryFrame } from '@openscreeps/game';
import { DataSource, LessThan, type EntityManager, type QueryRunner } from 'typeorm';
import { isRecord } from '../api/guards.ts';
import type { ServerConfig, ServerState } from '../contracts.ts';
import { dataSourceOptions } from '../database.ts';
import { RoomHistoryFrame } from '../entities/room-history-frame.entity.ts';
import { WorldSnapshot } from '../entities/world-snapshot.entity.ts';
import { copyHistory, decodeState, snapshotJson, type RoomHistory } from '../storage.ts';

const SCHEMA_VERSION = 1;
/** History rows per insert: three bound parameters each, within SQLite's minimum limit of 999. */
const HISTORY_BATCH = 300;
/** PostgreSQL advisory-lock class of world ownership; the second key is the world's schema. */
const POSTGRES_LEASE = 0x4f53;

/** The history rows one commit writes: deletions first, then the inserted frames. */
interface HistoryDelta {
  /** Rooms whose rows are all deleted. */
  readonly cleared: string[];
  /** Rooms whose rows before `time` expired. */
  readonly expired: Array<{ readonly room: string; readonly time: number }>;
  /** At most one frame per room and tick, the last one recorded. */
  readonly inserted: Array<{ readonly room: string; readonly frame: HistoryFrame }>;
}

/**
 * Where `frames` start in the room's committed frames when they are those frames with expired
 * ones dropped from the front and new ones appended; `undefined` when the history was replaced.
 */
function retainedFrom(
  committed: readonly HistoryFrame[],
  frames: readonly HistoryFrame[],
): number | undefined {
  const first = frames[0];
  const start = first === undefined ? committed.length : committed.indexOf(first);
  if (start < 0 || frames.length < committed.length - start) return undefined;
  for (let index = start; index < committed.length; index++) {
    if (committed[index] !== frames[index - start]) return undefined;
  }
  return start;
}

/** The rows turning `committed` into `current`, compared by frame identity; `undefined` if none. */
function historyDelta(committed: RoomHistory, current: RoomHistory): HistoryDelta | undefined {
  const cleared: string[] = [];
  const expired: Array<{ room: string; time: number }> = [];
  const inserted = new Map<string, { room: string; frame: HistoryFrame }>();
  const insert = (room: string, frames: readonly HistoryFrame[]): void => {
    // A world clock moved backwards may record a tick twice; the row keeps the later frame.
    for (const frame of frames) inserted.set(`${room}\n${String(frame.time)}`, { room, frame });
  };
  let changed = false;
  for (const room of Object.keys(committed)) {
    if (Object.hasOwn(current, room)) continue;
    cleared.push(room);
    changed = true;
  }
  for (const [room, frames] of Object.entries(current)) {
    const before = (Object.hasOwn(committed, room) ? committed[room] : undefined) ?? [];
    const start = retainedFrom(before, frames);
    if (start === undefined) {
      // Replaced, e.g. by an import: rewrite the room.
      if (before.length) cleared.push(room);
      insert(room, frames);
      changed = true;
      continue;
    }
    const kept = before.length - start;
    if (start === 0 && kept === frames.length) continue;
    changed = true;
    if (start > 0) {
      const first = frames[0];
      if (first === undefined) cleared.push(room);
      else expired.push({ room, time: first.time });
    }
    insert(room, frames.slice(kept));
  }
  return changed ? { cleared, expired, inserted: [...inserted.values()] } : undefined;
}

async function writeHistory(manager: EntityManager, delta: HistoryDelta): Promise<void> {
  for (const room of delta.cleared) await manager.delete(RoomHistoryFrame, { room });
  for (const { room, time } of delta.expired) {
    await manager.delete(RoomHistoryFrame, { room, time: LessThan(time) });
  }
  for (let index = 0; index < delta.inserted.length; index += HISTORY_BATCH) {
    const rows = delta.inserted.slice(index, index + HISTORY_BATCH).map(({ room, frame }) => ({
      room,
      time: frame.time,
      objects: JSON.stringify(frame.objects),
    }));
    await manager
      .createQueryBuilder()
      .insert()
      .into(RoomHistoryFrame)
      .values(rows)
      .orUpdate(['objects'], ['room', 'time'])
      .updateEntity(false)
      .execute();
  }
}

/** The committed history; rows are untrusted like the snapshot and validated as the game does. */
async function loadHistory(manager: EntityManager): Promise<RoomHistory> {
  const rows = await manager.find(RoomHistoryFrame, { order: { room: 'ASC', time: 'ASC' } });
  const history = new Map<string, HistoryFrame[]>();
  for (const row of rows) {
    // A foreign writer may have stored any SQLite value in these columns.
    const room: unknown = row.room;
    const time: unknown = row.time;
    const text: unknown = row.objects;
    const objects: unknown = typeof text === 'string' ? JSON.parse(text) : undefined;
    if (
      typeof room !== 'string' ||
      typeof time !== 'number' ||
      !Number.isSafeInteger(time) ||
      !isRecord(objects) ||
      !Object.values(objects).every(isRecord)
    ) {
      throw new Error('Invalid room history frame');
    }
    let frames = history.get(room);
    if (!frames) history.set(room, (frames = []));
    frames.push({ time, objects });
  }
  return Object.fromEntries(history);
}

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
 * Durable home of the single world: one snapshot row without room history, plus one row per
 * history frame, committed together. Exactly one server owns a world: SQLite keeps an exclusive
 * file lock for the connection's lifetime; PostgreSQL keeps a session advisory lock on a dedicated
 * connection that also performs every commit, so a lost lease fails the next commit. Each update
 * also requires the committed revision to be unchanged, never overwriting another writer's world.
 */
@Injectable()
export class StateStore {
  readonly #dataSource: DataSource;
  readonly #ownsDataSource: boolean;
  readonly #runner: QueryRunner;
  readonly #leased: boolean;
  /** JSON of the committed snapshot row. */
  #serialized: string | undefined;
  /** The committed history frames, shared with the live state and never mutated. */
  #history: RoomHistory;
  #revision: number;
  #closure: Promise<void> | undefined;

  private constructor(
    dataSource: DataSource,
    ownsDataSource: boolean,
    runner: QueryRunner,
    leased: boolean,
    snapshot: WorldSnapshot | null,
    history: RoomHistory,
  ) {
    this.#dataSource = dataSource;
    this.#ownsDataSource = ownsDataSource;
    this.#runner = runner;
    this.#leased = leased;
    this.#serialized = snapshot?.state;
    this.#history = history;
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
      let history: RoomHistory = {};
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
        history = await loadHistory(runner.manager);
      }
      return new StateStore(dataSource, ownsDataSource, runner, leased, snapshot, history);
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

  /** The committed world with its history, decoded afresh; `undefined` before the first commit. */
  load(): ServerState | undefined {
    if (this.#serialized === undefined) return undefined;
    const state = decodeState(this.#serialized);
    state.history = copyHistory(this.#history);
    return state;
  }

  /** Number of commits; 0 before the first commit. */
  get revision(): number {
    return this.#revision;
  }

  /**
   * Atomically and durably replaces the world. An unchanged world is not rewritten; otherwise the
   * snapshot row is rewritten only when it changed, and history frames are inserted and deleted
   * as they were recorded and expired since the last commit.
   */
  async save(state: ServerState): Promise<void> {
    if (this.#closure) throw new Error('Database is closed');
    const serialized = snapshotJson(state);
    const delta = historyDelta(this.#history, state.history);
    if (serialized === this.#serialized && !delta) return;
    const history = copyHistory(state.history);
    const committed = this.#revision;
    const revision = committed + 1;
    await this.#runner.startTransaction();
    try {
      const { manager } = this.#runner;
      const snapshots = manager.getRepository(WorldSnapshot);
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
          serialized === this.#serialized ? { revision } : { revision, state: serialized },
        );
        if (result.affected !== 1) {
          throw new Error('The world was changed by another writer; refusing to overwrite it');
        }
      }
      if (delta) await writeHistory(manager, delta);
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
    this.#history = history;
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
