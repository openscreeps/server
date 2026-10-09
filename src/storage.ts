import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ServerState } from './contracts.ts';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function entriesMatch(value: unknown, check: (entry: unknown) => boolean): boolean {
  return record(value) && Object.values(value).every(check);
}

function strings(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string');
}

function modules(value: unknown): boolean {
  return entriesMatch(
    value,
    (entry) => typeof entry === 'string' || (record(entry) && typeof entry.binary === 'string'),
  );
}

/** Validate nested server-owned data before replacing the last durable world. */
function validateCollections(value: Record<string, unknown>): void {
  const checks: Record<string, (entry: unknown) => boolean> = {
    profiles: (entry) =>
      record(entry) &&
      finite(entry.registeredDate) &&
      ['email', 'emailDirty', 'passwordHash'].every(
        (key) => entry[key] === undefined || typeof entry[key] === 'string',
      ) &&
      (entry.steam === undefined || (record(entry.steam) && typeof entry.steam.id === 'string')),
    branches: (entry) =>
      record(entry) &&
      ['_id', 'user', 'branch'].every((key) => typeof entry[key] === 'string') &&
      modules(entry.modules) &&
      typeof entry.activeWorld === 'boolean' &&
      typeof entry.activeSim === 'boolean' &&
      finite(entry.timestamp),
    tokens: (entry) => record(entry) && typeof entry.userId === 'string' && finite(entry.expires),
    messages: (entry) =>
      record(entry) &&
      ['_id', 'user', 'respondent', 'text'].every((key) => typeof entry[key] === 'string') &&
      finite(entry.date) &&
      (entry.type === 'in' || entry.type === 'out') &&
      typeof entry.unread === 'boolean',
    history: (entry) =>
      Array.isArray(entry) &&
      entry.every(
        (frame: unknown) =>
          record(frame) && Number.isSafeInteger(frame.time) && entriesMatch(frame.objects, record),
      ),
    leaderboard: (entry) =>
      entriesMatch(entry, (score) => record(score) && finite(score.world) && finite(score.power)),
    jobs: finite,
    pendingIntents: (entry) => entriesMatch(entry, (targets) => entriesMatch(targets, record)),
    pendingGlobalIntents: (entry) =>
      entriesMatch(entry, (intents) => Array.isArray(intents) && intents.every(record)),
  };
  for (const [name, check] of Object.entries(checks)) {
    if (!entriesMatch(value[name], check)) throw new Error(`Invalid server collection: ${name}`);
  }
  if (
    !Array.isArray(value.statistics) ||
    !value.statistics.every(
      (sample: unknown) =>
        record(sample) &&
        finite(sample.time) &&
        Number.isSafeInteger(sample.tick) &&
        Number.isSafeInteger(sample.ticks) &&
        entriesMatch(sample.rooms, (users) =>
          entriesMatch(users, (stats) => entriesMatch(stats, finite)),
        ) &&
        entriesMatch(
          sample.users,
          (user) =>
            record(user) &&
            ['cpu', 'memory', 'bucket', 'gcl', 'power'].every((key) => finite(user[key])),
        ),
    )
  ) {
    throw new Error('Invalid server statistics');
  }
  if (
    !Array.isArray(value.notificationOutbox) ||
    !value.notificationOutbox.every(
      (entry: unknown) =>
        record(entry) &&
        typeof entry.id === 'string' &&
        typeof entry.userId === 'string' &&
        (entry.email === undefined || typeof entry.email === 'string') &&
        strings(entry.messages) &&
        finite(entry.date),
    )
  ) {
    throw new Error('Invalid notification outbox');
  }
}

function validateRuntime(value: Record<string, unknown>): void {
  if (
    !finite(value.lastCodeTimestamp) ||
    !entriesMatch(
      value.users,
      (user) =>
        record(user) &&
        modules(user.modules) &&
        typeof user.branch === 'string' &&
        finite(user.codeTimestamp) &&
        typeof user.memory === 'string' &&
        entriesMatch(user.segments, (segment) => typeof segment === 'string') &&
        Array.isArray(user.activeSegments) &&
        user.activeSegments.every(Number.isSafeInteger) &&
        Array.isArray(user.consoleCommands) &&
        user.consoleCommands.every(
          (command: unknown) => record(command) && typeof command.expression === 'string',
        ),
    )
  ) {
    throw new Error('Invalid player runtime snapshot');
  }
  const interShard = value.interShard;
  if (
    !record(interShard) ||
    !entriesMatch(interShard.data, (users) =>
      entriesMatch(users, (data) => typeof data === 'string'),
    ) ||
    !entriesMatch(interShard.segments, (segment) => typeof segment === 'string') ||
    !entriesMatch(interShard.defaultLimits, (limits) => entriesMatch(limits, finite)) ||
    !entriesMatch(
      interShard.shardLimits,
      (entry) => record(entry) && finite(entry.cooldownTime) && entriesMatch(entry.limits, finite),
    )
  ) {
    throw new Error('Invalid inter-shard snapshot');
  }
}

/** Only our versioned, durably-written snapshots enter this boundary. Fail closed on corruption. */
export function decodeState(serialized: string): ServerState {
  const value: unknown = JSON.parse(serialized);
  if (!record(value) || value.version !== 1 || !record(value.world) || !record(value.runtime)) {
    throw new Error('Unsupported or invalid server snapshot');
  }
  const world = value.world;
  if (
    !Number.isSafeInteger(world.gameTime) ||
    typeof world.shardName !== 'string' ||
    !Number.isSafeInteger(world.idCounter) ||
    typeof world.rngState !== 'number' ||
    !strings(world.activeRooms) ||
    typeof world.restrictedShard !== 'boolean'
  ) {
    throw new Error('Invalid world snapshot');
  }
  for (const name of [
    'rooms',
    'terrain',
    'roomObjects',
    'flags',
    'users',
    'userPowerCreeps',
    'marketOrders',
    'transactions',
    'usersMoney',
    'usersResources',
    'notifications',
    'marketStats',
    'roomEventLogs',
    'mapViews',
  ]) {
    if (!record(world[name])) throw new Error(`Invalid world collection: ${name}`);
  }
  for (const name of [
    'profiles',
    'branches',
    'tokens',
    'messages',
    'history',
    'jobs',
    'pendingIntents',
    'pendingGlobalIntents',
    'leaderboard',
  ]) {
    if (!record(value[name])) throw new Error(`Invalid server collection: ${name}`);
  }
  if (
    value.runtime.version !== 1 ||
    !record(value.runtime.users) ||
    !record(value.runtime.interShard) ||
    !Array.isArray(value.statistics) ||
    !Array.isArray(value.notificationOutbox) ||
    typeof value.paused !== 'boolean' ||
    typeof value.tickDuration !== 'number' ||
    !Number.isFinite(value.tickDuration) ||
    value.tickDuration < 1
  ) {
    throw new Error('Invalid runtime or scheduler snapshot');
  }
  validateCollections(value);
  validateRuntime(value.runtime);
  if (
    !entriesMatch(
      world.terrain,
      (terrain) => typeof terrain === 'string' && /^[0-3]{2500}$/.test(terrain),
    )
  ) {
    throw new Error('Invalid world terrain');
  }
  for (const name of [
    'rooms',
    'roomObjects',
    'flags',
    'users',
    'userPowerCreeps',
    'marketOrders',
    'transactions',
    'usersMoney',
    'usersResources',
    'notifications',
    'marketStats',
    'mapViews',
  ]) {
    if (!entriesMatch(world[name], record)) throw new Error(`Invalid world collection: ${name}`);
  }
  if (
    !entriesMatch(world.roomEventLogs, (events) => Array.isArray(events) && events.every(record))
  ) {
    throw new Error('Invalid room event logs');
  }
  return value as unknown as ServerState;
}

/** One writer owns a world. SQLite's exclusive connection lock rejects a second server process. */
export class StateStore implements Disposable {
  readonly #database: DatabaseSync;
  #serialized: string | undefined;
  #closed = false;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.#database = new DatabaseSync(path);
    try {
      this.#database.exec(`
        PRAGMA busy_timeout = 1000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA locking_mode = EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS server_snapshot (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          schema_version INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          state TEXT NOT NULL
        );
      `);
      // Acquire the exclusive write lock even when a populated database already exists.
      this.#database.exec('BEGIN IMMEDIATE; COMMIT;');
      const row = this.#database
        .prepare('SELECT schema_version, state FROM server_snapshot WHERE id = 1')
        .get();
      if (row) {
        if (row.schema_version !== 1 || typeof row.state !== 'string') {
          throw new Error('Unsupported database schema');
        }
        decodeState(row.state);
        this.#serialized = row.state;
      }
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  load(): ServerState | undefined {
    return this.#serialized === undefined ? undefined : decodeState(this.#serialized);
  }

  get serialized(): string | undefined {
    return this.#serialized;
  }

  save(state: ServerState): void {
    if (this.#closed) throw new Error('Database is closed');
    const serialized = JSON.stringify(state);
    if (serialized === this.#serialized) return;
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database
        .prepare(
          `INSERT INTO server_snapshot(id, schema_version, revision, state)
        VALUES (1, 1, 1, ?) ON CONFLICT(id) DO UPDATE SET
        revision = revision + 1, state = excluded.state`,
        )
        .run(serialized);
      this.#database.exec('COMMIT');
      this.#serialized = serialized;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
