/*
 * Original `@screeps/common` storage (`common.storage`: `db`, `env`, `pubsub`, `queue`) for trusted
 * original mods and CLI scripts, served from the live canonical world instead of a separate LokiJS
 * storage process.
 *
 * Collections keep their original names, document shapes and query semantics: queries run on the
 * pinned LokiJS 1.5.6 engine over original-format projections of the canonical records (including
 * the order its binary indices return), updates apply the storage's lodash 3 operators, and
 * arguments and results cross a JSON boundary exactly like the storage RPC (failures reject with
 * the error message string, results are copies). Documents map onto canonical records — account
 * profiles, code branches, player runtime memory, scheduler metadata — and collections or env keys
 * without a canonical home persist in `ServerState.originalStorage`.
 *
 * Every operation is one kernel read or mutation (joining an active one). Writes are staged and
 * validated before anything changes, so a rejected operation leaves no partial write; the original
 * storage could stop half-way through a bulk or multi-document update.
 *
 * Derived from screeps/storage (`lib/db.js`, `lib/queue.js`, `lib/pubsub.js`) and screeps/common
 * (`lib/storage.js`), Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>, used under the ISC
 * license (see THIRD_PARTY_NOTICES.md).
 */

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import {
  isRecord,
  recordRoomObjectWrites,
  type CodeModules,
  type JsonObject,
  type JsonValue,
} from '@openscreeps/game';
import type { ServerContext, ServerState, TickEvent, UserProfile } from '../contracts.ts';
import { htmlEncode } from '../realtime/encode.ts';

/** Original storage records without a canonical home (`ServerState.originalStorage`). */
export interface OriginalStorageData {
  /** Collections by original name; documents in storage (insertion) order, unique `_id`s. */
  collections: Record<string, JsonObject[]>;
  /** Env keys (original env document `data`). */
  env: Record<string, JsonValue>;
  /** Wall-clock expiry in milliseconds of `env` keys (original env expiration document). */
  expirations: Record<string, number>;
}

/** A q promise, as every original storage call returns. Rejection reasons are message strings. */
export interface OriginalPromise<T> extends PromiseLike<T> {
  then<A = T, B = never>(
    onFulfilled?: ((value: T) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): OriginalPromise<A | B>;
  catch<B = never>(onRejected: (reason: unknown) => B | PromiseLike<B>): OriginalPromise<T | B>;
  fail<B = never>(onRejected: (reason: unknown) => B | PromiseLike<B>): OriginalPromise<T | B>;
  finally(callback: () => unknown): OriginalPromise<T>;
  fin(callback: () => unknown): OriginalPromise<T>;
  done(onFulfilled?: (value: T) => unknown, onRejected?: (reason: unknown) => unknown): void;
}

export type OriginalDocument = Record<string, unknown>;

export interface OriginalUpdateResult {
  modified?: number;
  inserted?: number;
}

/**
 * One original collection. Queries, update documents (`$set`, `$merge`, `$inc`, `$unset`,
 * `$addToSet`, `$pull`), bulk operations (`{op: 'update', id, update}`, `{op: 'insert', data}`,
 * `{op: 'remove', id}`) and `findEx` options (`{sort, offset, limit}`) are untrusted JSON values.
 */
export interface OriginalCollection {
  find(query?: unknown): OriginalPromise<OriginalDocument[]>;
  findOne(query?: unknown): OriginalPromise<OriginalDocument | null>;
  by(field: unknown, value?: unknown): OriginalPromise<OriginalDocument | undefined>;
  count(query?: unknown): OriginalPromise<number>;
  clear(): OriginalPromise<undefined>;
  ensureIndex(field: unknown): OriginalPromise<undefined>;
  removeWhere(query?: unknown): OriginalPromise<undefined>;
  insert(documents: unknown): OriginalPromise<OriginalDocument | OriginalDocument[]>;
  update(query: unknown, update: unknown, params?: unknown): OriginalPromise<OriginalUpdateResult>;
  bulk(operations: unknown): OriginalPromise<undefined>;
  findEx(query: unknown, options: unknown): OriginalPromise<OriginalDocument[]>;
}

export interface OriginalEnv {
  keys: Record<string, string>;
  get(name: unknown): OriginalPromise<unknown>;
  mget(names: unknown): OriginalPromise<unknown[]>;
  set(name: unknown, value: unknown): OriginalPromise<unknown>;
  setex(name: unknown, seconds: unknown, value: unknown): OriginalPromise<undefined>;
  expire(name: unknown, seconds: unknown): OriginalPromise<undefined>;
  ttl(name: unknown): OriginalPromise<number>;
  del(name: unknown): OriginalPromise<number>;
  hmget(name: unknown, fields: unknown): OriginalPromise<unknown[]>;
  hmset(name: unknown, data: unknown): OriginalPromise<unknown>;
  hget(name: unknown, field: unknown): OriginalPromise<unknown>;
  hset(name: unknown, field: unknown, value: unknown): OriginalPromise<unknown>;
  sadd(name: unknown, data: unknown): OriginalPromise<unknown>;
  smembers(name: unknown): OriginalPromise<unknown>;
}

/** Called with `this.channel` set to the message channel (useful for `'*'` subscriptions). */
export type OriginalPubsubListener = (this: { channel: string }, data: unknown) => void;

export interface OriginalPubsub {
  keys: Record<string, string>;
  publish(channel: unknown, data: unknown): OriginalPromise<undefined>;
  /** Subscribes to one channel or `'*'`; returns a function that removes the subscription. */
  subscribe(channel: string, listener: OriginalPubsubListener): () => void;
}

/** The storage process work queues (`usersLegacy`, `usersIvm`, `rooms`), held in memory. */
export interface OriginalQueue {
  fetch(name: unknown): OriginalPromise<unknown>;
  add(name: unknown, id: unknown): OriginalPromise<true>;
  addMulti(name: unknown, ids: unknown): OriginalPromise<true>;
  markDone(name: unknown, id: unknown): OriginalPromise<true>;
  whenAllDone(name: unknown): OriginalPromise<true>;
  reset(name: unknown): OriginalPromise<true>;
}

export interface OriginalStorage {
  db: Record<string, OriginalCollection>;
  env: OriginalEnv;
  pubsub: OriginalPubsub;
  queue: OriginalQueue;
  resetAllData(): OriginalPromise<undefined>;
  /** Wraps every name in the collection list (names pushed by mods after creation included). */
  _connect(): OriginalPromise<undefined>;
  _connected: boolean;
}

export interface OriginalStorageOptions {
  /**
   * Collection names `db` wraps: the live original `config.common.dbCollections` array; mods may
   * push names before `_connect()`. Default: a copy of `ORIGINAL_DB_COLLECTIONS`.
   */
  collections?: string[];
  /** Implements `resetAllData()`; without it the call rejects. */
  resetAllData?: () => Promise<void>;
}

/** Original `config.common.dbCollections`. */
export const ORIGINAL_DB_COLLECTIONS: readonly string[] = [
  'leaderboard.power',
  'leaderboard.seasons',
  'leaderboard.world',
  'users.intents',
  'market.orders',
  'market.stats',
  'rooms',
  'rooms.objects',
  'rooms.flags',
  'rooms.intents',
  'rooms.terrain',
  'transactions',
  'users',
  'users.code',
  'users.console',
  'users.messages',
  'users.money',
  'users.notifications',
  'users.resources',
  'users.power_creeps',
];

/** Original collections stored in canonical records; every other name is kept as-is. */
const CANONICAL_COLLECTIONS: Readonly<Record<string, true>> = Object.fromEntries(
  ORIGINAL_DB_COLLECTIONS.filter((name) => name !== 'leaderboard.seasons').map((name) => [
    name,
    true,
  ]),
);

const ENV_KEYS = {
  ACCESSIBLE_ROOMS: 'accessibleRooms',
  ROOM_STATUS_DATA: 'roomStatusData',
  MEMORY: 'memory:',
  GAMETIME: 'gameTime',
  MAP_VIEW: 'mapView:',
  TERRAIN_DATA: 'terrainData',
  SCRIPT_CACHED_DATA: 'scriptCachedData:',
  USER_ONLINE: 'userOnline:',
  MAIN_LOOP_PAUSED: 'mainLoopPaused',
  ROOM_HISTORY: 'roomHistory:',
  ROOM_VISUAL: 'roomVisual:',
  MEMORY_SEGMENTS: 'memorySegments:',
  PUBLIC_MEMORY_SEGMENTS: 'publicMemorySegments:',
  ROOM_EVENT_LOG: 'roomEventLog:',
  ACTIVE_ROOMS: 'activeRooms',
  MAIN_LOOP_MIN_DURATION: 'tickRate',
} as const;

const PUBSUB_KEYS = {
  QUEUE_DONE: 'queueDone:',
  RUNTIME_RESTART: 'runtimeRestart',
  TICK_STARTED: 'tickStarted',
  ROOMS_DONE: 'roomsDone',
} as const;

/** Env keys whose value is canonical world data or derived from it. */
const CANONICAL_ENV_KEYS: Readonly<Record<string, true>> = {
  [ENV_KEYS.ACCESSIBLE_ROOMS]: true,
  [ENV_KEYS.ROOM_STATUS_DATA]: true,
  [ENV_KEYS.GAMETIME]: true,
  [ENV_KEYS.TERRAIN_DATA]: true,
  [ENV_KEYS.MAIN_LOOP_PAUSED]: true,
  [ENV_KEYS.ROOM_EVENT_LOG]: true,
  [ENV_KEYS.ACTIVE_ROOMS]: true,
  [ENV_KEYS.MAIN_LOOP_MIN_DURATION]: true,
};
const CANONICAL_ENV_PREFIXES = [
  ENV_KEYS.MEMORY,
  ENV_KEYS.MEMORY_SEGMENTS,
  ENV_KEYS.PUBLIC_MEMORY_SEGMENTS,
  ENV_KEYS.MAP_VIEW,
  ENV_KEYS.ROOM_HISTORY,
  ENV_KEYS.ROOM_VISUAL,
] as const;

/** Channels whose original payloads are JSON text (backend socket listeners `JSON.parse` them). */
const JSON_CHANNEL = /^user:[^/]+\/(?:code|console|cpu|set-active-branch|message:.*|newMessage)$/;
/** Server-internal kernel channels that never existed on the original pubsub. */
const INTERNAL_CHANNEL = /^(?:auth|server):/;
/** Driver `config.engine.mainLoopResetInterval`: room visuals expire after this many ms. */
const VISUAL_TTL = 5000;
/** Built-in NPC players whose console and CPU the driver never publishes. */
const BUILTIN_USERS: Readonly<Record<string, true>> = { '2': true, '3': true };
const CPU_LIMIT_ERROR = /CPU limit reached/;
const WALLED_TERRAIN = '1'.repeat(2500);
const ROOM_NAME = /(W|E)(\d+)(N|S)(\d+)/;
const SEASON = /^\d{4}-\d{2}$/;

// ---------------------------------------------------------------------------------------------
// Pinned original dependencies: LokiJS 1.5.6 queries, lodash 3 update operators, q promises.

type Doc = Record<string, unknown>;

interface LokiResultset {
  find(query: unknown, firstOnly?: boolean): LokiResultset;
  simplesort(field: string, desc: boolean): LokiResultset;
  offset(position: unknown): LokiResultset;
  limit(count: unknown): LokiResultset;
  data(): Doc[];
}
interface LokiCollection {
  data: Doc[];
  binaryIndices: Record<string, { name: string; dirty: boolean; values: number[] }>;
  insert(documents: Doc[]): unknown;
  find(query: unknown): Doc[];
  findOne(query: unknown): Doc | null;
  count(query: unknown): number;
  chain(): LokiResultset;
}
interface LokiModule {
  Collection: new (name: string, options: Record<string, unknown>) => LokiCollection;
  Comparators: {
    lt(a: unknown, b: unknown, equal: boolean): boolean;
    gt(a: unknown, b: unknown, equal: boolean): boolean;
  };
}
interface QModule {
  <T>(value: T | PromiseLike<T>): OriginalPromise<T>;
  reject<T = never>(reason: unknown): OriginalPromise<T>;
}
interface LodashModule {
  extend(target: object, ...sources: unknown[]): object;
  merge(target: object, ...sources: unknown[]): object;
  forEach(collection: unknown, iteratee: (value: unknown, key: string | number) => void): unknown;
  includes(collection: unknown, value: unknown): boolean;
  isEqual(a: unknown, b: unknown): boolean;
  isObject(value: unknown): value is object;
}

const load = createRequire(import.meta.url);
const Loki = load('lokijs') as LokiModule;
const Q = load('q') as QModule;
const lodash = load('lodash') as LodashModule;

// ---------------------------------------------------------------------------------------------
// JSON transport and helpers

/** A copy across the storage RPC's JSON boundary: `undefined` array items become `null`. */
function copy<T>(value: T): T {
  if (value === undefined) return value;
  const text = JSON.stringify(value) as string | undefined;
  return text === undefined ? (undefined as T) : (JSON.parse(text) as T);
}

/** Inputs never carry `__proto__` keys: lodash 3 `merge` would follow them into prototypes. */
function assertSafeKeys(value: unknown): void {
  const pending = [value];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next !== 'object' || next === null) continue;
    for (const [key, child] of Object.entries(next)) {
      if (key === '__proto__') throw new Error('Keys named __proto__ are not supported');
      pending.push(child);
    }
  }
}

function inputs(args: unknown[]): unknown[] {
  const copied = copy(args);
  assertSafeKeys(copied);
  return copied;
}

/** Runs an operation and reports it like the storage RPC: JSON copies, message string failures. */
function respond<T>(operation: () => T | Promise<T>): OriginalPromise<T> {
  const pending = new Promise<T>((resolve) => {
    resolve(operation());
  });
  return Q(pending).then(
    (result) => copy(result),
    (error: unknown) => Q.reject<T>(error instanceof Error ? error.message : String(error)),
  );
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Defines an own data property, even for keys such as `__proto__` that assignment would not. */
function setField(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Replaces a stored record's fields in place, keeping its identity and key position. */
function replaceDocument(target: Doc, source: Doc): void {
  for (const key of Object.keys(target)) {
    if (!Object.hasOwn(source, key)) Reflect.deleteProperty(target, key);
  }
  for (const [key, value] of Object.entries(source)) setField(target, key, value);
}

function safeKey(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '' || value === '__proto__') {
    throw new Error(`${what} must be a non-empty string`);
  }
  return value;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function epochDate(value: unknown, what: string): number {
  const time = typeof value === 'string' ? Date.parse(value) : value;
  if (!finite(time)) throw new Error(`${what} must be a date`);
  return time;
}

function parseJson(value: unknown, what: string): unknown {
  if (typeof value !== 'string') throw new Error(`${what} must be JSON text`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${what} must be JSON text`);
  }
}

function integer(value: unknown, what: string): number {
  const number = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) {
    throw new Error(`${what} must be an integer`);
  }
  return number;
}

function getIn(document: unknown, path: readonly string[]): unknown {
  let value = document;
  for (const key of path) {
    if (value === null || value === undefined) return undefined;
    value = (value as Doc)[key];
  }
  return value;
}

function listMethod(
  list: unknown,
  method: 'indexOf' | 'push' | 'splice',
): (...args: unknown[]) => unknown {
  const target = list as Record<string, unknown> | null;
  const fn = target === null ? undefined : target[method];
  if (typeof fn !== 'function') throw new TypeError(`doc[i].${method} is not a function`);
  return (...args: unknown[]) => (fn as (...values: unknown[]) => unknown).apply(list, args);
}

/** Storage `updateDocument`. */
function updateDocument(doc: Doc, update: unknown): void {
  if (update === null || update === undefined) {
    throw new TypeError(`Cannot read properties of ${String(update)} (reading '$set')`);
  }
  const operators = Object(update) as Doc;
  if (operators.$set) lodash.extend(doc, operators.$set);
  if (operators.$merge) lodash.merge(doc, operators.$merge);
  if (operators.$inc) {
    lodash.forEach(operators.$inc, (value, key) => {
      const field = String(key);
      // JavaScript `+` on stored values exactly like the original: numbers add, strings concatenate.
      setField(doc, field, ((doc[field] || 0) as string) + (value as string));
    });
  }
  if (operators.$unset) {
    for (const key in Object(operators.$unset)) Reflect.deleteProperty(doc, key);
  }
  if (operators.$addToSet) {
    const values = Object(operators.$addToSet) as Doc;
    for (const key in values) {
      if (!doc[key]) setField(doc, key, []);
      if (listMethod(doc[key], 'indexOf')(values[key]) === -1)
        listMethod(doc[key], 'push')(values[key]);
    }
  }
  if (operators.$pull) {
    const values = Object(operators.$pull) as Doc;
    for (const key in values) {
      if (!doc[key]) continue;
      const index = listMethod(doc[key], 'indexOf')(values[key]);
      if (index !== -1) listMethod(doc[key], 'splice')(index, 1);
    }
  }
}

/** Storage `recursReplaceNeNull`: `{$ne: null}` also excludes `undefined`, `{$eq: null}` includes it. */
function replaceNeNull(value: unknown): void {
  if (!lodash.isObject(value)) return;
  const target = value as Doc;
  for (const key in target) {
    if (lodash.isEqual(target[key], { $ne: null }) && !target.$and) {
      target.$and = [{ [key]: { $ne: null } }, { [key]: { $ne: undefined } }];
      Reflect.deleteProperty(target, key);
    }
    if (lodash.isEqual(target[key], { $eq: null }) && !target.$or) {
      target.$or = [{ [key]: { $eq: null } }, { [key]: { $eq: undefined } }];
      Reflect.deleteProperty(target, key);
    }
    replaceNeNull(target[key]);
  }
}

/**
 * Binary index order of the pinned storage: values ascending by LokiJS comparators, and among equal
 * values the most recently inserted or updated document first (adaptive index maintenance).
 */
function indexOrder(data: readonly Doc[], field: string, recency: readonly number[]): number[] {
  const path = field.split('.');
  const values = data.map((doc) => (path.length > 1 ? getIn(doc, path) : doc[field]));
  return data
    .map((_, position) => position)
    .sort((a, b) => {
      const left = values[a];
      const right = values[b];
      if (left !== right) {
        if (Loki.Comparators.lt(left, right, false)) return -1;
        if (Loki.Comparators.gt(left, right, false)) return 1;
      }
      return (recency[b] ?? 0) - (recency[a] ?? 0);
    });
}

function withoutLokiId(doc: Doc): Doc {
  Reflect.deleteProperty(doc, '$loki');
  return doc;
}

// ---------------------------------------------------------------------------------------------
// Collections

interface Change {
  key: string;
  /** Absent: removed. */
  doc: Doc | undefined;
  /** Removed earlier in the operation, then written again (re-inserted at the end). */
  recreated: boolean;
}

interface CollectionAdapter {
  /** Original binary indices of the collection (storage `getOrAddCollection`). */
  readonly indices: readonly string[];
  /** Fresh original-format documents in storage order. */
  documents(): Doc[];
  /** Write recency of `documents()` (larger is more recent); default the storage position. */
  recency?(docs: readonly Doc[]): number[];
  /** Fresh copy of the document whose `_id` is `key`. */
  get(key: string): Doc | undefined;
  /** `_id` an inserted document without one receives; default a new world id. */
  derivedId?(doc: Doc): string | undefined;
  /** Combines an insert with an existing document of its `_id` instead of rejecting it. */
  mergeInsert?(existing: Doc, inserted: Doc): Doc;
  /** Validates every change, then applies them; throws before changing any state. */
  commit(changes: readonly Change[]): void;
}

/** Ids for inserted documents, consumed from the world counter only when the operation commits. */
class IdAllocator {
  #reserved = 0;
  constructor(private readonly state: ServerState) {}
  next(): string {
    this.#reserved++;
    return (this.state.world.idCounter + this.#reserved).toString(16).padStart(24, '0');
  }
  commit(): void {
    this.state.world.idCounter += this.#reserved;
    this.#reserved = 0;
  }
}

/** The writes of one operation over its collection, applied together by `commit()`. */
class Stage {
  readonly #changes = new Map<string, Change>();
  constructor(
    private readonly adapter: CollectionAdapter,
    private readonly ids: IdAllocator,
  ) {}

  get(key: string): Doc | undefined {
    const change = this.#changes.get(key);
    return change ? change.doc : this.adapter.get(key);
  }

  put(key: string, doc: Doc): void {
    const previous = this.#changes.get(key);
    const recreated = previous !== undefined && (previous.doc === undefined || previous.recreated);
    this.#changes.delete(key);
    this.#changes.set(key, { key, doc, recreated });
  }

  remove(key: string): void {
    this.#changes.delete(key);
    this.#changes.set(key, { key, doc: undefined, recreated: false });
  }

  /** Storage `genId` and LokiJS insert with the unique `_id` index. */
  insert(value: unknown): Doc {
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Document needs to be an object');
    }
    if (value === null) throw new TypeError('Object cannot be null');
    const doc = value as Doc;
    if (!doc._id) doc._id = this.adapter.derivedId?.(doc) ?? this.ids.next();
    const key = String(doc._id);
    const existing = this.get(key);
    if (existing) {
      if (!this.adapter.mergeInsert) throw new Error(`Duplicate key for property _id: ${key}`);
      this.put(key, this.adapter.mergeInsert(existing, doc));
    } else {
      this.put(key, doc);
    }
    return doc;
  }

  /** Writes `doc` loaded as `key`, following an `_id` the update changed. */
  write(key: string, doc: Doc): void {
    const next = String(doc._id);
    if (next !== key) {
      this.remove(key);
      if (this.get(next)) throw new Error(`Duplicate key for property _id: ${next}`);
    }
    this.put(next, doc);
  }

  commit(): void {
    if (this.#changes.size) this.adapter.commit([...this.#changes.values()]);
    this.ids.commit();
  }
}

interface KeyedOptions {
  name: string;
  record: Record<string, Doc>;
  indices: readonly string[];
  dates?: readonly string[];
  validate?: (doc: Doc) => void;
  recency?: (docs: readonly Doc[]) => number[];
  afterCommit?: (written: string[]) => void;
}

/** A canonical record keyed by `_id` whose documents already have the original shape. */
function keyedAdapter(options: KeyedOptions): CollectionAdapter {
  const { name, record, dates = [] } = options;
  // Original `Date` fields cross the RPC as ISO strings; canonical records keep epoch milliseconds.
  const project = (doc: Doc): Doc => {
    const result = copy(doc);
    for (const field of dates) {
      const value = result[field];
      if (finite(value)) result[field] = new Date(value).toISOString();
    }
    return result;
  };
  const adapter: CollectionAdapter = {
    indices: options.indices,
    documents: () => Object.values(record).map(project),
    get: (key) => {
      const doc = own(record, key);
      return doc && project(doc);
    },
    commit(changes) {
      const writes = changes.map((change) => {
        if (!change.doc) return change;
        const doc = { ...change.doc };
        safeKey(doc._id, `${name} _id`);
        for (const field of dates) {
          if (doc[field] !== undefined) doc[field] = epochDate(doc[field], `${name}.${field}`);
        }
        options.validate?.(doc);
        return { ...change, doc };
      });
      const written: string[] = [];
      for (const { key, doc, recreated } of writes) {
        if (!doc || recreated) Reflect.deleteProperty(record, key);
        if (!doc) continue;
        const current = own(record, key);
        if (current) replaceDocument(current, doc);
        else record[key] = doc;
        written.push(key);
      }
      options.afterCommit?.(written);
    },
  };
  if (options.recency) adapter.recency = options.recency;
  return adapter;
}

function requireFields(
  doc: Doc,
  collection: string,
  fields: Record<string, 'string' | 'number'>,
): void {
  for (const [field, type] of Object.entries(fields)) {
    const value = doc[field];
    if (type === 'string' ? typeof value !== 'string' : !finite(value)) {
      throw new Error(`${collection}.${field} must be a ${type}`);
    }
  }
}

function roomsAdapter(state: ServerState): CollectionAdapter {
  const { world, jobs } = state;
  const scheduled = { nextForceUpdateTime: 'forceUpdate:', nextNpcMarketOrder: 'npcOrders:' };
  const project = (room: Doc): Doc => {
    const doc = copy(room);
    const id = String(room._id);
    for (const [field, prefix] of Object.entries(scheduled)) {
      const time = own(jobs, prefix + id);
      if (time !== undefined) doc[field] = time;
    }
    return doc;
  };
  const record = world.rooms as unknown as Record<string, Doc>;
  return {
    indices: [],
    documents: () => Object.values(record).map(project),
    get: (key) => {
      const room = own(record, key);
      return room && project(room);
    },
    commit(changes) {
      const writes = changes.map((change) => {
        if (!change.doc) return { change, room: undefined, times: {} };
        const room = { ...change.doc };
        safeKey(room._id, 'rooms _id');
        const times: Record<string, number | undefined> = {};
        for (const [field, prefix] of Object.entries(scheduled)) {
          const time = room[field];
          if (time !== undefined && !finite(time))
            throw new Error(`rooms.${field} must be a number`);
          times[prefix] = time;
          Reflect.deleteProperty(room, field);
        }
        return { change, room, times };
      });
      for (const { change, room, times } of writes) {
        const existing = own(record, change.key);
        if (!room || change.recreated) {
          Reflect.deleteProperty(record, change.key);
          for (const prefix of Object.values(scheduled)) {
            Reflect.deleteProperty(jobs, prefix + change.key);
          }
          if (!room) continue;
        }
        const current = change.recreated ? undefined : existing;
        if (current) replaceDocument(current, room);
        else record[change.key] = room;
        for (const [prefix, time] of Object.entries(times)) {
          if (time === undefined) Reflect.deleteProperty(jobs, prefix + change.key);
          else jobs[prefix + change.key] = time;
        }
      }
    },
  };
}

function terrainAdapter(context: ServerContext): CollectionAdapter {
  const { terrain } = context.state.world;
  const project = (room: string, data: string): Doc => ({
    room,
    terrain: data,
    type: 'terrain',
    _id: room,
  });
  return {
    indices: ['room'],
    documents: () => Object.entries(terrain).map(([room, data]) => project(room, data)),
    get: (key) => {
      const data = own(terrain, key);
      return data === undefined ? undefined : project(key, data);
    },
    derivedId: (doc) => (typeof doc.room === 'string' ? doc.room : undefined),
    commit(changes) {
      for (const { key, doc } of changes) {
        if (!doc) continue;
        for (const field of Object.keys(doc)) {
          if (!['_id', 'room', 'terrain', 'type'].includes(field)) {
            throw new Error(`rooms.terrain.${field} is not supported`);
          }
        }
        if (doc.room !== key || doc._id !== key) {
          throw new Error(
            'rooms.terrain documents are identified by their room: _id must equal room',
          );
        }
        safeKey(doc.room, 'rooms.terrain.room');
        if (typeof doc.terrain !== 'string' || !/^[0-3]{2500}$/.test(doc.terrain)) {
          throw new Error('rooms.terrain.terrain must be 2500 terrain digits');
        }
        if (doc.type !== undefined && doc.type !== 'terrain') {
          throw new Error("rooms.terrain.type must be 'terrain'");
        }
      }
      for (const { key, doc } of changes) {
        if (doc) terrain[key] = doc.terrain as string;
        else Reflect.deleteProperty(terrain, key);
      }
      context.terrainChanged();
    },
  };
}

function roomIntentsAdapter(state: ServerState): CollectionAdapter {
  const project = (room: string, users: Readonly<Record<string, unknown>>): Doc => ({
    _id: room,
    room,
    users: Object.fromEntries(
      Object.entries(users).map(([user, objects]) => [user, { objectsManual: copy(objects) }]),
    ),
  });
  return {
    indices: ['room'],
    documents: () =>
      Object.entries(state.pendingIntents).map(([room, users]) => project(room, users)),
    get: (key) => {
      const users = own(state.pendingIntents, key);
      return users && project(key, users);
    },
    derivedId: (doc) => (typeof doc.room === 'string' ? doc.room : undefined),
    commit(changes) {
      const writes = changes.map(({ key, doc }) => {
        if (!doc) return { key, users: undefined };
        for (const field of Object.keys(doc)) {
          if (!['_id', 'room', 'users'].includes(field)) {
            throw new Error(`rooms.intents.${field} is not supported`);
          }
        }
        if (doc.room !== key || doc._id !== key) {
          throw new Error(
            'rooms.intents documents are identified by their room: _id must equal room',
          );
        }
        safeKey(doc.room, 'rooms.intents.room');
        const users: Record<string, Record<string, Doc>> = {};
        if (doc.users !== undefined) {
          if (!isRecord(doc.users)) throw new Error('rooms.intents.users must be an object');
          for (const [user, entry] of Object.entries(doc.users)) {
            if (!isRecord(entry)) throw new Error('rooms.intents.users entries must be objects');
            for (const field of Object.keys(entry)) {
              if (field === 'objects') {
                throw new Error(
                  'rooms.intents users.<id>.objects holds script intents of a running tick; write manual intents to objectsManual',
                );
              }
              if (field !== 'objectsManual') {
                throw new Error(`rooms.intents users.<id>.${field} is not supported`);
              }
            }
            const objects = entry.objectsManual;
            if (objects === undefined) continue;
            if (!isRecord(objects) || !Object.values(objects).every(isRecord)) {
              throw new Error('rooms.intents objectsManual must map object ids to intent objects');
            }
            users[user] = objects as Record<string, Doc>;
          }
        }
        return { key, users: Object.keys(users).length ? users : undefined };
      });
      const intents = { ...state.pendingIntents };
      for (const { key, users } of writes) {
        if (users) intents[key] = users;
        else Reflect.deleteProperty(intents, key);
      }
      state.pendingIntents = intents;
    },
  };
}

type GlobalIntents = Record<string, unknown[]>;

function userIntentsAdapter(state: ServerState): CollectionAdapter {
  const intents = state.pendingGlobalIntents as unknown as Record<string, GlobalIntents>;
  const project = (user: string, entry: GlobalIntents): Doc => ({
    _id: user,
    user,
    intents: copy(entry),
  });
  return {
    indices: [],
    documents: () => Object.entries(intents).map(([user, entry]) => project(user, entry)),
    get: (key) => {
      const entry = own(intents, key);
      return entry && project(key, entry);
    },
    derivedId: (doc) => (typeof doc.user === 'string' ? doc.user : undefined),
    // The runner reads every pending document of a player: further inserts append to its lists.
    mergeInsert(existing, inserted) {
      const merged: Record<string, unknown> = { ...(existing.intents as GlobalIntents) };
      if (isRecord(inserted.intents)) {
        for (const [name, list] of Object.entries(inserted.intents)) {
          const previous = merged[name];
          merged[name] =
            Array.isArray(previous) && Array.isArray(list)
              ? [...(previous as unknown[]), ...(list as unknown[])]
              : list;
        }
      }
      return { ...existing, intents: merged };
    },
    commit(changes) {
      const writes = changes.map(({ key, doc }) => {
        if (!doc) return { key, entry: undefined };
        for (const field of Object.keys(doc)) {
          if (!['_id', 'user', 'intents'].includes(field)) {
            throw new Error(`users.intents.${field} is not supported`);
          }
        }
        if (doc.user !== key || doc._id !== key) {
          throw new Error(
            'users.intents documents are identified by their user: _id must equal user',
          );
        }
        safeKey(doc.user, 'users.intents.user');
        const entry = doc.intents ?? {};
        if (
          !isRecord(entry) ||
          !Object.values(entry).every(
            (list) => Array.isArray(list) && list.every((intent) => isRecord(intent)),
          )
        ) {
          throw new Error('users.intents.intents must map intent names to lists of objects');
        }
        return { key, entry: entry as GlobalIntents };
      });
      for (const { key, entry } of writes) {
        if (entry && Object.keys(entry).length) intents[key] = entry;
        else Reflect.deleteProperty(intents, key);
      }
    },
  };
}

const PROFILE_FIELDS = [
  'email',
  'emailDirty',
  'password',
  'registeredDate',
  'steam',
  'notifyPrefs',
  'customBadge',
  'lastChargeTime',
] as const;
const RUNTIME_USER_FIELDS = ['activeForeignSegment', 'defaultPublicSegment'] as const;
const NOTIFY_JOB = 'notify:';

function optionalString(value: unknown, what: string): string | undefined {
  if (value !== undefined && typeof value !== 'string') throw new Error(`${what} must be a string`);
  return value;
}

/** The account profile a `users` document carries, or none when it has no account fields. */
function profileOf(
  doc: Doc,
  existing: UserProfile | undefined,
  now: number,
): UserProfile | undefined {
  if (PROFILE_FIELDS.every((field) => doc[field] === undefined)) return undefined;
  const profile: UserProfile = {
    registeredDate:
      doc.registeredDate === undefined
        ? (existing?.registeredDate ?? now)
        : epochDate(doc.registeredDate, 'users.registeredDate'),
  };
  const email = optionalString(doc.email, 'users.email');
  if (email !== undefined) profile.email = email;
  const emailDirty = optionalString(doc.emailDirty, 'users.emailDirty');
  if (emailDirty !== undefined) profile.emailDirty = emailDirty;
  if (doc.password !== undefined) {
    if (typeof doc.password !== 'string' || !doc.password.startsWith('scrypt$')) {
      throw new Error(
        'users.password must be a server scrypt password hash; set passwords with the server CLI',
      );
    }
    profile.passwordHash = doc.password;
  }
  const { steam } = doc;
  if (steam !== undefined) {
    if (
      !isRecord(steam) ||
      typeof steam.id !== 'string' ||
      (steam.displayName !== undefined && typeof steam.displayName !== 'string') ||
      (steam.ownership !== undefined && typeof steam.ownership !== 'boolean') ||
      (steam.steamProfileLinkHidden !== undefined &&
        typeof steam.steamProfileLinkHidden !== 'boolean')
    ) {
      throw new Error('users.steam must be an object with a string id');
    }
    profile.steam = steam as NonNullable<UserProfile['steam']>;
  }
  if (doc.notifyPrefs !== undefined) {
    if (!isRecord(doc.notifyPrefs)) throw new Error('users.notifyPrefs must be an object');
    profile.notifyPrefs = doc.notifyPrefs as JsonObject;
  }
  const badge = doc.customBadge;
  if (badge !== undefined) {
    if (
      !isRecord(badge) ||
      typeof badge.path1 !== 'string' ||
      typeof badge.path2 !== 'string' ||
      Object.keys(badge).length !== 2
    ) {
      throw new Error('users.customBadge must be {path1, path2} strings');
    }
    profile.customBadge = { path1: badge.path1, path2: badge.path2 };
  }
  if (doc.lastChargeTime !== undefined) {
    if (!finite(doc.lastChargeTime)) throw new Error('users.lastChargeTime must be a number');
    profile.lastChargeTime = doc.lastChargeTime;
  }
  if (existing?.lastOnline !== undefined) profile.lastOnline = existing.lastOnline;
  return profile;
}

/**
 * `users` documents: the world user plus its account profile (password hash, e-mail, Steam
 * identity, preferences, registration date), notification schedule and runtime segment settings.
 */
function usersAdapter(context: ServerContext): CollectionAdapter {
  const { state } = context;
  const users = state.world.users as unknown as Record<string, Doc>;
  const runtimeFields = (id: string): Doc => {
    const runtime = own(state.runtime.users, id);
    const fields: Doc = {};
    if (runtime?.activeForeignSegment) {
      const { username, userId, id: segment } = runtime.activeForeignSegment;
      const selection: Doc = { username };
      if (segment !== undefined) selection.id = segment;
      if (userId !== undefined) selection.user_id = userId;
      fields.activeForeignSegment = selection;
    }
    if (runtime?.defaultPublicSegment !== undefined) {
      fields.defaultPublicSegment = runtime.defaultPublicSegment;
    }
    return fields;
  };
  const project = (user: Doc): Doc => {
    const id = String(user._id);
    const doc = copy(user);
    const profile = own(state.profiles, id);
    if (profile) {
      if (profile.email !== undefined) doc.email = profile.email;
      if (profile.emailDirty !== undefined) doc.emailDirty = profile.emailDirty;
      if (profile.passwordHash !== undefined) doc.password = profile.passwordHash;
      doc.registeredDate = new Date(profile.registeredDate).toISOString();
      if (profile.steam !== undefined) doc.steam = copy(profile.steam);
      if (profile.notifyPrefs !== undefined) doc.notifyPrefs = copy(profile.notifyPrefs);
      if (profile.customBadge !== undefined) doc.customBadge = copy(profile.customBadge);
      if (profile.lastChargeTime !== undefined) doc.lastChargeTime = profile.lastChargeTime;
    }
    const notified = own(state.jobs, NOTIFY_JOB + id);
    if (notified !== undefined) doc.lastNotifyDate = notified;
    return Object.assign(doc, copy(runtimeFields(id)));
  };
  const revoke = (id: string): void => {
    for (const [hash, token] of Object.entries(state.tokens)) {
      if (token.userId === id) Reflect.deleteProperty(state.tokens, hash);
    }
    context.publish('auth:revoked', { user: id });
  };
  return {
    indices: ['username'],
    documents: () => Object.values(users).map(project),
    get: (key) => {
      const user = own(users, key);
      return user && project(user);
    },
    commit(changes) {
      const now = context.now();
      const writes = changes.map(({ key, doc, recreated }) => {
        if (!doc)
          return { key, recreated, user: undefined, profile: undefined, notified: undefined };
        safeKey(doc._id, 'users _id');
        if (doc.salt !== undefined) {
          throw new Error(
            'users.salt: original password hashes are not supported; set passwords with the server CLI',
          );
        }
        const current = runtimeFields(key);
        for (const field of RUNTIME_USER_FIELDS) {
          if (JSON.stringify(doc[field]) !== JSON.stringify(current[field])) {
            throw new Error(`users.${field} is player runtime data and read-only`);
          }
        }
        if (doc.lastNotifyDate !== undefined && !finite(doc.lastNotifyDate)) {
          throw new Error('users.lastNotifyDate must be a number');
        }
        const existing = recreated ? undefined : own(state.profiles, key);
        const profile = profileOf(doc, existing, now);
        const user: Doc = {};
        for (const [field, value] of Object.entries(doc)) {
          if (
            !(PROFILE_FIELDS as readonly string[]).includes(field) &&
            !(RUNTIME_USER_FIELDS as readonly string[]).includes(field) &&
            field !== 'lastNotifyDate'
          ) {
            user[field] = value;
          }
        }
        return { key, recreated, user, profile, notified: doc.lastNotifyDate };
      });
      for (const { key, recreated, user, profile, notified } of writes) {
        const previous = own(state.profiles, key);
        if (!user || recreated) {
          Reflect.deleteProperty(users, key);
          Reflect.deleteProperty(state.profiles, key);
          Reflect.deleteProperty(state.jobs, NOTIFY_JOB + key);
          if (!user) {
            revoke(key);
            continue;
          }
        }
        const existing = own(users, key);
        if (existing) replaceDocument(existing, user);
        else users[key] = user;
        if (profile) state.profiles[key] = profile;
        else Reflect.deleteProperty(state.profiles, key);
        if (notified === undefined) Reflect.deleteProperty(state.jobs, NOTIFY_JOB + key);
        else state.jobs[NOTIFY_JOB + key] = notified;
        if (recreated || (previous && previous.passwordHash !== profile?.passwordHash)) revoke(key);
      }
    },
  };
}

function escapeModules(modules: CodeModules): Doc {
  const result: Doc = {};
  for (const [name, source] of Object.entries(modules)) {
    const key = name
      .replace(/\./g, () => '$DOT$')
      .replace(/\//g, () => '$SLASH$')
      .replace(/\\/g, () => '$BACKSLASH$');
    setField(result, key, copy(source));
  }
  return result;
}

/** Backend `translateModulesFromDb`. */
function unescapeModules(value: unknown): CodeModules {
  if (!isRecord(value)) throw new Error('users.code.modules must be an object');
  const modules: CodeModules = {};
  for (const [key, source] of Object.entries(value)) {
    const name = key
      .replace(/\$DOT\$/g, () => '.')
      .replace(/\$SLASH\$/g, () => '/')
      .replace(/\$BACKSLASH\$/g, () => '\\');
    if (name === '__proto__') throw new Error('Keys named __proto__ are not supported');
    if (typeof source === 'string') modules[name] = source;
    else if (isRecord(source) && typeof source.binary === 'string')
      modules[name] = { binary: source.binary };
    else throw new Error('users.code.modules values must be source text or {binary}');
  }
  return modules;
}

/** `users.code` branches; the runtime always runs each player's `activeWorld` branch. */
function codeAdapter(context: ServerContext): CollectionAdapter {
  const { state } = context;
  const branches = state.branches as unknown as Record<string, Doc>;
  const project = (branch: Doc): Doc => ({
    ...copy(branch),
    modules: escapeModules(branch.modules as CodeModules),
  });
  const syncRuntime = (userId: string): void => {
    const active = Object.values(state.branches).find(
      (branch) => branch.user === userId && branch.activeWorld,
    );
    const current = context.runtime.getCode(userId);
    if (active) {
      if (
        current?.branch !== active.branch ||
        JSON.stringify(current.modules) !== JSON.stringify(active.modules)
      ) {
        context.runtime.setCode(userId, active.modules, active.branch);
      }
    } else if (current && Object.keys(current.modules).length) {
      // Like the driver finding no active branch: the player has no code to run.
      context.runtime.setCode(userId, {}, current.branch);
    }
  };
  return {
    indices: ['user'],
    documents: () => Object.values(branches).map(project),
    get: (key) => {
      const branch = own(branches, key);
      return branch && project(branch);
    },
    commit(changes) {
      const affected = new Set<string>();
      const writes = changes.map((change) => {
        const previous = own(state.branches, change.key);
        if (previous) affected.add(previous.user);
        if (!change.doc) return { change, branch: undefined };
        const doc = change.doc;
        const id = safeKey(doc._id, 'users.code _id');
        const user = safeKey(doc.user, 'users.code.user');
        if (typeof doc.branch !== 'string') throw new Error('users.code.branch must be a string');
        for (const flag of ['activeWorld', 'activeSim']) {
          if (doc[flag] !== undefined && typeof doc[flag] !== 'boolean') {
            throw new Error(`users.code.${flag} must be a boolean`);
          }
        }
        const branch: Doc = { ...doc, _id: id, user, modules: unescapeModules(doc.modules) };
        if (doc.timestamp === undefined) Reflect.deleteProperty(branch, 'timestamp');
        else branch.timestamp = epochDate(doc.timestamp, 'users.code.timestamp');
        affected.add(user);
        return { change, branch };
      });
      for (const { change, branch } of writes) {
        if (!branch || change.recreated) Reflect.deleteProperty(branches, change.key);
        if (!branch) continue;
        const existing = own(branches, change.key);
        if (existing) replaceDocument(existing, branch);
        else branches[change.key] = branch;
      }
      for (const user of affected) syncRuntime(user);
    },
  };
}

/** `users.console`: expressions queued in the player runtime for its next run. */
function consoleAdapter(context: ServerContext): CollectionAdapter {
  const queued = (): Doc[] =>
    Object.entries(context.runtime.snapshot().users).flatMap(([user, data]) =>
      data.consoleCommands.map((command, index) => {
        const doc: Doc = { user, expression: command.expression };
        if (command.hidden !== undefined) doc.hidden = command.hidden;
        doc._id = `${user}:${String(index)}`;
        return doc;
      }),
    );
  const pending = new Map<string, number>();
  return {
    indices: ['user'],
    documents: queued,
    get: (key) => queued().find((doc) => doc._id === key),
    derivedId(doc) {
      if (typeof doc.user !== 'string') return undefined;
      const count =
        pending.get(doc.user) ??
        context.runtime.snapshot().users[doc.user]?.consoleCommands.length ??
        0;
      pending.set(doc.user, count + 1);
      return `${doc.user}:${String(count)}`;
    },
    commit(changes) {
      const existing = new Set(queued().map((doc) => doc._id));
      const commands = changes.map(({ key, doc }) => {
        if (!doc || existing.has(key)) {
          throw new Error(
            'users.console commands are consumed by the player runtime; they can only be inserted',
          );
        }
        const user = safeKey(doc.user, 'users.console.user');
        if (typeof doc.expression !== 'string') {
          throw new Error('users.console.expression must be a string');
        }
        if (doc.hidden !== undefined && typeof doc.hidden !== 'boolean') {
          throw new Error('users.console.hidden must be a boolean');
        }
        return { user, expression: doc.expression, hidden: doc.hidden === true };
      });
      for (const { user, expression, hidden } of commands) {
        context.runtime.enqueueConsoleCommand(user, expression, hidden);
      }
    },
  };
}

/** `leaderboard.world` / `leaderboard.power`: ranked monthly scores, as the leaderboard API ranks. */
function leaderboardAdapter(state: ServerState, mode: 'world' | 'power'): CollectionAdapter {
  const documents = (): Doc[] =>
    Object.entries(state.leaderboard).flatMap(([season, scores]) =>
      Object.entries(scores)
        .filter(([, score]) => score[mode] > 0)
        .sort(([userA, a], [userB, b]) => b[mode] - a[mode] || (userA < userB ? -1 : 1))
        .map(([user, score], rank) => ({
          _id: `${season}-${mode}-${user}`,
          season,
          user,
          score: score[mode],
          rank,
        })),
    );
  return {
    indices: [],
    documents,
    get: (key) => documents().find((doc) => doc._id === key),
    derivedId: (doc) =>
      typeof doc.season === 'string' && typeof doc.user === 'string'
        ? `${doc.season}-${mode}-${doc.user}`
        : undefined,
    commit(changes) {
      const current = new Map(documents().map((doc) => [String(doc._id), doc]));
      const writes = changes.flatMap(({ key, doc }) => {
        if (!doc) {
          const removed = current.get(key);
          if (!removed) return [];
          return [
            { season: String(removed.season), user: String(removed.user), score: 0, remove: true },
          ];
        }
        for (const field of Object.keys(doc)) {
          if (!['_id', 'season', 'user', 'score', 'rank'].includes(field)) {
            throw new Error(`leaderboard.${mode}.${field} is not supported`);
          }
        }
        const season = safeKey(doc.season, `leaderboard.${mode}.season`);
        if (!SEASON.test(season)) throw new Error(`leaderboard.${mode}.season must be YYYY-MM`);
        const user = safeKey(doc.user, `leaderboard.${mode}.user`);
        if (key !== `${season}-${mode}-${user}`) {
          throw new Error(`leaderboard.${mode} _id must be "<season>-${mode}-<user>"`);
        }
        if (!finite(doc.score) || doc.score < 0) {
          throw new Error(`leaderboard.${mode}.score must be a non-negative number`);
        }
        if (doc.rank !== undefined && doc.rank !== current.get(key)?.rank) {
          throw new Error(`leaderboard.${mode}.rank is derived from scores`);
        }
        return [{ season, user, score: doc.score, remove: false }];
      });
      for (const { season, user, score, remove } of writes) {
        const scores = (state.leaderboard[season] ??= {});
        const entry = (scores[user] ??= { world: 0, power: 0 });
        entry[mode] = score;
        if (remove && entry.world === 0 && entry.power === 0) {
          Reflect.deleteProperty(scores, user);
          if (!Object.keys(scores).length) Reflect.deleteProperty(state.leaderboard, season);
        }
      }
    },
  };
}

function originalData(state: ServerState): OriginalStorageData {
  return (state.originalStorage ??= { collections: {}, env: {}, expirations: {} });
}

function pruneOriginalData(state: ServerState): void {
  const data = state.originalStorage;
  if (
    data &&
    !Object.keys(data.collections).length &&
    !Object.keys(data.env).length &&
    !Object.keys(data.expirations).length
  ) {
    Reflect.deleteProperty(state, 'originalStorage');
  }
}

/** A collection without a canonical home (mod collections, `leaderboard.seasons`), kept as-is. */
function storedAdapter(state: ServerState, name: string): CollectionAdapter {
  const stored = (): JsonObject[] => state.originalStorage?.collections[name] ?? [];
  return {
    indices: [],
    documents: () => stored().map((doc) => copy(doc) as Doc),
    get: (key) => {
      const doc = stored().find((item) => {
        const id: unknown = item._id;
        return String(id) === key;
      });
      return doc && copy(doc);
    },
    commit(changes) {
      const docs = changes.map(({ doc }) => {
        if (!doc) return undefined;
        if (typeof doc._id !== 'string' && !finite(doc._id)) {
          throw new Error(`${name} _id must be a string or number`);
        }
        return copy(doc) as JsonObject;
      });
      const list = [...stored()];
      changes.forEach(({ key, recreated }, index) => {
        const doc = docs[index];
        const position = list.findIndex((item) => {
          const id: unknown = item._id;
          return String(id) === key;
        });
        if (position >= 0 && (!doc || recreated)) list.splice(position, 1);
        if (!doc) return;
        if (position >= 0 && !recreated) list[position] = doc;
        else list.push(doc);
      });
      const data = originalData(state);
      if (list.length) data.collections[name] = list;
      else Reflect.deleteProperty(data.collections, name);
      pruneOriginalData(state);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Env

interface EnvSlot {
  /** Stored original value (a copy); `undefined` when absent. */
  read(): unknown;
  /** Stores a value; `undefined` deletes the key. */
  write(value: unknown): void | Promise<void>;
  /** Expiring keys only: expires the key `seconds` from now. */
  expire?(seconds: number): void;
  /** Expiring keys only: seconds to expiry or -1. */
  ttl?(): number;
}

function canonicalSlot(
  name: string,
  read: () => unknown,
  write: (value: unknown) => void | Promise<void>,
  remove?: () => void | Promise<void>,
): EnvSlot {
  return {
    read,
    write: (value) => {
      if (value !== undefined) return write(value);
      if (!remove) throw new Error(`${name} cannot be deleted`);
      return remove();
    },
  };
}

function hashOf(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${what} must be a hash`);
  return value;
}

function ownField(value: unknown, field: unknown): unknown {
  const target = Object(value) as Doc;
  const key = String(field);
  return Object.hasOwn(target, key) ? target[key] : undefined;
}

/** Driver `updateRoomStatusData`. */
function roomStatusData(state: ServerState, now: number): string {
  const data = { novice: {} as Doc, respawn: {} as Doc, closed: {} as Doc };
  const after = (time: unknown): time is number => finite(time) && time > now;
  for (const room of Object.values(state.world.rooms)) {
    if (after(room.novice)) data.novice[room._id] = room.novice;
    else if (after(room.respawnArea)) data.respawn[room._id] = room.respawnArea;
    else if (after(room.openTime)) data.closed[room._id] = room.openTime;
    else if (room.status === 'out of borders') data.closed[room._id] = Infinity;
  }
  return JSON.stringify(data);
}

/** CLI `map.updateTerrainData`: terrain documents, out-of-border rooms and missing neighbors walled. */
function terrainData(state: ServerState): string {
  const { world } = state;
  const terrain: Array<{ room: string; terrain: string; type?: string; _id?: string }> =
    Object.entries(world.terrain).map(([room, data]) => ({
      room,
      terrain: data,
      type: 'terrain',
      _id: room,
    }));
  const known = new Set(terrain.map((item) => item.room));
  for (const room of Object.values(world.rooms)) {
    if (room.status === 'out of borders') {
      const item = terrain.find((entry) => entry.room === room._id);
      if (item) item.terrain = WALLED_TERRAIN;
    }
    const match = ROOM_NAME.exec(room._id);
    if (!match) continue;
    const [, h = '', x = '', v = '', y = ''] = match;
    for (const neighbor of [h + String(Number(x) + 1) + v + y, h + x + v + String(Number(y) + 1)]) {
      if (!known.has(neighbor)) {
        known.add(neighbor);
        terrain.push({ room: neighbor, terrain: WALLED_TERRAIN });
      }
    }
  }
  return deflateSync(JSON.stringify(terrain)).toString('base64');
}

// ---------------------------------------------------------------------------------------------
// Storage

class OriginalStorageCore {
  readonly #context: ServerContext;
  readonly #indices = new Map<string, Set<string>>();
  readonly #visuals = new Map<string, { value: unknown; expires: number }>();
  readonly #bus = new EventEmitter();
  /** Parsed payloads this storage published, mapped back to the original text. */
  readonly #echoes = new WeakMap<object, unknown>();
  #attached = false;

  constructor(context: ServerContext) {
    this.#context = context;
    this.#bus.setMaxListeners(0);
  }

  /** Starts following kernel publications and ticks (room visuals, pubsub). */
  attach(): void {
    if (this.#attached) return;
    const { events } = this.#context;
    events.on('message', this.#onMessage);
    events.on('tick', this.#onTick);
    this.#attached = true;
  }

  read<T>(operation: () => T | Promise<T>): Promise<T> {
    this.attach();
    return this.#context.read(operation);
  }

  mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    this.attach();
    return this.#context.mutate(operation);
  }

  // -- collections ------------------------------------------------------------------------------

  adapter(name: string): CollectionAdapter {
    const context = this.#context;
    const { state } = context;
    const { world } = state;
    const record = <T>(value: Record<string, T>): Record<string, Doc> =>
      value as unknown as Record<string, Doc>;
    switch (name) {
      case 'rooms':
        return roomsAdapter(state);
      case 'rooms.objects':
        return keyedAdapter({
          name,
          record: record(world.roomObjects),
          indices: ['room', 'user'],
          validate: (doc) => {
            requireFields(doc, name, { type: 'string', room: 'string', x: 'number', y: 'number' });
          },
          // Unrecorded objects count as written after all others, in key order.
          recency: (docs) => {
            const seqs = world.roomObjectWriteSeq ?? {};
            let next = world.writeSeq ?? 0;
            return docs.map((doc) => own(seqs, String(doc._id)) ?? ++next);
          },
          afterCommit: (written) => {
            recordRoomObjectWrites(world, written);
          },
        });
      case 'rooms.flags':
        return keyedAdapter({
          name,
          record: record(world.flags),
          indices: ['room', 'user'],
          validate: (doc) => {
            requireFields(doc, name, { user: 'string', room: 'string', data: 'string' });
          },
        });
      case 'rooms.terrain':
        return terrainAdapter(context);
      case 'rooms.intents':
        return roomIntentsAdapter(state);
      case 'users':
        return usersAdapter(context);
      case 'users.code':
        return codeAdapter(context);
      case 'users.console':
        return consoleAdapter(context);
      case 'users.intents':
        return userIntentsAdapter(state);
      case 'users.messages':
        return keyedAdapter({
          name,
          record: record(state.messages),
          indices: [],
          dates: ['date'],
          validate: (doc) => {
            requireFields(doc, name, {
              user: 'string',
              respondent: 'string',
              text: 'string',
              date: 'number',
            });
            if (doc.type !== 'in' && doc.type !== 'out') {
              throw new Error("users.messages.type must be 'in' or 'out'");
            }
            if (typeof doc.unread !== 'boolean')
              throw new Error('users.messages.unread must be a boolean');
            optionalString(doc.outMessage, 'users.messages.outMessage');
          },
        });
      case 'users.money':
        return keyedAdapter({
          name,
          record: record(world.usersMoney),
          indices: ['user'],
          dates: ['date'],
        });
      case 'users.resources':
        return keyedAdapter({
          name,
          record: record(world.usersResources),
          indices: ['user'],
          dates: ['date'],
        });
      case 'users.notifications':
        return keyedAdapter({ name, record: record(world.notifications), indices: ['user'] });
      case 'users.power_creeps':
        return keyedAdapter({ name, record: record(world.userPowerCreeps), indices: ['user'] });
      case 'market.orders':
        return keyedAdapter({ name, record: record(world.marketOrders), indices: [] });
      case 'market.stats':
        return keyedAdapter({ name, record: record(world.marketStats), indices: [] });
      case 'transactions':
        return keyedAdapter({ name, record: record(world.transactions), indices: ['user'] });
      case 'leaderboard.world':
        return leaderboardAdapter(state, 'world');
      case 'leaderboard.power':
        return leaderboardAdapter(state, 'power');
      default:
        return storedAdapter(state, name);
    }
  }

  /** A LokiJS collection holding the projected documents with the original index order. */
  loki(name: string, adapter: CollectionAdapter): LokiCollection {
    const docs = adapter.documents();
    const collection = new Loki.Collection(name, { disableMeta: true, unique: ['_id'] });
    if (docs.length) collection.insert(docs);
    const recency = adapter.recency?.(docs) ?? docs.map((_, position) => position);
    for (const field of new Set([...adapter.indices, ...(this.#indices.get(name) ?? [])])) {
      collection.binaryIndices[field] = {
        name: field,
        dirty: false,
        values: indexOrder(collection.data, field, recency),
      };
    }
    return collection;
  }

  stage(adapter: CollectionAdapter): Stage {
    return new Stage(adapter, new IdAllocator(this.#context.state));
  }

  ensureIndex(name: string, field: unknown): void {
    if (field === null || field === undefined) {
      throw new Error('Attempting to set index without an associated property');
    }
    if (typeof field !== 'string') throw new TypeError('prop.indexOf is not a function');
    let fields = this.#indices.get(name);
    if (!fields) this.#indices.set(name, (fields = new Set()));
    fields.add(field);
  }

  // -- env --------------------------------------------------------------------------------------

  slot(name: string): EnvSlot {
    const context = this.#context;
    const { state } = context;
    const { world } = state;
    switch (name) {
      case ENV_KEYS.GAMETIME:
        return canonicalSlot(
          name,
          () => world.gameTime,
          (value) => {
            const time = integer(value, name);
            if (time < 1) throw new Error(`${name} must be positive`);
            world.gameTime = time;
          },
        );
      case ENV_KEYS.MAIN_LOOP_PAUSED:
        return canonicalSlot(
          name,
          () => (state.paused ? '1' : '0'),
          (value) => context.setPaused(Boolean(Number(value))),
          () => context.setPaused(false),
        );
      case ENV_KEYS.MAIN_LOOP_MIN_DURATION:
        return canonicalSlot(
          name,
          () => state.tickDuration,
          (value) => context.setTickDuration(integer(value, name)),
        );
      case ENV_KEYS.ACTIVE_ROOMS:
        return canonicalSlot(
          name,
          () => [...world.activeRooms],
          (value) => {
            if (!Array.isArray(value) || !value.every((room) => typeof room === 'string')) {
              throw new Error(`${name} must be a list of room names`);
            }
            world.activeRooms = [...new Set(value)];
          },
          () => {
            world.activeRooms = [];
          },
        );
      case ENV_KEYS.ACCESSIBLE_ROOMS:
      case ENV_KEYS.ROOM_STATUS_DATA:
      case ENV_KEYS.TERRAIN_DATA: {
        const read = (): string => {
          const now = context.now();
          if (name === ENV_KEYS.ROOM_STATUS_DATA) return roomStatusData(state, now);
          if (name === ENV_KEYS.TERRAIN_DATA) return terrainData(state);
          return JSON.stringify(
            Object.values(world.rooms)
              .filter((room) => room.status === 'normal' && (!room.openTime || room.openTime < now))
              .map((room) => room._id),
          );
        };
        const fail = (): never => {
          throw new Error(`${name} is derived from the world rooms and terrain`);
        };
        return canonicalSlot(name, read, fail, fail);
      }
      case ENV_KEYS.ROOM_EVENT_LOG:
        return canonicalSlot(
          name,
          () => {
            const entries = Object.entries(world.roomEventLogs);
            return entries.length
              ? Object.fromEntries(entries.map(([room, log]) => [room, JSON.stringify(log)]))
              : undefined;
          },
          (value) => {
            const logs: ServerState['world']['roomEventLogs'] = {};
            for (const [room, text] of Object.entries(hashOf(value, name))) {
              const log = parseJson(text, `${name}${room}`);
              if (
                !Array.isArray(log) ||
                !log.every(
                  (event): event is ServerState['world']['roomEventLogs'][string][number] =>
                    isRecord(event) &&
                    typeof event.event === 'number' &&
                    typeof event.objectId === 'string' &&
                    (event.data === undefined || isRecord(event.data)),
                )
              ) {
                throw new Error(`${name}${room} must be a JSON list of events`);
              }
              logs[safeKey(room, 'room')] = log;
            }
            world.roomEventLogs = logs;
          },
          () => {
            world.roomEventLogs = {};
          },
        );
    }
    const [prefix, subject] = this.#split(name);
    switch (prefix) {
      case ENV_KEYS.MEMORY:
        return canonicalSlot(
          name,
          () => context.runtime.getMemory(subject) || undefined,
          (value) => {
            if (typeof value !== 'string') throw new Error(`${name} must be a string`);
            context.runtime.setMemory(subject, value);
          },
          () => {
            context.runtime.setMemory(subject, '');
          },
        );
      case ENV_KEYS.MEMORY_SEGMENTS: {
        const segments = (): Record<string, string> => {
          const result: Record<string, string> = {};
          for (let id = 0; id < 100; id++) {
            const data = context.runtime.getSegment(subject, id);
            if (data !== undefined) result[String(id)] = data;
          }
          return result;
        };
        const store = (value: Record<string, unknown>): void => {
          const next = new Map<number, string>();
          for (const [field, data] of Object.entries(value)) {
            if (typeof data !== 'string') throw new Error(`${name} segments must be strings`);
            const id = /^\d+$/.test(field) ? Number(field) : NaN;
            if (!(id >= 0 && id <= 99))
              throw new Error(`${name}: "${field}" is not a valid segment ID`);
            next.set(id, data);
          }
          // Segments cannot be removed from the runtime: removed ones become empty.
          for (const field of Object.keys(segments())) {
            const id = Number(field);
            if (!next.has(id)) next.set(id, '');
          }
          for (const [id, data] of next) context.runtime.setSegment(subject, id, data);
        };
        return canonicalSlot(
          name,
          () => {
            const result = segments();
            return Object.keys(result).length ? result : undefined;
          },
          (value) => {
            store(hashOf(value, name));
          },
          () => {
            store({});
          },
        );
      }
      case ENV_KEYS.PUBLIC_MEMORY_SEGMENTS: {
        const fail = (): never => {
          throw new Error(`${name} is set by player code (RawMemory.setPublicSegments)`);
        };
        return canonicalSlot(
          name,
          () => own(state.runtime.users, subject)?.publicSegments,
          fail,
          fail,
        );
      }
      case ENV_KEYS.MAP_VIEW:
        return canonicalSlot(
          name,
          () => {
            const view = own(world.mapViews, subject);
            return view && JSON.stringify(view);
          },
          (value) => {
            const view = parseJson(value, name);
            if (
              !isRecord(view) ||
              !Object.values(view).every((positions) => Array.isArray(positions))
            ) {
              throw new Error(`${name} must be a JSON map view`);
            }
            world.mapViews[safeKey(subject, 'room')] =
              view as ServerState['world']['mapViews'][string];
          },
          () => {
            Reflect.deleteProperty(world.mapViews, subject);
          },
        );
      case ENV_KEYS.ROOM_HISTORY:
        return canonicalSlot(
          name,
          () => {
            const frames = own(state.history, subject);
            return (
              frames &&
              Object.fromEntries(
                frames.map((frame) => [String(frame.time), JSON.stringify(frame.objects)]),
              )
            );
          },
          (value) => {
            const frames = Object.entries(hashOf(value, name)).map(([time, text]) => {
              const objects = parseJson(text, `${name} tick ${time}`);
              if (
                !isRecord(objects) ||
                !Object.values(objects).every((object) => isRecord(object))
              ) {
                throw new Error(`${name} ticks must be JSON room objects`);
              }
              return {
                time: integer(time, `${name} tick`),
                objects: objects as Record<string, Doc>,
              };
            });
            frames.sort((a, b) => a.time - b.time);
            state.history[safeKey(subject, 'room')] = frames;
          },
          () => {
            Reflect.deleteProperty(state.history, subject);
          },
        );
      case ENV_KEYS.ROOM_VISUAL:
        return this.#visualSlot(name);
      case ENV_KEYS.USER_ONLINE: {
        const profile = own(state.profiles, subject);
        if (!profile) break;
        return canonicalSlot(
          name,
          () => profile.lastOnline,
          (value) => {
            const time = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
            if (!finite(time)) throw new Error(`${name} must be a timestamp`);
            profile.lastOnline = time;
          },
          () => {
            Reflect.deleteProperty(profile, 'lastOnline');
          },
        );
      }
    }
    return this.#storedSlot(name);
  }

  #split(name: string): [string, string] {
    for (const prefix of [...CANONICAL_ENV_PREFIXES, ENV_KEYS.USER_ONLINE]) {
      if (name.startsWith(prefix)) return [prefix, name.slice(prefix.length)];
    }
    return ['', name];
  }

  #visualSlot(name: string): EnvSlot {
    const entry = (): { value: unknown; expires: number } | undefined => {
      const visual = this.#visuals.get(name);
      return visual && visual.expires >= this.#context.now() ? visual : undefined;
    };
    return {
      read: () => entry()?.value,
      write: (value) => {
        if (value === undefined) this.#visuals.delete(name);
        else
          this.#visuals.set(name, { value, expires: this.#visuals.get(name)?.expires ?? Infinity });
      },
      expire: (seconds) => {
        const visual = this.#visuals.get(name);
        if (visual) visual.expires = this.#context.now() + seconds * 1000;
      },
      ttl: () => {
        const visual = entry();
        return visual && Number.isFinite(visual.expires)
          ? (visual.expires - this.#context.now()) / 1000
          : -1;
      },
    };
  }

  #storedSlot(name: string): EnvSlot {
    const { state } = this.#context;
    return {
      read: () => {
        const data = state.originalStorage;
        const at = data && own(data.expirations, name);
        if (!data || (at !== undefined && this.#context.now() > at)) return undefined;
        return copy(own(data.env, name));
      },
      write: (value) => {
        const data = originalData(state);
        if (value === undefined) Reflect.deleteProperty(data.env, name);
        else setField(data.env, name, copy(value));
        pruneOriginalData(state);
      },
      expire: (seconds) => {
        setField(originalData(state).expirations, name, this.#context.now() + seconds * 1000);
      },
      ttl: () => {
        const data = state.originalStorage;
        const at = data && own(data.expirations, name);
        const now = this.#context.now();
        return at === undefined || at < now ? -1 : (at - now) / 1000;
      },
    };
  }

  /** Storage `envCleanExpired`: run before env writes. */
  purgeExpired(): void {
    const { state } = this.#context;
    const data = state.originalStorage;
    if (!data) return;
    const now = this.#context.now();
    for (const [name, at] of Object.entries(data.expirations)) {
      if (now > at) {
        Reflect.deleteProperty(data.env, name);
        Reflect.deleteProperty(data.expirations, name);
      }
    }
    pruneOriginalData(state);
  }

  // -- pubsub -----------------------------------------------------------------------------------

  async publish(channel: string, data: unknown): Promise<void> {
    const context = this.#context;
    if (channel === 'setTickRate') {
      // Driver `setTickRate`: a positive value sets the main loop duration; others keep it.
      const value = typeof data === 'number' ? Math.trunc(data) : Number.parseInt(String(data), 10);
      if (data && value) await context.setTickDuration(value);
    }
    if (channel === PUBSUB_KEYS.RUNTIME_RESTART) {
      // Runner `runtimeUserVm.clearAll()`: every player's next run starts in a fresh isolate.
      const users = new Set([
        ...Object.keys(context.state.runtime.users),
        ...Object.keys(context.state.world.users),
      ]);
      for (const user of users) {
        const code = context.runtime.getCode(user);
        if (code) context.runtime.setCode(user, code.modules, code.branch);
      }
    }
    let payload = data;
    if (typeof data === 'string' && JSON_CHANNEL.test(channel)) {
      try {
        payload = JSON.parse(data) as unknown;
      } catch {
        payload = data;
      }
      if (typeof payload === 'object' && payload !== null) this.#echoes.set(payload, data);
    }
    context.publish(channel, payload);
  }

  subscribe(channel: string, listener: OriginalPubsubListener): () => void {
    if (typeof listener !== 'function') throw new TypeError('Pubsub listener must be a function');
    this.attach();
    const handler = (name: string, data: unknown): void => {
      try {
        listener.call({ channel: name }, copy(data));
      } catch (error) {
        this.#context.events.emit(
          'error',
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    };
    this.#bus.on(channel, handler);
    return () => {
      this.#bus.off(channel, handler);
    };
  }

  #listening(channel: string): boolean {
    return this.#bus.listenerCount(channel) + this.#bus.listenerCount('*') > 0;
  }

  /** Delivers asynchronously, like messages arriving over the storage socket. */
  #deliver(channel: string, data: unknown): void {
    if (!this.#listening(channel)) return;
    setImmediate(() => {
      this.#bus.emit(channel, channel, data);
      this.#bus.emit('*', channel, data);
    });
  }

  readonly #onMessage = (channel: string, data: unknown): void => {
    if (INTERNAL_CHANNEL.test(channel) || !this.#listening(channel)) return;
    let original = data;
    if (typeof data === 'object' && data !== null && this.#echoes.has(data)) {
      original = this.#echoes.get(data);
    } else if (JSON_CHANNEL.test(channel) && typeof data !== 'string') {
      original = JSON.stringify(data);
    }
    this.#deliver(channel, original);
  };

  readonly #onTick = (event: TickEvent): void => {
    const now = this.#context.now();
    const time = event.simulation.gameTime;
    for (const [key, visual] of this.#visuals) if (visual.expires < now) this.#visuals.delete(key);
    for (const [user, result] of Object.entries(event.runtime.users)) {
      for (const [room, visual] of Object.entries(result.visual)) {
        this.#visuals.set(`${ENV_KEYS.ROOM_VISUAL}${user},${room},${String(time)}`, {
          value: visual,
          expires: now + VISUAL_TTL,
        });
      }
    }
    this.#deliver(PUBSUB_KEYS.TICK_STARTED, '1');
    for (const [user, result] of Object.entries(event.runtime.users)) {
      if (Object.hasOwn(BUILTIN_USERS, user)) continue;
      const { log, results, error } = result.console;
      const channel = `user:${user}/console`;
      if (this.#listening(channel)) {
        if (log.length || results.length || error === undefined) {
          const messages = {
            log: log.map((item) => (item.escape ? htmlEncode(item.message) : item.message)),
            results,
          };
          this.#deliver(channel, JSON.stringify({ messages, userId: user }));
        }
        if (error) this.#deliver(channel, JSON.stringify({ userId: user, error }));
      }
      const cpu = error !== undefined && CPU_LIMIT_ERROR.test(error) ? 'error' : result.cpu.used;
      this.#deliver(`user:${user}/cpu`, JSON.stringify({ cpu, memory: result.memorySize }));
    }
    this.#deliver(PUBSUB_KEYS.ROOMS_DONE, time);
  };
}

function collectionApi(core: OriginalStorageCore, name: string): OriginalCollection {
  const query = (operation: (collection: LokiCollection, adapter: CollectionAdapter) => unknown) =>
    core.read(() => {
      const adapter = core.adapter(name);
      return operation(core.loki(name, adapter), adapter);
    });
  const write = <T>(operation: (stage: Stage, adapter: CollectionAdapter) => T): Promise<T> =>
    core.mutate(() => {
      const adapter = core.adapter(name);
      const stage = core.stage(adapter);
      const result = operation(stage, adapter);
      stage.commit();
      return result;
    });
  return {
    find: (...args: unknown[]) =>
      respond(() => {
        const [filter] = inputs(args);
        replaceNeNull(filter);
        return query((collection) => collection.find(filter).map(withoutLokiId)) as Promise<
          OriginalDocument[]
        >;
      }),
    findOne: (...args: unknown[]) =>
      respond(() => {
        const [filter] = inputs(args);
        replaceNeNull(filter);
        return query((collection) => {
          const doc = collection.findOne(filter);
          return doc && withoutLokiId(doc);
        }) as Promise<OriginalDocument | null>;
      }),
    by: (...args: unknown[]) =>
      respond(() => {
        const [field, value] = inputs(args);
        const key = String(value);
        // LokiJS returns a lookup function without a value; it does not survive the RPC.
        if (value === undefined) return undefined;
        if (field !== '_id')
          throw new TypeError("Cannot read properties of undefined (reading 'get')");
        return core.read(() => core.adapter(name).get(key));
      }),
    count: (...args: unknown[]) =>
      respond(() => {
        const [filter] = inputs(args);
        replaceNeNull(filter);
        return query((collection) => collection.count(filter)) as Promise<number>;
      }),
    clear: () =>
      respond(() =>
        write((stage, adapter) => {
          for (const doc of adapter.documents()) stage.remove(String(doc._id));
          return undefined;
        }),
      ),
    ensureIndex: (...args: unknown[]) =>
      respond(() => {
        const [field] = inputs(args);
        core.ensureIndex(name, field);
        return undefined;
      }),
    removeWhere: (...args: unknown[]) =>
      respond(() => {
        const [filter] = inputs(args);
        replaceNeNull(filter);
        return write((stage, adapter) => {
          for (const doc of core.loki(name, adapter).chain().find(filter).data()) {
            stage.remove(String(doc._id));
          }
          return undefined;
        });
      }),
    insert: (...args: unknown[]) =>
      respond(() => {
        const [documents] = inputs(args);
        return write((stage) => {
          if (!Array.isArray(documents)) return stage.insert(documents);
          const inserted = documents.map((doc) => stage.insert(doc));
          return inserted.length === 1 ? inserted[0] : inserted;
        }) as Promise<OriginalDocument | OriginalDocument[]>;
      }),
    update: (...args: unknown[]) =>
      respond(() => {
        const [filter, update, params] = inputs(args);
        replaceNeNull(filter);
        return write((stage, adapter): OriginalUpdateResult => {
          const conditions = Object(filter) as Doc;
          if (filter === null || filter === undefined) {
            throw new TypeError('Cannot convert undefined or null to object');
          }
          const id = conditions._id;
          const matches =
            Object.keys(conditions).length === 1 && id && typeof id === 'string'
              ? [adapter.get(id)].filter((doc): doc is Doc => doc !== undefined)
              : core.loki(name, adapter).find(conditions).map(withoutLokiId);
          if (matches.length) {
            for (const doc of matches) {
              const key = String(doc._id);
              updateDocument(doc, update);
              stage.write(key, doc);
            }
            return { modified: matches.length };
          }
          if (isRecord(params) && params.upsert) {
            const item: Doc = {};
            if (conditions.$and) {
              if (!Array.isArray(conditions.$and))
                throw new TypeError('query.$and.forEach is not a function');
              for (const clause of conditions.$and) lodash.extend(item, clause);
            } else {
              lodash.extend(item, conditions);
            }
            updateDocument(item, update);
            stage.insert(item);
            return { inserted: 1 };
          }
          return {};
        });
      }),
    bulk: (...args: unknown[]) =>
      respond(() => {
        const [operations] = inputs(args);
        return write((stage) => {
          if (!Array.isArray(operations)) throw new TypeError('bulk.forEach is not a function');
          for (const operation of operations as unknown[]) {
            if (operation === null || operation === undefined) {
              throw new TypeError(`Cannot read properties of ${String(operation)} (reading 'op')`);
            }
            const { op, id, update, data } = Object(operation) as Doc;
            const key = String(id);
            if (op === 'update') {
              const doc = stage.get(key);
              if (doc) {
                const next = copy(doc);
                updateDocument(next, update);
                stage.write(key, next);
              }
            } else if (op === 'insert') {
              if (Array.isArray(data)) for (const doc of data) stage.insert(doc);
              else stage.insert(data);
            } else if (op === 'remove') {
              if (stage.get(key)) stage.remove(key);
            }
          }
          return undefined;
        });
      }),
    findEx: (...args: unknown[]) =>
      respond(() => {
        const [filter, options] = inputs(args);
        replaceNeNull(filter);
        if (options === null || options === undefined) {
          throw new TypeError(`Cannot read properties of ${String(options)} (reading 'sort')`);
        }
        const { sort, offset, limit } = Object(options) as Doc;
        return query((collection) => {
          let chain = collection.chain().find(filter);
          if (sort) {
            const fields = Object(sort) as Doc;
            for (const field in fields)
              chain = chain.simplesort(field, Number(fields[field]) === -1);
          }
          if (offset) chain = chain.offset(offset);
          if (limit) chain = chain.limit(limit);
          return chain.data().map(withoutLokiId);
        }) as Promise<OriginalDocument[]>;
      }),
  };
}

function envApi(core: OriginalStorageCore): OriginalEnv {
  // Storage `envCleanExpired` runs before every env write rather than on a timer.
  const write = <T>(operation: () => T | Promise<T>): Promise<T> =>
    core.mutate(() => {
      core.purgeExpired();
      return operation();
    });
  const expire = (slot: EnvSlot, key: string, seconds: unknown): void => {
    if (!slot.expire) throw new Error(`${key} is world data and cannot expire`);
    slot.expire(Number(seconds));
  };
  return {
    keys: { ...ENV_KEYS },
    get: (...args: unknown[]) =>
      respond(() => {
        const [key] = inputs(args);
        return core.read(() => core.slot(String(key)).read());
      }),
    mget: (...args: unknown[]) =>
      respond(() => {
        const [keys] = inputs(args);
        if (!Array.isArray(keys)) throw new TypeError('names.map is not a function');
        return core.read(() => keys.map((key) => core.slot(String(key)).read()));
      }),
    set: (...args: unknown[]) =>
      respond(() => {
        const [key, value] = inputs(args);
        return write(async () => {
          await core.slot(String(key)).write(value);
          return value;
        });
      }),
    setex: (...args: unknown[]) =>
      respond(() => {
        const [key, seconds, value] = inputs(args);
        return write(async (): Promise<undefined> => {
          const slot = core.slot(String(key));
          if (!slot.expire) throw new Error(`${String(key)} is world data and cannot expire`);
          await slot.write(value);
          expire(slot, String(key), seconds);
          return undefined;
        });
      }),
    expire: (...args: unknown[]) =>
      respond(() => {
        const [key, seconds] = inputs(args);
        return write((): undefined => {
          expire(core.slot(String(key)), String(key), seconds);
          return undefined;
        });
      }),
    ttl: (...args: unknown[]) =>
      respond(() => {
        const [key] = inputs(args);
        return core.read(() => core.slot(String(key)).ttl?.() ?? -1);
      }),
    del: (...args: unknown[]) =>
      respond(() => {
        const [key] = inputs(args);
        return write(async () => {
          const slot = core.slot(String(key));
          // Like the storage: only truthy values count as present.
          if (!slot.read()) return 0;
          await slot.write(undefined);
          return 1;
        });
      }),
    hmget: (...args: unknown[]) =>
      respond(() => {
        const [key, fields] = inputs(args);
        if (!Array.isArray(fields)) throw new TypeError('fields.map is not a function');
        return core.read(() => {
          const value = core.slot(String(key)).read() || {};
          return fields.map((field) => ownField(value, field));
        });
      }),
    hmset: (...args: unknown[]) =>
      respond(() => {
        const [key, data] = inputs(args);
        return write(async () => {
          const slot = core.slot(String(key));
          const value = slot.read();
          // `_.extend` of a primitive changes nothing.
          if (value && typeof value !== 'object') return value;
          const next = lodash.extend(value ? copy(value) : {}, data);
          await slot.write(next);
          return next;
        });
      }),
    hget: (...args: unknown[]) =>
      respond(() => {
        const [key, field] = inputs(args);
        return core.read(() => {
          const value = core.slot(String(key)).read();
          return value ? ownField(value, field) : undefined;
        });
      }),
    hset: (...args: unknown[]) =>
      respond(() => {
        const [key, field, value] = inputs(args);
        return write(async () => {
          const slot = core.slot(String(key));
          const current = slot.read();
          // Assigning a field of a primitive changes nothing.
          if (current && typeof current !== 'object') return undefined;
          const next = current ? copy(current) : {};
          setField(next, String(field), value);
          await slot.write(next);
          return value;
        });
      }),
    sadd: (...args: unknown[]) =>
      respond(() => {
        const [key, data] = inputs(args);
        const items = Array.isArray(data) ? data : [data];
        return write(async () => {
          const slot = core.slot(String(key));
          const current: unknown = slot.read() || [];
          const next: unknown = Array.isArray(current) ? [...(current as unknown[])] : current;
          for (const item of items) {
            if (lodash.includes(next, item)) continue;
            if (!Array.isArray(next))
              throw new TypeError('values.data[name].push is not a function');
            next.push(item);
          }
          if (Array.isArray(next)) await slot.write(next);
          return next;
        });
      }),
    smembers: (...args: unknown[]) =>
      respond(() => {
        const [key] = inputs(args);
        return core.read(() => core.slot(String(key)).read() || undefined);
      }),
  };
}

interface WorkQueue {
  pending: unknown[];
  processing: unknown[];
  emitter: EventEmitter;
}

/** Storage `queue.js`: the work queues of the original engine processes, held in memory. */
function queueApi(publish: OriginalPubsub['publish']): OriginalQueue {
  const queues: Record<string, WorkQueue> = {};
  for (const name of ['usersLegacy', 'usersIvm', 'rooms']) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    queues[name] = { pending: [], processing: [], emitter };
  }
  const queueOf = (name: unknown): WorkQueue => {
    const queue = typeof name === 'string' ? own(queues, name) : undefined;
    if (!queue) throw new TypeError("Cannot read properties of undefined (reading 'pending')");
    return queue;
  };
  return {
    fetch: (...args: unknown[]) =>
      respond(() => {
        const [name] = inputs(args);
        const queue = queueOf(name);
        return new Promise<unknown>((resolve) => {
          const check = (): void => {
            if (!queue.pending.length) {
              queue.emitter.once('add', check);
              return;
            }
            const item = queue.pending.pop();
            queue.processing.push(item);
            resolve(item);
          };
          check();
        });
      }),
    markDone: (...args: unknown[]) =>
      respond((): true => {
        const [name, id] = inputs(args);
        const queue = queueOf(name);
        queue.processing = queue.processing.filter((item) => item !== id);
        queue.emitter.emit('done');
        return true;
      }),
    add: (...args: unknown[]) =>
      respond((): true => {
        const [name, id] = inputs(args);
        const queue = queueOf(name);
        queue.pending.push(id);
        queue.emitter.emit('add');
        return true;
      }),
    addMulti: (...args: unknown[]) =>
      respond((): true => {
        const [name, ids] = inputs(args);
        const queue = queueOf(name);
        queue.pending = queue.pending.concat(ids);
        queue.emitter.emit('add');
        return true;
      }),
    whenAllDone: (...args: unknown[]) =>
      respond(() => {
        const [name] = inputs(args);
        const queue = queueOf(name);
        return new Promise<true>((resolve, reject) => {
          const check = (): void => {
            if (queue.pending.length || queue.processing.length) {
              queue.emitter.once('done', check);
              return;
            }
            publish(PUBSUB_KEYS.QUEUE_DONE + String(name), '1').then(
              () => {
                resolve(true);
              },
              (error: unknown) => {
                reject(error instanceof Error ? error : new Error(String(error)));
              },
            );
          };
          check();
        });
      }),
    reset: (...args: unknown[]) =>
      respond((): true => {
        const [name] = inputs(args);
        const queue = queueOf(name);
        queue.pending = [];
        queue.processing = [];
        queue.emitter.emit('done');
        return true;
      }),
  };
}

/**
 * The original `common.storage` object over `context`. Nothing touches `context` before the first
 * call, so a lazily bound context may be supplied. Methods are plain closures (no `this`). Each
 * call is one `context.read` or `context.mutate`; subscriptions follow `context.events` and are
 * delivered asynchronously.
 */
export function createOriginalStorage(
  context: ServerContext,
  options: OriginalStorageOptions = {},
): OriginalStorage {
  const core = new OriginalStorageCore(context);
  const collections = options.collections ?? [...ORIGINAL_DB_COLLECTIONS];
  const db: Record<string, OriginalCollection> = {};
  const connect = (): void => {
    // The live list belongs to mods, which may push anything.
    for (const name of collections as unknown[]) {
      if (typeof name !== 'string' || name === '__proto__' || Object.hasOwn(db, name)) continue;
      db[name] = collectionApi(core, name);
    }
  };
  const publish = (...args: unknown[]): OriginalPromise<undefined> =>
    respond(() => {
      const [channel, data] = inputs(args);
      return core.mutate(async (): Promise<undefined> => {
        await core.publish(String(channel), data);
        return undefined;
      });
    });
  const storage: OriginalStorage = {
    db,
    env: envApi(core),
    pubsub: {
      keys: { ...PUBSUB_KEYS },
      publish,
      subscribe: (channel, listener) => core.subscribe(channel, listener),
    },
    queue: queueApi(publish),
    resetAllData: () =>
      respond(async (): Promise<undefined> => {
        if (!options.resetAllData) throw new Error('resetAllData is not available on this server');
        await options.resetAllData();
        return undefined;
      }),
    _connect: () =>
      respond((): undefined => {
        connect();
        storage._connected = true;
        return undefined;
      }),
    _connected: false,
  };
  connect();
  return storage;
}

/**
 * Validates `ServerState.originalStorage` of an untrusted snapshot: collections hold unique-`_id`
 * documents, names and keys never shadow canonical data, expirations are timestamps.
 */
export function assertOriginalStorageData(value: unknown): asserts value is OriginalStorageData {
  if (
    !isRecord(value) ||
    !isRecord(value.collections) ||
    !isRecord(value.env) ||
    !isRecord(value.expirations)
  ) {
    throw new Error('Invalid original storage data');
  }
  for (const [name, docs] of Object.entries(value.collections)) {
    if (Object.hasOwn(CANONICAL_COLLECTIONS, name) || name === '__proto__') {
      throw new Error(`Invalid original storage collection: ${name} is canonical world data`);
    }
    if (!Array.isArray(docs)) throw new Error(`Invalid original storage collection: ${name}`);
    const ids = new Set<string>();
    for (const doc of docs as unknown[]) {
      if (!isRecord(doc) || (typeof doc._id !== 'string' && !finite(doc._id))) {
        throw new Error(`Invalid original storage document in ${name}`);
      }
      const key = String(doc._id);
      if (ids.has(key)) throw new Error(`Duplicate original storage _id in ${name}: ${key}`);
      ids.add(key);
    }
  }
  for (const name of Object.keys(value.env)) {
    if (
      Object.hasOwn(CANONICAL_ENV_KEYS, name) ||
      CANONICAL_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      throw new Error(`Invalid original storage env key: ${name} is canonical world data`);
    }
  }
  for (const [name, at] of Object.entries(value.expirations)) {
    if (!finite(at)) throw new Error(`Invalid original storage expiration: ${name}`);
  }
}
