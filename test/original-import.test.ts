import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runJob } from '@openscreeps/game';
import {
  decodeOriginalModules,
  importOriginalWorld,
  type OriginalImportOptions,
  type OriginalImportReport,
} from '../src/compatibility/original-import.ts';
import { createConfig } from '../src/config.ts';
import type { ServerState } from '../src/contracts.ts';
import { ServerKernel } from '../src/services/server-kernel.service.ts';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
/** Pinned original databases: the launcher's shipped world and storage's reset world. */
const LAUNCHER_DB = new URL('../.reference/launcher/init_dist/db.json', import.meta.url);
const STORAGE_DB = new URL('../.reference/storage/db.original.json', import.meta.url);
const missingReference =
  existsSync(LAUNCHER_DB) && existsSync(STORAGE_DB)
    ? false
    : 'pinned original sources (.reference) are not checked out';

type Doc = Record<string, unknown>;
/** The parts of a LokiJS database file the tests read or build. */
interface LokiFile {
  databaseVersion?: number;
  collections: Array<{ name: string; data: Doc[]; [setting: string]: unknown }>;
}

function loadJson(url: URL): LokiFile {
  return JSON.parse(readFileSync(url, 'utf8')) as LokiFile;
}

function collection(db: LokiFile, name: string): Doc[] {
  return db.collections.find((entry) => entry.name === name)?.data ?? [];
}

function importWithReport(
  value: unknown,
  options: OriginalImportOptions = {},
): { state: ServerState; report: OriginalImportReport } {
  let report: OriginalImportReport | undefined;
  const state = importOriginalWorld(value, {
    now: NOW,
    ...options,
    onReport: (received) => (report = received),
  });
  assert.ok(report);
  return { state, report };
}

/** Ids of a room's objects in engine processing order (descending write sequence). */
function processingOrder(state: ServerState, room: string): string[] {
  const seq = state.world.roomObjectWriteSeq ?? {};
  return Object.values(state.world.roomObjects)
    .filter((object) => object.room === room)
    .map((object) => object._id)
    .sort((a, b) => (seq[b] ?? 0) - (seq[a] ?? 0));
}

void it(
  'imports the shipped launcher world and ticks it on the server',
  { skip: missingReference },
  async () => {
    const db = loadJson(LAUNCHER_DB);
    const { state, report } = importWithReport(db);

    assert.equal(report.sourceDatabaseVersion, 7);
    assert.deepEqual(report.upgradesApplied, [8, 9]);
    assert.equal(Object.keys(state.world.rooms).length, 121);
    assert.equal(Object.keys(state.world.terrain).length, 121);
    assert.equal(Object.keys(state.world.roomObjects).length, 339);
    assert.equal(Object.keys(state.world.users).length, 7);
    assert.equal(Object.keys(state.branches).length, 4);
    assert.equal(Object.keys(state.world.mapViews).length, 121);
    assert.equal(state.world.gameTime, 1);
    assert.deepEqual(
      state.world.activeRooms,
      collection(db, 'rooms')
        .filter((room) => room.active)
        .map((room) => room._id),
    );
    assert.equal(state.paused, false);
    assert.equal(state.tickDuration, 1000);
    assert.deepEqual(state.tokens, {});

    // version 9 moves room activity into env; rooms keep their Loki fields minus bookkeeping
    const room = state.world.rooms.W10N10;
    assert.ok(room);
    assert.equal(Reflect.get(room, 'active'), undefined);
    assert.equal(Reflect.get(room, '$loki'), undefined);
    assert.equal(Reflect.get(room, 'meta'), undefined);
    assert.equal(room.depositType, 'biomass');
    assert.equal(state.jobs['forceUpdate:W10N10'], 98);

    // module keys decoded, world branch is the runtime code, memory from env
    const emma = '17c332744f825c7';
    const runtime = state.runtime.users[emma];
    assert.ok(runtime);
    assert.equal(runtime.branch, 't1479132578262');
    assert.equal(runtime.codeTimestamp, 1479132578262);
    assert.equal(runtime.memory, '{}');
    assert.ok(Object.hasOwn(runtime.modules, 'role.builder'));
    assert.ok(!Object.hasOwn(runtime.modules, 'role$DOT$builder'));
    assert.deepEqual(report.resetHeaps.sort(), [
      '17c332744f825c7',
      'a1123272b261687',
      'e3b732c504eb83a',
      'eea532c5a2f9e44',
    ]);

    // Loki Date values become epoch milliseconds; only accounts get profiles
    assert.equal(
      state.profiles.a1123272b261687?.registeredDate,
      Date.parse('2016-11-14T14:04:21.156Z'),
    );
    assert.equal(state.profiles['2'], undefined);
    const importedUser = state.world.users.a1123272b261687;
    assert.ok(importedUser);
    assert.equal(Reflect.get(importedUser, 'registeredDate'), undefined);
    assert.equal(state.world.users.a1123272b261687?.active, true);

    // non-adaptive dirty room index: Loki rebuilds it with a stable sort, so storage order per room
    const stored = collection(db, 'rooms.objects')
      .filter((object) => object.room === 'W9N9')
      .map((object) => object._id);
    assert.deepEqual(processingOrder(state, 'W9N9'), stored);

    const kernel = await ServerKernel.create(createConfig({ database: ':memory:', paused: true }), {
      state,
      now: () => NOW,
    });
    try {
      const tick = await kernel.step();
      assert.deepEqual(tick.maintenance.errors, []);
      assert.equal(kernel.state.world.gameTime, 2);
      for (const userId of report.resetHeaps) {
        const result = tick.runtime.users[userId];
        assert.ok(result, userId);
        assert.equal(result.reset, true);
      }
    } finally {
      await kernel.close();
    }
  },
);

void it(
  'upgrades the storage reset world from database version 4.1',
  { skip: missingReference },
  () => {
    const db = loadJson(STORAGE_DB);
    const { state, report } = importWithReport(db);
    assert.equal(report.sourceDatabaseVersion, 4.1);
    assert.deepEqual(report.upgradesApplied, [5, 6, 7, 8, 9]);
    const spawn = Object.values(state.world.roomObjects).find((object) => object.type === 'spawn');
    assert.ok(spawn);
    assert.deepEqual(spawn.store, { energy: 300 });
    assert.deepEqual(spawn.storeCapacityResource, { energy: 300 });
    assert.equal(Reflect.get(spawn, 'energy'), undefined);
    const invader = state.world.users['2'];
    const launcherInvader = loadJson(LAUNCHER_DB)
      .collections.find((entry) => entry.name === 'users')
      ?.data.find((user) => user._id === '2');
    assert.deepEqual(invader?.badge, launcherInvader?.badge);
    assert.equal(state.world.rooms.W10N10?.powerBankTime, 40285);
    // version-5 store writes mark the lazily rebuilt index dirty: storage order per room
    const stored = collection(db, 'rooms.objects')
      .filter((object) => object.room === 'W9N9')
      .map((object) => object._id);
    assert.deepEqual(processingOrder(state, 'W9N9'), stored);
  },
);

const PLAIN_TERRAIN = '0'.repeat(2500);

/** A populated original world (database version 9) touching every persistent record family. */
function populatedWorld(): LokiFile {
  const loki = (docs: Doc[]): Doc[] =>
    docs.map((doc, i) => ({ ...doc, $loki: i + 1, meta: { created: 1600000000000 + i } }));
  return {
    databaseVersion: 1.5,
    collections: [
      {
        name: 'env',
        data: [
          {
            $loki: 1,
            databaseVersion: 9,
            data: {
              gameTime: '500',
              mainLoopPaused: '1',
              tickRate: 250,
              activeRooms: ['W2N2', 'W1N1'],
              'memory:u1': '{"a":1}',
              'memorySegments:u1': { '3': 'segment three' },
              'publicMemorySegments:u1': '3',
              'userOnline:u1': NOW - 1000,
              'mapView:W1N1': '{"w":[[1,1]]}',
              'roomEventLog:': { W1N1: '[{"event":1,"objectId":"a"}]' },
              'roomHistory:W1N1': {
                '499': '{"a":{"_id":"a","type":"source","room":"W1N1","x":1,"y":1}}',
                '498': '{}',
              },
              auth_0123: 'u1',
              'roomVisual:u1,W1N1,499': 'visual',
              accessibleRooms: '["W1N1"]',
              terrainData: 'cache',
              modKey: { a: 1 },
              modExpiring: 'kept',
              modExpired: 'gone',
            },
          },
          {
            $loki: 2,
            data: { auth_0123: NOW + 60000, modExpiring: NOW + 60000, modExpired: NOW - 1 },
          },
        ],
      },
      {
        name: 'rooms',
        data: loki([
          { _id: 'W1N1', status: 'normal', nextForceUpdateTime: 600, nextNpcMarketOrder: 700 },
          { _id: 'W2N2', status: 'normal' },
        ]),
      },
      {
        name: 'rooms.terrain',
        data: loki([
          { _id: 't1', room: 'W1N1', type: 'terrain', terrain: PLAIN_TERRAIN },
          { _id: 't2', room: 'W2N2', type: 'terrain', terrain: PLAIN_TERRAIN },
        ]),
      },
      {
        name: 'rooms.objects',
        adaptiveBinaryIndices: true,
        binaryIndices: { room: { name: 'room', dirty: false, values: [2, 0, 1, 3] } },
        data: loki([
          { _id: 'a', type: 'source', room: 'W1N1', x: 1, y: 1, energy: 3000 },
          { _id: 'b', type: 'controller', room: 'W1N1', x: 2, y: 2, user: 'u1', level: 1 },
          { _id: 'c', type: 'mineral', room: 'W1N1', x: 3, y: 3, mineralType: 'H' },
          { _id: 'd', type: 'source', room: 'W2N2', x: 4, y: 4 },
        ]),
      },
      {
        name: 'rooms.flags',
        data: loki([{ _id: 'f1', user: 'u1', room: 'W1N1', data: 'Flag1~1~1~10~10' }]),
      },
      {
        name: 'users',
        data: loki([
          {
            _id: 'u1',
            username: 'Alice',
            usernameLower: 'alice',
            cpu: 100,
            cpuAvailable: 5000,
            gcl: 1000,
            money: 5000,
            active: 10000,
            registeredDate: '2020-01-02T03:04:05.000Z',
            email: 'alice@example.com',
            notifyPrefs: { interval: 5 },
            steam: { id: '7656', displayName: 'alice', steamProfileLinkHidden: 1 },
            lastNotifyDate: NOW - 5000,
            activeSegments: [3],
            defaultPublicSegment: 3,
            activeForeignSegment: { username: 'Bob', user_id: 'u2', id: 5 },
            lastUsedCpu: 4,
            lastUsedDirtyTime: 6,
            lastRespawnDate: 1600000000000,
            credits: 0,
          },
          { _id: 'u2', username: 'Bob', usernameLower: 'bob', cpu: 100, gcl: 0 },
        ]),
      },
      {
        name: 'users.code',
        data: loki([
          {
            _id: 'code1',
            user: 'u1',
            branch: 'default',
            activeWorld: true,
            activeSim: false,
            timestamp: '2020-01-03T00:00:00.000Z',
            modules: {
              main: 'module.exports.loop = function () {};',
              lib$DOT$util: 'u',
              dir$SLASH$file: 'f',
              win$BACKSLASH$path: 'w',
              wasm: { binary: 'AGFzbQ==' },
            },
          },
          {
            _id: 'code2',
            user: 'u1',
            branch: 'sim',
            activeSim: true,
            timestamp: 1500,
            modules: { main: '' },
          },
        ]),
      },
      {
        name: 'users.console',
        data: loki([{ _id: 'c1', user: 'u1', expression: 'Game.time', hidden: true }]),
      },
      {
        name: 'users.messages',
        data: loki([
          {
            _id: 'm1',
            user: 'u1',
            respondent: 'u2',
            date: '2020-02-01T00:00:00.000Z',
            type: 'out',
            text: 'hi',
            unread: true,
          },
          {
            _id: 'm2',
            user: 'u2',
            respondent: 'u1',
            date: '2020-02-01T00:00:00.000Z',
            type: 'in',
            text: 'hi',
            unread: true,
            outMessage: 'm1',
          },
        ]),
      },
      {
        name: 'users.notifications',
        data: loki([
          { _id: 'n1', user: 'u1', message: 'attacked', date: NOW - 10, type: 'msg', count: 2 },
        ]),
      },
      {
        name: 'users.money',
        data: loki([
          {
            _id: 'mo1',
            user: 'u1',
            date: '2020-03-01T00:00:00.000Z',
            tick: 400,
            type: 'market.sell',
            balance: 5,
            change: 1,
            market: {},
          },
        ]),
      },
      {
        name: 'users.resources',
        data: loki([
          {
            _id: 'r1',
            user: 'u1',
            date: '2020-03-02T00:00:00.000Z',
            resourceType: 'pixel',
            change: 1,
          },
        ]),
      },
      {
        name: 'users.power_creeps',
        data: loki([
          {
            _id: 'pc1',
            user: 'u1',
            name: 'pc',
            className: 'operator',
            level: 0,
            hitsMax: 1000,
            store: {},
            storeCapacity: 100,
            spawnCooldownTime: null,
            powers: {},
          },
        ]),
      },
      {
        name: 'market.orders',
        data: loki([
          {
            _id: 'o1',
            type: 'sell',
            resourceType: 'H',
            price: 1000,
            amount: 10,
            remainingAmount: 10,
            active: true,
            roomName: 'W1N1',
            createdTimestamp: 1,
          },
        ]),
      },
      {
        name: 'market.stats',
        data: loki([
          {
            _id: 's1',
            resourceType: 'H',
            date: '2020-03-01',
            transactions: 1,
            volume: 10,
            avgPrice: 1,
            stddevPrice: 0,
          },
        ]),
      },
      {
        name: 'transactions',
        data: loki([
          {
            _id: 'tr1',
            time: 450,
            sender: 'u1',
            resourceType: 'H',
            amount: 5,
            from: 'W1N1',
            to: 'W2N2',
          },
        ]),
      },
      {
        name: 'rooms.intents',
        data: loki([
          {
            _id: 'ri1',
            room: 'W1N1',
            users: {
              u1: {
                objectsManual: { b: { activateSafeMode: {} } },
                objects: { a: { harvest: {} } },
              },
            },
          },
        ]),
      },
      {
        name: 'users.intents',
        data: loki([
          {
            _id: 'ui1',
            user: 'u1',
            intents: { createPowerCreep: [{ name: 'pc2', className: 'operator' }] },
          },
        ]),
      },
      {
        name: 'leaderboard.world',
        data: loki([{ _id: 'lw1', season: '2026-09', user: 'u1', score: 120, rank: 0 }]),
      },
      {
        name: 'leaderboard.power',
        data: loki([{ _id: 'lp1', season: '2026-09', user: 'u1', score: 7, rank: 0 }]),
      },
      {
        name: 'leaderboard.seasons',
        data: loki([{ _id: '2026-09', name: 'September 2026', date: '2026-09-01' }]),
      },
      { name: 'mod.things', data: loki([{ _id: 1, value: 'kept' }]) },
      { name: 'market.intents', data: [] },
    ],
  };
}

void it('preserves every record family of a populated original world', () => {
  const { state, report } = importWithReport(populatedWorld(), { shardName: 'shardX' });
  const { world } = state;

  assert.deepEqual(report.upgradesApplied, []);
  assert.equal(report.revokedTokens, 1);
  assert.equal(world.gameTime, 500);
  assert.equal(world.shardName, 'shardX');
  assert.deepEqual(world.activeRooms, ['W2N2', 'W1N1']);
  assert.equal(state.paused, true);
  assert.equal(state.tickDuration, 250);
  assert.deepEqual(state.tokens, {});

  // processing order: the adaptive Loki room index (c, a, b in W1N1)
  assert.deepEqual(processingOrder(state, 'W1N1'), ['c', 'a', 'b']);
  assert.equal(world.writeSeq, 4);

  // maintenance schedules
  assert.equal(state.jobs['forceUpdate:W1N1'], 600);
  assert.equal(state.jobs['npcOrders:W1N1'], 700);
  assert.equal(state.jobs['notify:u1'], NOW - 5000);
  const importedRoom = world.rooms.W1N1;
  assert.ok(importedRoom);
  assert.equal(Reflect.get(importedRoom, 'nextForceUpdateTime'), undefined);

  // users split into world document, account profile and runtime
  const alice = world.users.u1;
  assert.ok(alice);
  assert.equal(alice.money, 5000);
  assert.equal(Reflect.get(alice, 'credits'), 0);
  for (const field of [
    'email',
    'steam',
    'registeredDate',
    'activeSegments',
    'lastUsedCpu',
    'lastNotifyDate',
  ]) {
    assert.equal(Reflect.get(alice, field), undefined, field);
  }
  assert.deepEqual(state.profiles.u1, {
    registeredDate: Date.parse('2020-01-02T03:04:05.000Z'),
    email: 'alice@example.com',
    notifyPrefs: { interval: 5 },
    steam: { id: '7656', displayName: 'alice', steamProfileLinkHidden: true },
    lastOnline: NOW - 1000,
  });
  assert.equal(state.profiles.u2, undefined);

  const runtime = state.runtime.users.u1;
  assert.ok(runtime);
  assert.deepEqual(runtime.modules, {
    main: 'module.exports.loop = function () {};',
    wasm: { binary: 'AGFzbQ==' },
    'lib.util': 'u',
    'dir/file': 'f',
    'win\\path': 'w',
  });
  assert.equal(runtime.branch, 'default');
  assert.equal(runtime.codeTimestamp, Date.parse('2020-01-03T00:00:00.000Z'));
  assert.equal(state.runtime.lastCodeTimestamp, runtime.codeTimestamp);
  assert.equal(runtime.memory, '{"a":1}');
  assert.deepEqual(runtime.segments, { 3: 'segment three' });
  assert.equal(runtime.publicSegments, '3');
  assert.deepEqual(runtime.activeSegments, [3]);
  assert.equal(runtime.defaultPublicSegment, 3);
  assert.deepEqual(runtime.activeForeignSegment, { username: 'Bob', userId: 'u2', id: 5 });
  assert.deepEqual(runtime.consoleCommands, [{ expression: 'Game.time', hidden: true }]);
  assert.deepEqual(report.resetHeaps, ['u1']);

  assert.equal(state.branches.code2?.activeSim, true);
  assert.equal(state.branches.code2.timestamp, 1500);
  assert.equal(state.branches.code1?.activeSim, false);

  // remaining collections
  assert.equal(world.flags.f1?.data, 'Flag1~1~1~10~10');
  assert.equal(state.messages.m1?.date, Date.parse('2020-02-01T00:00:00.000Z'));
  assert.equal(state.messages.m2?.outMessage, 'm1');
  assert.equal(world.notifications.n1?.count, 2);
  assert.equal(world.usersMoney.mo1?.date, Date.parse('2020-03-01T00:00:00.000Z'));
  assert.equal(world.usersResources.r1?.date, Date.parse('2020-03-02T00:00:00.000Z'));
  assert.equal(world.userPowerCreeps.pc1?.className, 'operator');
  assert.equal(world.marketOrders.o1?.price, 1000);
  assert.equal(world.marketStats.s1?.date, '2020-03-01');
  assert.equal(world.transactions.tr1?.time, 450);
  assert.deepEqual(state.leaderboard, { '2026-09': { u1: { world: 120, power: 7 } } });
  assert.deepEqual(state.pendingIntents, { W1N1: { u1: { b: { activateSafeMode: {} } } } });
  assert.deepEqual(state.pendingGlobalIntents, {
    u1: { createPowerCreep: [{ name: 'pc2', className: 'operator' }] },
  });
  assert.ok(report.discarded.some((line) => line.startsWith('rooms.intents: script intents of 1')));

  // env records
  assert.deepEqual(world.mapViews.W1N1, { w: [[1, 1]] });
  assert.deepEqual(world.roomEventLogs.W1N1, [{ event: 1, objectId: 'a' }]);
  assert.deepEqual(
    state.history.W1N1?.map((frame) => frame.time),
    [498, 499],
  );
  assert.equal(state.history.W1N1[1]?.objects.a !== undefined, true);

  // compatibility data for mods: unknown collections, seasons and non-original env keys
  assert.deepEqual(state.originalStorage, {
    collections: {
      'mod.things': [{ _id: 1, value: 'kept' }],
      'leaderboard.seasons': [{ _id: '2026-09', name: 'September 2026', date: '2026-09-01' }],
    },
    env: { modKey: { a: 1 }, modExpiring: 'kept' },
    expirations: { modExpiring: NOW + 60000 },
  });
  assert.ok(!JSON.stringify(state).includes('auth_0123'));
  assert.ok(report.discarded.some((line) => line.includes('roomVisual')));
  assert.ok(report.discarded.some((line) => line.includes('accessibleRooms')));
  assert.ok(report.discarded.some((line) => line.includes('modExpired')));

  // the moved schedule keys are the ones maintenance reads
  const forced = structuredClone(state);
  forced.world.activeRooms = [];
  runJob(forced, 'roomsForceUpdate', NOW);
  assert.deepEqual(forced.world.activeRooms, ['W2N2']);
});

void it('rejects original data it cannot represent', () => {
  const reject = (mutate: (db: LokiFile) => void, pattern: RegExp): void => {
    const db = populatedWorld();
    mutate(db);
    assert.throws(() => importOriginalWorld(db, { now: NOW }), pattern);
  };
  const withPassword = (db: LokiFile, fields: Doc): void => {
    const users = collection(db, 'users');
    users[1] = { ...users[1], ...fields };
  };

  assert.throws(() => importOriginalWorld({}, { now: NOW }), /LokiJS database/);
  reject((db) => {
    (collection(db, 'env')[0] as Doc).databaseVersion = 10;
  }, /newer than the pinned original storage/);
  reject((db) => {
    collection(db, 'env').push({ $loki: 3, data: {} });
  }, /documents other than values/);
  reject((db) => {
    withPassword(db, { password: 'pbkdf2', salt: 'x' });
  }, /password hash/);
  reject((db) => {
    collection(db, 'rooms.objects').push({ ...collection(db, 'rooms.objects')[0] });
  }, /two documents with _id "a"/);
  reject((db) => {
    collection(db, 'rooms.terrain').pop();
  }, /W2N2 has no rooms.terrain/);
  reject((db) => {
    (collection(db, 'users.code')[0] as Doc).extra = 1;
  }, /cannot represent: extra/);
  reject((db) => {
    collection(db, 'mod.things').push({ value: 'no id' });
  }, /mod collections need unique ids/);

  // an explicit option discards foreign password hashes and reports it
  const foreign = populatedWorld();
  withPassword(foreign, { password: 'pbkdf2', salt: 'x' });
  const { state, report } = importWithReport(foreign, { discardForeignPasswordHashes: true });
  assert.ok(!JSON.stringify(state).includes('pbkdf2'));
  assert.equal(state.profiles.u2?.passwordHash, undefined);
  assert.ok(report.discarded.some((line) => line.includes('users u2: foreign password hash')));

  // this server's own scrypt hashes (projected by its original storage adapter) round-trip
  const own = populatedWorld();
  const hash = 'scrypt$16384$8$1$c2FsdA==$a2V5';
  withPassword(own, { password: hash });
  assert.equal(importWithReport(own).state.profiles.u2?.passwordHash, hash);
});

void it('decodes original module keys like the original runtime', () => {
  assert.deepEqual(
    Object.keys(
      decodeOriginalModules({ a$DOT$b: '1', main: '2', 'a.b': '3', c$SLASH$d$BACKSLASH$e: '4' }),
    ),
    ['main', 'a.b', 'c/d\\e'],
  );
  // a decoded name overwrites the existing module of that name
  assert.equal(decodeOriginalModules({ a$DOT$b: '1', 'a.b': '3' })['a.b'], '1');
});
