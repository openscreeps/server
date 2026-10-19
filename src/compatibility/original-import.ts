/*
 * One-way migration of a pinned original standalone server world (`screeps/storage` LokiJS
 * `db.json`, env included: the original keeps env values in the `env` collection of the same file)
 * into a `ServerState`. The original database upgrades (`upgradeDb`, versions 4..9) run first, so
 * every shipped or saved original world is read in its current original shape; then every
 * persistent record is mapped onto the canonical game, runtime and account records. Data the
 * original server keeps only in process memory (isolate heaps, cron timers, statistics) does not
 * exist in the file and is reported, never invented. Transient bearer tokens are revoked.
 */

import {
  BotRuntime,
  constants as C,
  createWorldState,
  isRecord,
  type CodeBranch,
  type CodeModules,
  type GameState,
  type HistoryFrame,
  type JsonObject,
  type JsonValue,
  type LeaderboardScores,
  type WorldState,
} from '@openscreeps/game';
import type { ServerState, UserMessage, UserProfile } from '../contracts.ts';
import { decodeState } from '../storage.ts';
import type { OriginalStorageData } from './original-storage.ts';

export interface OriginalImportOptions {
  /**
   * Wall clock of the migration (ms): expiry of env values, the version-5 upgrade's order
   * timestamps and accounts whose registration date is missing. Default `Date.now()`.
   */
  now?: number;
  /** Shard name of the imported world; the original database stores none. Default `shard0`. */
  shardName?: string;
  /**
   * Tick duration (ms) when the original env has no `tickRate`; default 1000, the original
   * driver's `mainLoopMinDuration`.
   */
  tickDuration?: number;
  /**
   * The pinned original server has no password sign-in; password hashes come from mods
   * (`users.password`/`salt`) in formats this server cannot verify. Without this flag such accounts
   * reject the import; with it the hashes are dropped (reported) and those players sign in through
   * Steam or set a new password. This server's own `scrypt$…` hashes (written back by its original
   * storage adapter) are always imported as account passwords.
   */
  discardForeignPasswordHashes?: boolean;
  /** Receives the import report once the imported state passed validation. */
  onReport?: (report: OriginalImportReport) => void;
}

export interface OriginalImportReport {
  /** `env.databaseVersion` of the input (`null` when absent: upgraded from before version 4). */
  sourceDatabaseVersion: number | null;
  /** Original `upgradeDb` steps applied before conversion. */
  upgradesApplied: number[];
  /** Imported records by original collection or env key family. */
  counts: Record<string, number>;
  /** Original `auth_*` bearer tokens revoked (never imported). */
  revokedTokens: number;
  /**
   * Players with code: the original keeps their isolate heaps (`global`, module cache) in runtime
   * process memory, which the database never contains, so each starts with a global reset.
   */
  resetHeaps: string[];
  /** Non-portable or derived data intentionally not imported, one line per kind. */
  discarded: string[];
  /** Other facts about the conversion (processing order source, retained compatibility data). */
  notes: string[];
}

type Doc = Record<string, unknown>;
type RuntimeUser = GameState['runtime']['users'][string];

/** Original `config.common.dbCollections` (screeps/common `lib/storage.js`). */
const COMMON_COLLECTIONS: Record<string, true> = {
  'leaderboard.power': true,
  'leaderboard.seasons': true,
  'leaderboard.world': true,
  'users.intents': true,
  'market.orders': true,
  'market.stats': true,
  rooms: true,
  'rooms.objects': true,
  'rooms.flags': true,
  'rooms.intents': true,
  'rooms.terrain': true,
  transactions: true,
  users: true,
  'users.code': true,
  'users.console': true,
  'users.messages': true,
  'users.money': true,
  'users.notifications': true,
  'users.resources': true,
  'users.power_creeps': true,
};

/** Original `common.storage.env.keys` with whole-key values. */
const ENV_KEYS: Record<string, true> = {
  accessibleRooms: true,
  roomStatusData: true,
  gameTime: true,
  terrainData: true,
  mainLoopPaused: true,
  activeRooms: true,
  tickRate: true,
  'roomEventLog:': true,
};
/** Original `common.storage.env.keys` used as key prefixes. */
const ENV_PREFIXES = [
  'memory:',
  'mapView:',
  'scriptCachedData:',
  'userOnline:',
  'roomHistory:',
  'roomVisual:',
  'memorySegments:',
  'publicMemorySegments:',
];
const TOKEN_PREFIX = 'auth_';

/** Account and credential fields of original `users` documents; they become host profiles. */
const PROFILE_FIELDS: Record<string, true> = {
  registeredDate: true,
  email: true,
  emailDirty: true,
  steam: true,
  notifyPrefs: true,
  customBadge: true,
  lastChargeTime: true,
  password: true,
  salt: true,
};
/**
 * Fields of original `users` documents that leave the world document: profile fields, per-player
 * runtime fields (into the runtime snapshot) and the notification schedule (into `jobs`).
 */
const MOVED_USER_FIELDS: Record<string, true> = {
  ...PROFILE_FIELDS,
  activeSegments: true,
  defaultPublicSegment: true,
  activeForeignSegment: true,
  lastNotifyDate: true,
};
/** Runner scheduling telemetry of the original runtime process (`driver/lib/runtime/make.js`). */
const RUNNER_FIELDS: Record<string, true> = {
  lastUsedCpu: true,
  lastUsedDirtyTime: true,
  skipTicksPenalty: true,
};
/** Original `users` fields the canonical world user document knows. */
const WORLD_USER_FIELDS: Record<string, true> = {
  _id: true,
  username: true,
  usernameLower: true,
  cpu: true,
  cpuAvailable: true,
  gcl: true,
  power: true,
  money: true,
  rooms: true,
  active: true,
  bot: true,
  badge: true,
  blocked: true,
  shardAccess: true,
  powerExperimentations: true,
  powerExperimentationTime: true,
  lastRespawnDate: true,
  resources: true,
};
/** `Date.now()`/`new Date()` fields of original `users` documents. */
const USER_DATE_FIELDS: Record<string, true> = {
  lastRespawnDate: true,
  powerExperimentationTime: true,
};

/** Badge the original version-7 upgrade gives the Invader account (storage `lib/db.js`). */
const INVADER_BADGE = {
  type: {
    path1:
      'm 60.493413,13.745781 -1.122536,7.527255 -23.302365,-6.118884 -24.097204,26.333431 6.412507,0.949878 -5.161481,19.706217 26.301441,24.114728 1.116562,-7.546193 23.350173,6.122868 24.097202,-26.318478 -6.462307,-0.95785 5.16845,-19.699243 z m -1.58271,10.611118 -0.270923,1.821013 C 57.330986,25.69819 55.969864,25.331543 54.570958,25.072546 Z m -8.952409,4.554029 c 11.653612,0 21.055294,9.408134 21.055294,21.069735 0,11.661603 -9.401682,21.068738 -21.055294,21.068738 -11.65361,0 -21.055297,-9.407135 -21.055297,-21.068738 0,-11.661601 9.401687,-21.069735 21.055297,-21.069735 z M 26.634018,40.123069 c -0.262324,0.618965 -0.494865,1.252967 -0.708185,1.895768 l -0.0508,-0.104656 -0.194228,-0.417627 c 0.261245,-0.385697 0.631962,-0.909531 0.953211,-1.373485 z m 47.391601,17.714764 0.115539,0.237219 0.214148,0.462479 c -0.380159,0.55986 -0.886342,1.281124 -1.3835,1.988466 0.400298,-0.870957 0.752837,-1.767746 1.053813,-2.688164 z M 41.364458,73.812322 c 0.694434,0.251619 1.40261,0.471895 2.123558,0.662817 l -2.303841,0.558165 z',
    path2:
      'm 60.857962,24.035953 -6.397566,1.055531 c 6.084137,1.084905 11.78633,4.394548 15.786244,9.746957 5.741405,7.682749 6.465607,17.544704 2.736121,25.67958 1.511089,-2.147013 2.622575,-3.851337 2.622575,-3.851337 l 1.628526,0.241209 c 0.726895,-2.869027 1.004942,-5.843252 0.811775,-8.806053 l 1.185288,-8.634615 -3.768025,-3.072898 -2.908435,-3.21842 c -0.0103,-0.01383 -0.01958,-0.02805 -0.02988,-0.04186 -3.118009,-4.172293 -7.17889,-7.228662 -11.666624,-9.098091 z M 50.001124,37.965163 A 12.020784,12.029027 0 0 0 37.979913,49.994617 12.020784,12.029027 0 0 0 50.001124,62.024074 12.020784,12.029027 0 0 0 62.022337,49.994617 12.020784,12.029027 0 0 0 50.001124,37.965163 Z M 27.019485,39.55693 c -1.481686,2.114179 -2.5658,3.779575 -2.5658,3.779575 l -1.647451,-0.244197 c -0.69707,2.775045 -0.977606,5.64628 -0.81476,8.511019 l -1.22015,8.890775 3.768021,3.072896 3.422394,3.786551 c 2.921501,3.715734 6.608397,6.499915 10.668588,8.29872 l 5.050921,-1.223973 C 38.324728,73.038607 33.383805,69.887984 29.806406,65.100956 28.655972,63.561522 27.71377,61.932905 26.961715,60.249903 L 24.8272,48.359991 c 0.194234,-3.030146 0.935183,-6.015406 2.192285,-8.803061 z',
  },
  color1: '#735252',
  color2: '#390305',
  color3: '#ff0d39',
  flip: false,
};

/** Maintenance schedule keys of `GameState.jobs` (game `world/maintenance.ts`). */
const FORCE_UPDATE_JOB = 'forceUpdate:';
const NPC_ORDERS_JOB = 'npcOrders:';
const NOTIFY_JOB = 'notify:';

const LATEST_DATABASE_VERSION = 9;

function fail(message: string): never {
  throw new Error(`Original world import: ${message}`);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function describe(collection: string, doc: Doc): string {
  return `${collection} document ${JSON.stringify(doc._id ?? doc.$loki ?? null)}`;
}

/** The document without LokiJS bookkeeping (`$loki`, `meta`). */
function strip(doc: Doc): Doc {
  const rest = { ...doc };
  delete rest.$loki;
  delete rest.meta;
  return rest;
}

function requireString(collection: string, doc: Doc, field: string): string {
  const value = doc[field];
  if (typeof value !== 'string') fail(`${describe(collection, doc)} needs a string ${field}`);
  return value;
}

function rejectUnknownFields(collection: string, doc: Doc, known: readonly string[]): void {
  const unknown = Object.keys(doc).filter((key) => !known.includes(key));
  if (unknown.length) {
    fail(
      `${describe(collection, doc)} has fields this server cannot represent: ${unknown.join(', ')}`,
    );
  }
}

/**
 * Milliseconds of an original date: Loki writes `Date` values (`new Date()` in the original
 * backend and engine) as ISO strings, `Date.now()` values as numbers.
 */
export function originalTimestamp(value: unknown, what: string): number {
  if (finite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fail(`${what} is not a date: ${JSON.stringify(value)}`);
}

/**
 * Module names as the original runtime sees them (backend `translateModulesFromDb`, driver
 * `runtime/data.js`): `$DOT$`, `$SLASH$` and `$BACKSLASH$` decode to `.`, `/` and `\`, renamed
 * modules move behind the others and a decoded name overwrites an existing module of that name.
 * Values are source text or `{binary: base64}`.
 */
export function decodeOriginalModules(modules: Record<string, unknown>): CodeModules {
  const decoded: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(modules)) decoded[key] = value;
  for (const key of Object.keys(decoded)) {
    if (!Object.hasOwn(decoded, key)) continue;
    const name = key
      .replace(/\$DOT\$/g, '.')
      .replace(/\$SLASH\$/g, '/')
      .replace(/\$BACKSLASH\$/g, '\\');
    if (name !== key) {
      decoded[name] = decoded[key];
      Reflect.deleteProperty(decoded, key);
    }
  }
  const result: CodeModules = {};
  for (const [name, value] of Object.entries(decoded)) {
    if (name === '__proto__') fail('a code module named __proto__ cannot be represented');
    if (typeof value === 'string') {
      result[name] = value;
    } else if (isRecord(value) && typeof value.binary === 'string') {
      result[name] = { binary: value.binary };
    } else {
      fail(`code module ${JSON.stringify(name)} is neither source text nor {binary}`);
    }
  }
  return result;
}

// -------------------------------------------------------------------------------------------------
// LokiJS file

interface Collection {
  name: string;
  data: Doc[];
  adaptive: boolean;
  /** Serialized `binaryIndices.room` (rooms.objects processing order), if any. */
  roomIndex: { dirty: boolean; values: unknown } | undefined;
}

interface Database {
  lokiVersion: number | undefined;
  collections: Map<string, Collection>;
}

function readDatabase(value: unknown): Database {
  if (!isRecord(value) || !Array.isArray(value.collections)) {
    fail(
      'expected the parsed original LokiJS database file (db.json, normal serialization) with a collections array',
    );
  }
  const collections = new Map<string, Collection>();
  for (const entry of value.collections as unknown[]) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !Array.isArray(entry.data)) {
      fail('every LokiJS collection needs a name and a data array');
    }
    if (collections.has(entry.name)) fail(`collection ${entry.name} appears twice`);
    const data = entry.data as unknown[];
    if (!data.every(isRecord)) fail(`collection ${entry.name} contains non-object documents`);
    const indices = isRecord(entry.binaryIndices) ? entry.binaryIndices : {};
    const room = indices.room;
    collections.set(entry.name, {
      name: entry.name,
      data: data,
      adaptive: entry.adaptiveBinaryIndices === true,
      roomIndex: isRecord(room) ? { dirty: room.dirty === true, values: room.values } : undefined,
    });
  }
  return {
    lokiVersion: finite(value.databaseVersion) ? value.databaseVersion : undefined,
    collections,
  };
}

function docs(database: Database, name: string): Doc[] {
  return database.collections.get(name)?.data ?? [];
}

// -------------------------------------------------------------------------------------------------
// Original upgradeDb (screeps/storage lib/db.js)

interface Upgrade {
  sourceVersion: number | null;
  applied: number[];
  /** Data positions of `rooms.objects` documents the upgrade updated, in update order. */
  objectWrites: number[];
  /** Stale version markers must not destroy an already-migrated modern store. */
  retainedStores: number;
}

function upgradeDatabase(database: Database, envData: Doc, now: number): Upgrade {
  const data = envData.data as Doc;
  const source = envData.databaseVersion;
  if (source !== undefined && !finite(source)) {
    fail(`env databaseVersion ${JSON.stringify(source)} is not a number`);
  }
  if (finite(source) && source > LATEST_DATABASE_VERSION) {
    fail(
      `env databaseVersion ${String(source)} is newer than the pinned original storage (${String(LATEST_DATABASE_VERSION)})`,
    );
  }
  const sourceVersion = finite(source) ? source : null;
  const upgrade: Upgrade = { sourceVersion, applied: [], objectWrites: [], retainedStores: 0 };
  const rooms = docs(database, 'rooms');
  const objects = docs(database, 'rooms.objects');
  let version = sourceVersion ?? 0;

  if (!version || version < 4) {
    for (const room of rooms) {
      if (typeof room._id === 'string' && /^[WE][1-9][NS][1-9]$/.test(room._id)) room.bus = false;
    }
    const depositTypes = [
      C.RESOURCE_SILICON,
      C.RESOURCE_METAL,
      C.RESOURCE_BIOMASS,
      C.RESOURCE_MIST,
    ];
    for (const room of rooms) {
      const id = typeof room._id === 'string' ? room._id : '';
      if (!/^[WE]\d*0/.test(id) && !/0$/.test(id)) continue;
      const match = /^[WE](\d+)[NS](\d+)$/.exec(id);
      if (!match) fail(`the version-4 upgrade cannot parse bus room name ${JSON.stringify(id)}`);
      // upstream adds the two coordinate strings: string concatenation, then numeric remainder
      room.depositType = depositTypes[Number(`${match[1] ?? ''}${match[2] ?? ''}`) % 4];
    }
    version = 4;
    upgrade.applied.push(4);
  }

  if (version < 5) {
    const energyOnly = (structure: Doc): void => {
      structure.store = { energy: structure.energy };
      structure.storeCapacityResource = { energy: structure.energyCapacity };
      delete structure.energy;
      delete structure.energyCapacity;
    };
    const storeOnly = (structure: Doc): void => {
      if (structure.energyCapacity !== undefined) {
        structure.storeCapacity = structure.energyCapacity;
        delete structure.energyCapacity;
      }
      const store: Doc = {};
      structure.store = store;
      for (const resource of C.RESOURCES_ALL) {
        if (structure[resource] !== undefined) {
          store[resource] = structure[resource];
          Reflect.deleteProperty(structure, resource);
        }
      }
    };
    const converters: Record<string, (structure: Doc) => void> = {
      spawn: energyOnly,
      extension: energyOnly,
      tower: energyOnly,
      link: energyOnly,
      storage: storeOnly,
      terminal: storeOnly,
      container: storeOnly,
      factory: storeOnly,
      creep: storeOnly,
      powerCreep: storeOnly,
      tombstone: storeOnly,
      nuker: (structure) => {
        structure.store = { energy: structure.energy, G: structure.G };
        structure.storeCapacityResource = {
          energy: structure.energyCapacity,
          G: structure.GCapacity,
        };
        delete structure.energy;
        delete structure.energyCapacity;
        delete structure.G;
        delete structure.GCapacity;
      },
      powerSpawn: (structure) => {
        structure.store = { energy: structure.energy, power: structure.power };
        structure.storeCapacityResource = {
          energy: structure.energyCapacity,
          power: structure.powerCapacity,
        };
        delete structure.energy;
        delete structure.energyCapacity;
        delete structure.power;
        delete structure.powerCapacity;
      },
      lab: (structure) => {
        const store: Doc = { energy: structure.energy };
        const capacity: Doc = { energy: structure.energyCapacity };
        structure.store = store;
        structure.storeCapacityResource = capacity;
        const mineralType = String(structure.mineralType);
        if (structure.mineralType && structure.mineralAmount) {
          store[mineralType] = structure.mineralAmount;
          capacity[mineralType] = structure.mineralCapacity;
        } else {
          // upstream adds possibly missing capacities; NaN is persisted as null
          structure.storeCapacity =
            (structure.energyCapacity as number) + (structure.mineralCapacity as number);
        }
        delete structure.energy;
        delete structure.energyCapacity;
        delete structure.mineralType;
        delete structure.mineralAmount;
        delete structure.mineralCapacity;
      },
    };
    for (const powerCreep of docs(database, 'users.power_creeps')) {
      if (isRecord(powerCreep.store)) upgrade.retainedStores++;
      else storeOnly(powerCreep);
    }
    objects.forEach((object, position) => {
      const type = typeof object.type === 'string' ? object.type : '';
      const convert = Object.hasOwn(converters, type) ? converters[type] : undefined;
      if (!convert) return;
      if (isRecord(object.store)) upgrade.retainedStores++;
      else convert(object);
      upgrade.objectWrites.push(position);
    });
    for (const order of docs(database, 'market.orders')) {
      if (!order.createdTimestamp) order.createdTimestamp = now;
    }
    version = 5;
    upgrade.applied.push(5);
  }

  if (version < 6) {
    objects.forEach((object, position) => {
      if (object.type !== 'powerBank') return;
      if (isRecord(object.store)) upgrade.retainedStores++;
      else object.store = { power: object.power };
      delete object.power;
      upgrade.objectWrites.push(position);
    });
    version = 6;
    upgrade.applied.push(6);
  }

  if (version < 7) {
    const invader = docs(database, 'users').find((user) => user._id === '2');
    if (!invader) fail('the version-7 upgrade needs the Invader account (users _id "2")');
    invader.badge = structuredClone(INVADER_BADGE);
    version = 7;
    upgrade.applied.push(7);
  }

  if (version < 8) {
    const gameTime = Number.parseInt(String(data.gameTime), 10);
    objects.forEach((object, position) => {
      const spawning = object.spawning;
      if (
        (object.type !== 'spawn' && object.type !== 'invaderCore') ||
        !isRecord(spawning) ||
        spawning.remainingTime === undefined
      ) {
        return;
      }
      spawning.spawnTime = gameTime + (spawning.remainingTime as number);
      delete spawning.remainingTime;
      upgrade.objectWrites.push(position);
    });
    version = 8;
    upgrade.applied.push(8);
  }

  if (version < 9) {
    const activeRooms: unknown[] = [];
    for (const room of rooms) {
      if (room.active) activeRooms.push(room._id);
      delete room.active;
    }
    data.activeRooms = activeRooms;
    version = 9;
    upgrade.applied.push(9);
  }
  envData.databaseVersion = version;
  return upgrade;
}

// -------------------------------------------------------------------------------------------------
// rooms.objects processing order

/** Data positions in the order the original `room` index returns them (LokiJS 1.5.6). */
function roomIndexOrder(
  collection: Collection | undefined,
  lokiVersion: number | undefined,
  writes: readonly number[],
  notes: string[],
): number[] {
  const count = collection?.data.length ?? 0;
  const dataOrder = Array.from({ length: count }, (_, position) => position);
  const index = collection?.roomIndex;
  if (!collection || !index) {
    notes.push('rooms.objects has no serialized room index: objects keep their storage order');
    return dataOrder;
  }
  // Loki rebuilds every index of files written before binary index version 1.5.
  if (lokiVersion !== undefined && lokiVersion < 1.5) return dataOrder;
  // Without adaptive indices a dirty index is rebuilt lazily by a stable sort on `room`, which keeps
  // the storage order within a room; updates mark it dirty again.
  if (!collection.adaptive && (index.dirty || writes.length > 0)) return dataOrder;
  const values = index.values;
  const seen = new Set<number>();
  const valid =
    Array.isArray(values) &&
    values.length === count &&
    values.every((value: unknown) => {
      if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= count) {
        return false;
      }
      if (seen.has(value as number)) return false;
      seen.add(value as number);
      return true;
    });
  if (!valid) {
    notes.push(
      'rooms.objects room index is inconsistent with its documents: objects keep their storage order',
    );
    return dataOrder;
  }
  const order = [...(values as number[])];
  // Adaptive indices move an updated document to the front of its room's range.
  for (const position of writes) {
    order.splice(order.indexOf(position), 1);
    const room = collection.data[position]?.room;
    const start = order.findIndex((other) => collection.data[other]?.room === room);
    order.splice(start === -1 ? order.length : start, 0, position);
  }
  return order;
}

// -------------------------------------------------------------------------------------------------
// conversion

function toProfile(
  doc: Doc,
  userId: string,
  now: number,
  options: OriginalImportOptions,
  report: OriginalImportReport,
): UserProfile | undefined {
  if (!Object.keys(PROFILE_FIELDS).some((field) => doc[field] !== undefined)) {
    return undefined;
  }
  const meta = isRecord(doc.meta) ? doc.meta : {};
  let registeredDate: number;
  if (doc.registeredDate !== undefined) {
    registeredDate = originalTimestamp(doc.registeredDate, `users ${userId} registeredDate`);
  } else if (finite(meta.created)) {
    registeredDate = meta.created;
  } else {
    registeredDate = now;
    report.notes.push(`users ${userId} has no registration date; the migration time is used`);
  }
  const profile: UserProfile = { registeredDate };
  if (doc.email !== undefined) profile.email = requireString('users', doc, 'email');
  if (doc.emailDirty !== undefined) profile.emailDirty = requireString('users', doc, 'emailDirty');
  if (doc.notifyPrefs !== undefined) {
    if (!isRecord(doc.notifyPrefs)) fail(`users ${userId} notifyPrefs is not an object`);
    profile.notifyPrefs = doc.notifyPrefs as JsonObject;
  }
  if (doc.customBadge !== undefined) {
    const badge = doc.customBadge;
    if (!isRecord(badge) || typeof badge.path1 !== 'string' || typeof badge.path2 !== 'string') {
      fail(`users ${userId} customBadge needs path1 and path2 strings`);
    }
    profile.customBadge = { path1: badge.path1, path2: badge.path2 };
  }
  if (doc.lastChargeTime !== undefined) {
    profile.lastChargeTime = originalTimestamp(
      doc.lastChargeTime,
      `users ${userId} lastChargeTime`,
    );
  }
  if (doc.steam !== undefined) {
    const steam = doc.steam;
    if (!isRecord(steam) || typeof steam.id !== 'string') {
      fail(`users ${userId} steam needs a string id`);
    }
    rejectUnknownFields(`users ${userId} steam`, steam, [
      'id',
      'displayName',
      'ownership',
      'steamProfileLinkHidden',
    ]);
    const identity: NonNullable<UserProfile['steam']> = { id: steam.id };
    if (steam.displayName !== undefined) {
      if (typeof steam.displayName !== 'string') fail(`users ${userId} steam displayName`);
      identity.displayName = steam.displayName;
    }
    // the original stores Steam API booleans and 0/1 link visibility; the client reads truthiness
    if (steam.ownership !== undefined) identity.ownership = Boolean(steam.ownership);
    if (steam.steamProfileLinkHidden !== undefined) {
      identity.steamProfileLinkHidden = Boolean(steam.steamProfileLinkHidden);
    }
    profile.steam = identity;
  }
  if (
    typeof doc.password === 'string' &&
    doc.password.startsWith('scrypt$') &&
    doc.salt === undefined
  ) {
    // this server's own hash, as its original storage adapter projects `profile.passwordHash`
    profile.passwordHash = doc.password;
  } else if (doc.password !== undefined || doc.salt !== undefined) {
    if (!options.discardForeignPasswordHashes) {
      fail(
        `users ${userId} has a mod password hash (password/salt) this server cannot verify; ` +
          're-run with the option to discard foreign password hashes, then let the player sign in ' +
          'through Steam or set a new password',
      );
    }
    report.discarded.push(
      `users ${userId}: foreign password hash (player must set a new password)`,
    );
  }
  return profile;
}

function parseJson(value: unknown, what: string): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fail(`${what} is not valid JSON`);
  }
}

function count(report: OriginalImportReport, name: string, amount = 1): void {
  report.counts[name] = (report.counts[name] ?? 0) + amount;
}

/**
 * Converts a parsed original standalone database (`db.json` of screeps/storage, LokiJS) into a
 * validated `ServerState` for an empty server database. Throws an actionable error for collections
 * or records it cannot represent instead of dropping them.
 */
export function importOriginalWorld(
  value: unknown,
  options: OriginalImportOptions = {},
): ServerState {
  const now = options.now ?? Date.now();
  const database = readDatabase(structuredClone(value));
  const report: OriginalImportReport = {
    sourceDatabaseVersion: null,
    upgradesApplied: [],
    counts: {},
    revokedTokens: 0,
    resetHeaps: [],
    discarded: [],
    notes: [],
  };

  // --- env (Loki ids 1: values, 2: expirations) -----------------------------------------------
  const envDocs = docs(database, 'env');
  const envData = envDocs.find((doc) => doc.$loki === 1);
  const expirationDoc = envDocs.find((doc) => doc.$loki === 2);
  if (!envData || !isRecord(envData.data)) {
    fail('the env collection has no values document; this is not a started original world');
  }
  if (envDocs.some((doc) => doc !== envData && doc !== expirationDoc)) {
    fail('the env collection has documents other than values ($loki 1) and expirations ($loki 2)');
  }
  const expirations: Record<string, unknown> =
    expirationDoc && isRecord(expirationDoc.data) ? expirationDoc.data : {};

  const upgrade = upgradeDatabase(database, envData, now);
  report.sourceDatabaseVersion = upgrade.sourceVersion;
  report.upgradesApplied = upgrade.applied;
  if (upgrade.retainedStores)
    report.notes.push(
      `Preserved ${String(upgrade.retainedStores)} already-migrated stores despite a stale database version; upstream would overwrite them.`,
    );

  // the original env cleaner deletes expired values; expiration entries of absent values are inert
  const env: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(envData.data as Doc)) {
    const expiry = expirations[key];
    if (key.startsWith(TOKEN_PREFIX)) {
      report.revokedTokens++;
      continue;
    }
    if (finite(expiry) && expiry <= now) {
      report.discarded.push(`env ${key}: expired`);
      continue;
    }
    env[key] = entry;
  }

  const shardName = options.shardName ?? 'shard0';
  const gameTime = Number.parseInt(String(env.gameTime), 10);
  if (!Number.isSafeInteger(gameTime) || gameTime < 0) {
    fail(`env gameTime ${JSON.stringify(env.gameTime)} is not a tick number`);
  }
  const world: WorldState = createWorldState({ gameTime, shardName });
  const runtimeUsers: Record<string, RuntimeUser> = {};
  const runtimeUser = (id: string): RuntimeUser =>
    (runtimeUsers[id] ??= {
      modules: {},
      branch: 'default',
      codeTimestamp: 0,
      memory: '',
      segments: {},
      activeSegments: [],
      consoleCommands: [],
    });
  const profiles: Record<string, UserProfile> = {};
  const jobs: Record<string, number> = {};
  // Loki keeps a unique `_id` index per collection (storage `getOrAddCollection`)
  const claimed: Record<string, Set<string>> = {};
  const claim = (collection: string, doc: Doc): string => {
    const id = doc._id;
    if (typeof id !== 'string' || id === '') fail(`${describe(collection, doc)} has no string _id`);
    const ids = (claimed[collection] ??= new Set<string>());
    if (ids.has(id)) fail(`${collection} has two documents with _id ${JSON.stringify(id)}`);
    ids.add(id);
    return id;
  };

  // --- collections ------------------------------------------------------------------------------
  const keptCollections: Record<string, JsonObject[]> = {};
  for (const collection of database.collections.values()) {
    if (collection.name === 'env' || Object.hasOwn(COMMON_COLLECTIONS, collection.name)) continue;
    if (!collection.data.length) {
      report.notes.push(`empty collection ${collection.name} not kept`);
      continue;
    }
    const ids = new Set<string>();
    keptCollections[collection.name] = collection.data.map((doc) => {
      if ((typeof doc._id !== 'string' || doc._id === '') && !finite(doc._id)) {
        fail(`${describe(collection.name, doc)} has no _id; mod collections need unique ids`);
      }
      if (ids.has(String(doc._id))) {
        fail(`${collection.name} has two documents with _id ${JSON.stringify(doc._id)}`);
      }
      ids.add(String(doc._id));
      return strip(doc) as JsonObject;
    });
    count(report, collection.name, collection.data.length);
    report.notes.push(`collection ${collection.name} kept as original compatibility data`);
  }

  for (const doc of docs(database, 'rooms')) {
    const id = claim('rooms', doc);
    const room = strip(doc);
    for (const [field, job] of [
      ['nextForceUpdateTime', FORCE_UPDATE_JOB],
      ['nextNpcMarketOrder', NPC_ORDERS_JOB],
    ] as const) {
      const next = room[field];
      if (next === undefined || next === null) continue;
      if (!finite(next)) fail(`rooms ${id} ${field} is not a tick number`);
      jobs[job + id] = next;
      Reflect.deleteProperty(room, field);
    }
    world.rooms[id] = room as unknown as WorldState['rooms'][string];
    count(report, 'rooms');
  }

  for (const doc of docs(database, 'rooms.terrain')) {
    claim('rooms.terrain', doc);
    const room = requireString('rooms.terrain', doc, 'room');
    const terrain = requireString('rooms.terrain', doc, 'terrain');
    if (!/^[0-3]{2500}$/.test(terrain)) fail(`rooms.terrain of ${room} is not a 50x50 terrain`);
    if (Object.hasOwn(world.terrain, room)) fail(`rooms.terrain has two documents for ${room}`);
    world.terrain[room] = terrain;
    count(report, 'rooms.terrain');
  }
  for (const room of Object.keys(world.rooms)) {
    if (!Object.hasOwn(world.terrain, room)) fail(`room ${room} has no rooms.terrain document`);
  }

  const objectDocs = docs(database, 'rooms.objects');
  for (const doc of objectDocs) {
    const id = claim('rooms.objects', doc);
    requireString('rooms.objects', doc, 'type');
    requireString('rooms.objects', doc, 'room');
    for (const axis of ['x', 'y']) {
      const coordinate = doc[axis];
      if (
        !Number.isInteger(coordinate) ||
        (coordinate as number) < 0 ||
        (coordinate as number) > 49
      ) {
        fail(`${describe('rooms.objects', doc)} has no room position`);
      }
    }
    world.roomObjects[id] = strip(doc) as unknown as WorldState['roomObjects'][string];
  }
  count(report, 'rooms.objects', objectDocs.length);
  const order = roomIndexOrder(
    database.collections.get('rooms.objects'),
    database.lokiVersion,
    upgrade.objectWrites,
    report.notes,
  );
  // the engine processes a room's objects in descending write sequence: the first one the original
  // room index returns gets the highest sequence
  const writeSeq: Record<string, number> = {};
  order.forEach((position, rank) => {
    writeSeq[objectDocs[position]?._id as string] = order.length - rank;
  });
  world.roomObjectWriteSeq = writeSeq;
  world.writeSeq = order.length;

  for (const doc of docs(database, 'rooms.flags')) {
    const id = claim('rooms.flags', doc);
    for (const field of ['user', 'room', 'data']) requireString('rooms.flags', doc, field);
    rejectUnknownFields('rooms.flags', doc, ['_id', 'user', 'room', 'data', '$loki', 'meta']);
    world.flags[id] = strip(doc) as unknown as WorldState['flags'][string];
    count(report, 'rooms.flags');
  }

  // users: world document, host profile, runtime fields
  const discardedRunnerFields = new Set<string>();
  const retainedUserFields = new Set<string>();
  for (const doc of docs(database, 'users')) {
    const id = claim('users', doc);
    const profile = toProfile(doc, id, now, options, report);
    if (profile) profiles[id] = profile;
    if (doc.lastNotifyDate !== undefined && doc.lastNotifyDate !== null) {
      jobs[NOTIFY_JOB + id] = originalTimestamp(doc.lastNotifyDate, `users ${id} lastNotifyDate`);
    }
    if (doc.activeSegments !== undefined) {
      const segments = doc.activeSegments;
      if (!Array.isArray(segments) || !segments.every((s: unknown) => Number.isSafeInteger(s))) {
        fail(`users ${id} activeSegments is not a list of segment ids`);
      }
      runtimeUser(id).activeSegments = segments as number[];
    }
    if (doc.defaultPublicSegment !== undefined) {
      const segment = doc.defaultPublicSegment;
      if (segment !== null && !finite(segment)) fail(`users ${id} defaultPublicSegment`);
      runtimeUser(id).defaultPublicSegment = segment;
    }
    if (doc.activeForeignSegment !== undefined && doc.activeForeignSegment !== null) {
      const foreign = doc.activeForeignSegment;
      if (
        !isRecord(foreign) ||
        typeof foreign.username !== 'string' ||
        (foreign.user_id !== undefined && typeof foreign.user_id !== 'string') ||
        (foreign.id !== undefined && !finite(foreign.id))
      ) {
        fail(`users ${id} activeForeignSegment needs a username, optional user_id and id`);
      }
      const selection: NonNullable<RuntimeUser['activeForeignSegment']> = {
        username: foreign.username,
      };
      if (typeof foreign.user_id === 'string') selection.userId = foreign.user_id;
      if (finite(foreign.id)) selection.id = foreign.id;
      runtimeUser(id).activeForeignSegment = selection;
    }
    const user: Doc = {};
    for (const [field, entry] of Object.entries(strip(doc))) {
      if (Object.hasOwn(MOVED_USER_FIELDS, field)) continue;
      if (Object.hasOwn(RUNNER_FIELDS, field)) {
        discardedRunnerFields.add(field);
        continue;
      }
      if (!Object.hasOwn(WORLD_USER_FIELDS, field)) retainedUserFields.add(field);
      user[field] =
        Object.hasOwn(USER_DATE_FIELDS, field) && typeof entry === 'string'
          ? originalTimestamp(entry, `users ${id} ${field}`)
          : entry;
    }
    world.users[id] = user as unknown as WorldState['users'][string];
    count(report, 'users');
  }
  if (discardedRunnerFields.size) {
    report.discarded.push(
      `users ${[...discardedRunnerFields].join(', ')}: original runner scheduling telemetry`,
    );
  }
  if (retainedUserFields.size) {
    report.notes.push(
      `unrecognized users fields kept on world user documents: ${[...retainedUserFields].join(', ')}`,
    );
  }

  // code branches; the world branch is the runtime code (driver `runtime/data.js`)
  const branches: Record<string, CodeBranch> = {};
  const worldBranchUsers = new Set<string>();
  for (const doc of docs(database, 'users.code')) {
    const id = claim('users.code', doc);
    rejectUnknownFields('users.code', doc, [
      '_id',
      'user',
      'branch',
      'modules',
      'timestamp',
      'activeWorld',
      'activeSim',
      '$loki',
      'meta',
    ]);
    const user = requireString('users.code', doc, 'user');
    const branch: CodeBranch = {
      _id: id,
      user,
      branch: requireString('users.code', doc, 'branch'),
      modules: isRecord(doc.modules)
        ? decodeOriginalModules(doc.modules)
        : fail(`${describe('users.code', doc)} has no modules`),
    };
    for (const flag of ['activeWorld', 'activeSim'] as const) {
      const active = doc[flag];
      if (active === undefined) continue;
      if (typeof active !== 'boolean')
        fail(`${describe('users.code', doc)} ${flag} is not boolean`);
      branch[flag] = active;
    }
    if (doc.timestamp !== undefined && doc.timestamp !== null) {
      branch.timestamp = originalTimestamp(
        doc.timestamp,
        `${describe('users.code', doc)} timestamp`,
      );
    }
    if (branch.activeWorld) {
      if (worldBranchUsers.has(user))
        fail(`user ${user} has more than one activeWorld code branch`);
      worldBranchUsers.add(user);
      const runtime = runtimeUser(user);
      runtime.modules = structuredClone(branch.modules);
      runtime.branch = branch.branch;
      runtime.codeTimestamp = branch.timestamp ?? 0;
    }
    branches[id] = branch;
    count(report, 'users.code');
  }

  for (const doc of docs(database, 'users.console')) {
    claim('users.console', doc);
    rejectUnknownFields('users.console', doc, [
      '_id',
      'user',
      'expression',
      'hidden',
      '$loki',
      'meta',
    ]);
    const command: RuntimeUser['consoleCommands'][number] = {
      expression: requireString('users.console', doc, 'expression'),
    };
    if (doc.hidden) command.hidden = true;
    runtimeUser(requireString('users.console', doc, 'user')).consoleCommands.push(command);
    count(report, 'users.console');
  }

  const messages: Record<string, UserMessage> = {};
  for (const doc of docs(database, 'users.messages')) {
    const id = claim('users.messages', doc);
    rejectUnknownFields('users.messages', doc, [
      '_id',
      'user',
      'respondent',
      'date',
      'type',
      'text',
      'unread',
      'outMessage',
      '$loki',
      'meta',
    ]);
    if ((doc.type !== 'in' && doc.type !== 'out') || typeof doc.unread !== 'boolean') {
      fail(`${describe('users.messages', doc)} needs type in/out and a boolean unread`);
    }
    const message: UserMessage = {
      _id: id,
      user: requireString('users.messages', doc, 'user'),
      respondent: requireString('users.messages', doc, 'respondent'),
      date: originalTimestamp(doc.date, describe('users.messages', doc)),
      type: doc.type,
      text: requireString('users.messages', doc, 'text'),
      unread: doc.unread,
    };
    if (doc.outMessage !== undefined) {
      message.outMessage = requireString('users.messages', doc, 'outMessage');
    }
    messages[id] = message;
    count(report, 'users.messages');
  }

  for (const doc of docs(database, 'users.notifications')) {
    const id = claim('users.notifications', doc);
    for (const field of ['user', 'message', 'type'])
      requireString('users.notifications', doc, field);
    if (!finite(doc.count)) fail(`${describe('users.notifications', doc)} has no count`);
    const notification = strip(doc);
    notification.date = originalTimestamp(doc.date, describe('users.notifications', doc));
    world.notifications[id] = notification as unknown as WorldState['notifications'][string];
    count(report, 'users.notifications');
  }

  const datedCollections = [
    ['users.money', 'usersMoney', 'date'],
    ['users.resources', 'usersResources', 'date'],
  ] as const;
  for (const [name, target, dateField] of datedCollections) {
    for (const doc of docs(database, name)) {
      const id = claim(name, doc);
      const entry = strip(doc);
      entry[dateField] = originalTimestamp(doc[dateField], describe(name, doc));
      (world[target] as Record<string, unknown>)[id] = entry;
      count(report, name);
    }
  }
  const plainCollections = [
    ['users.power_creeps', 'userPowerCreeps'],
    ['market.orders', 'marketOrders'],
    ['market.stats', 'marketStats'],
    ['transactions', 'transactions'],
  ] as const;
  for (const [name, target] of plainCollections) {
    for (const doc of docs(database, name)) {
      const id = claim(name, doc);
      (world[target] as Record<string, unknown>)[id] = strip(doc);
      count(report, name);
    }
  }

  // leaderboard scores; ranks are derived from scores
  const leaderboard: Record<string, Record<string, LeaderboardScores>> = {};
  for (const [name, mode] of [
    ['leaderboard.world', 'world'],
    ['leaderboard.power', 'power'],
  ] as const) {
    const seen = new Set<string>();
    for (const doc of docs(database, name)) {
      claim(name, doc);
      const season = requireString(name, doc, 'season');
      const user = requireString(name, doc, 'user');
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(season) || !finite(doc.score)) {
        fail(`${describe(name, doc)} needs a YYYY-MM season and a numeric score`);
      }
      if (seen.has(`${season}/${user}`)) fail(`${name} scores ${user} twice in ${season}`);
      seen.add(`${season}/${user}`);
      const scores = (leaderboard[season] ??= {});
      const entry = (scores[user] ??= { world: 0, power: 0 });
      entry[mode] = doc.score;
      count(report, name);
    }
  }
  const seasons = docs(database, 'leaderboard.seasons');
  if (seasons.length) {
    keptCollections['leaderboard.seasons'] = seasons.map((doc) => {
      claim('leaderboard.seasons', doc);
      return strip(doc) as JsonObject;
    });
    count(report, 'leaderboard.seasons', seasons.length);
  }

  // pending intents: manual room intents and global intents await the next tick
  const pendingIntents: Record<string, Record<string, Record<string, JsonObject>>> = {};
  let interruptedIntents = 0;
  for (const doc of docs(database, 'rooms.intents')) {
    claim('rooms.intents', doc);
    const room = requireString('rooms.intents', doc, 'room');
    if (Object.hasOwn(pendingIntents, room)) fail(`rooms.intents has two documents for ${room}`);
    if (!isRecord(doc.users)) fail(`${describe('rooms.intents', doc)} has no users`);
    for (const [userId, intents] of Object.entries(doc.users)) {
      if (!isRecord(intents)) fail(`rooms.intents ${room} user ${userId} is not an object`);
      rejectUnknownFields(`rooms.intents ${room} user ${userId}`, intents, [
        'objects',
        'objectsManual',
      ]);
      if (isRecord(intents.objects)) interruptedIntents += Object.keys(intents.objects).length;
      if (intents.objectsManual === undefined) continue;
      const manual = intents.objectsManual;
      if (!isRecord(manual) || !Object.values(manual).every(isRecord)) {
        fail(`rooms.intents ${room} user ${userId} objectsManual is not a map of intents`);
      }
      (pendingIntents[room] ??= {})[userId] = manual as Record<string, JsonObject>;
      count(report, 'rooms.intents');
    }
  }
  if (interruptedIntents) {
    report.discarded.push(
      `rooms.intents: script intents of ${String(interruptedIntents)} objects from an interrupted tick (players re-run that tick)`,
    );
  }
  const pendingGlobalIntents: Record<string, Record<string, JsonObject[]>> = {};
  for (const doc of docs(database, 'users.intents')) {
    claim('users.intents', doc);
    const user = requireString('users.intents', doc, 'user');
    if (!isRecord(doc.intents)) fail(`${describe('users.intents', doc)} has no intents`);
    for (const [name, list] of Object.entries(doc.intents)) {
      if (!Array.isArray(list) || !list.every(isRecord)) {
        fail(`${describe('users.intents', doc)} intent ${name} is not a list of objects`);
      }
      ((pendingGlobalIntents[user] ??= {})[name] ??= []).push(...(list as JsonObject[]));
    }
    count(report, 'users.intents');
  }

  // --- env values -------------------------------------------------------------------------------
  const keptEnv: Record<string, JsonValue> = {};
  const keptExpirations: Record<string, number> = {};
  const derived = new Set<string>();
  let paused = false;
  let tickDuration = options.tickDuration ?? 1000;
  const history: Record<string, HistoryFrame[]> = {};
  for (const [key, entry] of Object.entries(env)) {
    const prefix = ENV_PREFIXES.find((candidate) => key.startsWith(candidate));
    if (!prefix && !Object.hasOwn(ENV_KEYS, key)) {
      keptEnv[key] = entry as JsonValue;
      const expiry = expirations[key];
      if (finite(expiry)) keptExpirations[key] = expiry;
      continue;
    }
    const suffix = prefix ? key.slice(prefix.length) : '';
    switch (prefix ?? key) {
      case 'gameTime':
        break;
      case 'activeRooms':
        if (!Array.isArray(entry) || !entry.every((room: unknown) => typeof room === 'string')) {
          fail('env activeRooms is not a list of room names');
        }
        world.activeRooms = entry;
        break;
      case 'mainLoopPaused':
        paused = Boolean(Number(entry));
        break;
      case 'tickRate': {
        const rate = Number(entry);
        if (!Number.isFinite(rate) || rate < 1) fail(`env tickRate ${JSON.stringify(entry)}`);
        tickDuration = rate;
        break;
      }
      case 'roomEventLog:':
        if (!isRecord(entry)) fail('env roomEventLog: is not a hash');
        for (const [room, log] of Object.entries(entry)) {
          const events = parseJson(log, `env roomEventLog: ${room}`);
          if (
            !Array.isArray(events) ||
            !events.every(
              (event): event is WorldState['roomEventLogs'][string][number] =>
                isRecord(event) &&
                typeof event.event === 'number' &&
                typeof event.objectId === 'string' &&
                (event.data === undefined || isRecord(event.data)),
            )
          ) {
            fail(`env roomEventLog: ${room} is not an event list`);
          }
          world.roomEventLogs[room] = events;
          count(report, 'env roomEventLog:');
        }
        break;
      case 'accessibleRooms':
      case 'roomStatusData':
      case 'terrainData':
      case 'scriptCachedData:':
        derived.add(prefix ?? key);
        break;
      case 'roomVisual:':
        derived.add('roomVisual:');
        break;
      case 'memory:':
        if (typeof entry !== 'string') fail(`env ${key} is not a string`);
        runtimeUser(suffix).memory = entry;
        count(report, 'env memory:');
        break;
      case 'memorySegments:': {
        if (!isRecord(entry)) fail(`env ${key} is not a hash`);
        const segments = runtimeUser(suffix).segments;
        for (const [segment, data] of Object.entries(entry)) {
          if (!/^\d+$/.test(segment) || Number(segment) > 99 || typeof data !== 'string') {
            fail(`env ${key} segment ${segment} is not a string in segments 0..99`);
          }
          segments[Number(segment)] = data;
          count(report, 'env memorySegments:');
        }
        break;
      }
      case 'publicMemorySegments:':
        if (typeof entry !== 'string') fail(`env ${key} is not a segment id list`);
        runtimeUser(suffix).publicSegments = entry;
        break;
      case 'mapView:': {
        const view = parseJson(entry, `env ${key}`);
        if (!isRecord(view)) fail(`env ${key} is not a map view`);
        world.mapViews[suffix] = view as WorldState['mapViews'][string];
        count(report, 'env mapView:');
        break;
      }
      case 'userOnline:': {
        const online = Number(entry);
        if (!Number.isFinite(online)) fail(`env ${key} is not a timestamp`);
        const profile = profiles[suffix];
        if (profile) {
          profile.lastOnline = online;
        } else {
          // presence of a player without an account profile (e.g. a bot) stays original data
          keptEnv[key] = entry as JsonValue;
          const expiry = expirations[key];
          if (finite(expiry)) keptExpirations[key] = expiry;
        }
        break;
      }
      case 'roomHistory:': {
        if (!isRecord(entry)) fail(`env ${key} is not a hash`);
        const frames: HistoryFrame[] = Object.entries(entry).map(([time, data]) => {
          const objects = parseJson(data, `env ${key} tick ${time}`);
          if (
            !/^\d+$/.test(time) ||
            !isRecord(objects) ||
            !Object.values(objects).every(isRecord)
          ) {
            fail(`env ${key} tick ${time} is not a history frame`);
          }
          return { time: Number(time), objects };
        });
        frames.sort((a, b) => a.time - b.time);
        if (frames.length) history[suffix] = frames;
        count(report, 'env roomHistory:', frames.length);
        break;
      }
    }
  }
  for (const name of derived) {
    report.discarded.push(
      name === 'roomVisual:'
        ? 'env roomVisual:*: per-tick room visuals (expire within the original main loop reset interval)'
        : `env ${name}: derived cache, recomputed from the world`,
    );
  }

  // --- runtime ------------------------------------------------------------------------------------
  const blank = new BotRuntime();
  let runtime: GameState['runtime'];
  try {
    runtime = blank.snapshot();
  } finally {
    blank.dispose();
  }
  runtime.users = runtimeUsers;
  runtime.lastCodeTimestamp = Math.max(
    0,
    ...Object.values(runtimeUsers).map((user) => user.codeTimestamp),
  );
  report.resetHeaps = Object.keys(runtimeUsers).filter(
    (id) => Object.keys(runtimeUsers[id]?.modules ?? {}).length > 0,
  );
  report.discarded.push(
    'player isolate heaps (global objects, module cache) and original cron timers live only in original process memory; players start with a global reset and maintenance jobs run on the first tick',
  );
  report.notes.push(
    'room statistics are not persisted by the original server (driver roomsStatsSave is empty); statistics start empty',
    `rooms.objects processing order reproduced from the original ${database.collections.get('rooms.objects')?.adaptive ? 'adaptive' : 'lazily rebuilt'} room index`,
  );

  // --- result -------------------------------------------------------------------------------------
  const state: ServerState = {
    version: 1,
    world,
    runtime,
    branches,
    history,
    statistics: [],
    leaderboard,
    jobs,
    pendingIntents: pendingIntents,
    pendingGlobalIntents: pendingGlobalIntents,
    profiles,
    tokens: {},
    apiTokens: {},
    messages,
    notificationOutbox: [],
    paused,
    tickDuration,
  };
  if (
    Object.keys(keptCollections).length ||
    Object.keys(keptEnv).length ||
    Object.keys(keptExpirations).length
  ) {
    const originalStorage: OriginalStorageData = {
      collections: keptCollections,
      env: keptEnv,
      expirations: keptExpirations,
    };
    state.originalStorage = originalStorage;
    count(report, 'env (compatibility)', Object.keys(keptEnv).length);
  }
  const validated = decodeState(JSON.stringify(state));
  options.onReport?.(report);
  return validated;
}
