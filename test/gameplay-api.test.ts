import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, describe, it } from 'node:test';
import { BotRuntime, createWorldState, type WorldState } from '@openscreeps/game';
import { recordLeaderboard } from '@openscreeps/game';
import { createConfig } from '../src/config.ts';
import {
  ApiError,
  type ApiContext,
  type ServerEvents,
  type ServerState,
} from '../src/contracts.ts';
import { ApiTestClient } from './api-harness.ts';

type RoomObject = WorldState['roomObjects'][string];

/** Mid-interval wall clock (12:03:30 UTC), so the current minute is inside the current point. */
const NOW = Date.UTC(2026, 9, 8, 12, 3, 30);
/** Real Nest HTTP client per fixture context; closed by the shared harness after each test. */
const clients = new WeakMap<ApiContext, ApiTestClient>();

const runtimes: BotRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

/** Room terrain with natural walls on every border tile unless overridden (`'x,y'` -> code). */
function terrain(overrides: Record<string, string> = {}): string {
  let result = '';
  for (let y = 0; y < 50; y++) {
    for (let x = 0; x < 50; x++) {
      const border = x % 49 === 0 || y % 49 === 0;
      result += overrides[`${String(x)},${String(y)}`] ?? (border ? '1' : '0');
    }
  }
  return result;
}

function object(fields: RoomObject): [string, RoomObject] {
  return [fields._id, fields];
}

function harness(): { state: ServerState; context: ApiContext } {
  const runtime = new BotRuntime({ now: () => NOW });
  runtimes.push(runtime);
  const world = createWorldState({
    gameTime: 100,
    rooms: {
      W1N1: { _id: 'W1N1', status: 'normal' },
      W2N1: { _id: 'W2N1', status: 'normal' },
      W3N1: { _id: 'W3N1', status: 'out of borders' },
    },
    terrain: {
      W1N1: terrain({ '10,10': '1', '20,20': '2', '0,30': '0' }),
      W2N1: terrain(),
      W3N1: terrain(),
    },
    users: {
      alice: { _id: 'alice', username: 'Alice', usernameLower: 'alice', cpu: 100, gcl: 0 },
      bob: { _id: 'bob', username: 'Bob', usernameLower: 'bob', cpu: 100, gcl: 5000, badge: {} },
      '2': { _id: '2', username: 'Invader', usernameLower: 'invader' },
    },
    roomObjects: Object.fromEntries([
      object({ _id: 'c1', type: 'controller', room: 'W1N1', x: 5, y: 5, level: 0 }),
      object({ _id: 'src1', type: 'source', room: 'W1N1', x: 8, y: 8, invaderHarvested: 40 }),
      object({
        _id: 'c2',
        type: 'controller',
        room: 'W2N1',
        x: 5,
        y: 5,
        level: 3,
        user: 'bob',
        safeModeAvailable: 2,
        downgradeTime: 100_000,
      }),
      object({ _id: 'bobCreep', type: 'creep', room: 'W2N1', x: 20, y: 20, user: 'bob' }),
    ]),
  });
  const state: ServerState = {
    version: 1,
    world,
    runtime: runtime.snapshot(),
    profiles: {},
    branches: {},
    tokens: {},
    messages: {},
    history: {},
    statistics: [],
    leaderboard: {},
    jobs: {},
    notificationOutbox: [],
    pendingIntents: {},
    pendingGlobalIntents: {},
    paused: false,
    tickDuration: 1000,
  };
  const context: ApiContext = {
    config: createConfig({ database: ':memory:' }),
    state,
    runtime,
    events: new EventEmitter<ServerEvents>(),
    now: () => NOW,
    read: async <T>(operation: () => T | Promise<T>) => operation(),
    mutate: async <T>(operation: () => T | Promise<T>) => operation(),
    publish: () => undefined,
    terrainChanged: () => undefined,
    step: () => Promise.reject(new Error('not used')),
    setPaused: () => Promise.resolve(),
    setTickDuration: () => Promise.resolve(),
    // Fixture tokens are user ids.
    auth: {
      check: (token) => (Object.hasOwn(state.world.users, token) ? token : undefined),
      issue: (userId) => userId,
    },
  };
  clients.set(context, new ApiTestClient(context));
  return { state, context };
}

async function call(
  context: ApiContext,
  method: 'GET' | 'POST',
  path: string,
  options: { body?: Record<string, unknown>; query?: Record<string, string>; user?: string } = {},
): Promise<Record<string, unknown>> {
  const client = clients.get(context);
  assert.ok(client, 'context comes from harness()');
  const result = await client.call(method, path, {
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.query === undefined ? {} : { query: options.query }),
    ...(options.user === undefined ? {} : { token: options.user }),
  });
  assert.ok(result !== null && typeof result === 'object');
  return result as Record<string, unknown>;
}

async function rejects(promise: Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ApiError, String(error));
    assert.equal(error.message, message);
    return true;
  });
}

function objectsOf(state: ServerState, room: string): RoomObject[] {
  return Object.values(state.world.roomObjects).filter((item) => item.room === room);
}

void describe('place-spawn', () => {
  void it('claims a free room and resets it for the new player', async () => {
    const { state, context } = harness();
    state.world.roomObjects['oldExt'] = {
      _id: 'oldExt',
      type: 'extension',
      room: 'W1N1',
      x: 30,
      y: 30,
      user: 'bob',
      hitsMax: 1000,
      store: { energy: 20 },
    };
    state.world.roomObjects['oldCreep'] = {
      _id: 'oldCreep',
      type: 'creep',
      room: 'W1N1',
      x: 31,
      y: 31,
      user: 'bob',
    };
    const result = await call(context, 'POST', '/api/game/place-spawn', {
      user: 'alice',
      body: { room: 'W1N1', x: 25, y: 25, name: 'Spawn1' },
    });
    assert.deepEqual(result, { newbie: true });
    const objects = objectsOf(state, 'W1N1');
    const spawn = objects.find((item) => item.type === 'spawn');
    assert.ok(spawn);
    assert.equal(spawn._id.length, 24);
    assert.deepEqual(
      { user: spawn.user, name: spawn.name, x: spawn.x, y: spawn.y, store: spawn.store },
      { user: 'alice', name: 'Spawn1', x: 25, y: 25, store: { energy: 300 } },
    );
    const controller = state.world.roomObjects['c1'];
    assert.equal(controller?.user, 'alice');
    assert.equal(controller.level, 1);
    assert.equal(controller.safeMode, 100 + 20000);
    assert.equal(state.world.roomObjects['src1']?.invaderHarvested, 0);
    assert.equal(state.world.roomObjects['oldCreep'], undefined);
    assert.equal(state.world.roomObjects['oldExt'], undefined);
    const ruin = objects.find((item) => item.type === 'ruin');
    assert.deepEqual(ruin?.structure, {
      id: 'oldExt',
      type: 'extension',
      hits: 0,
      hitsMax: 1000,
      user: 'bob',
    });
    assert.deepEqual(ruin.store, { energy: 20 });
    assert.equal(state.world.rooms['W1N1']?.invaderGoal, 1000000);
    assert.ok(state.world.activeRooms.includes('W1N1'));
    assert.equal(state.world.users['alice']?.active, 10000);

    await rejects(
      call(context, 'POST', '/api/game/place-spawn', {
        user: 'alice',
        body: { room: 'W1N1', x: 26, y: 26, name: 'Spawn2' },
      }),
      'already playing',
    );
  });

  void it('enforces room, ownership, terrain and respawn constraints', async () => {
    const { state, context } = harness();
    const place = (body: Record<string, unknown>, user = 'alice'): Promise<unknown> =>
      call(context, 'POST', '/api/game/place-spawn', { user, body: { name: 'Spawn1', ...body } });
    await rejects(place({ room: 'W1N1', x: 'abc', y: 25 }), 'invalid params');
    await rejects(place({ room: 'W1N1', x: 25, y: 50 }), 'invalid params');
    await rejects(place({ room: 'W1N1', x: 25, y: 25, name: 'x'.repeat(51) }), 'invalid params');
    await rejects(place({ room: 'W9N9', x: 25, y: 25 }), 'invalid room');
    await rejects(place({ room: 'W3N1', x: 25, y: 25 }), 'out of borders');
    await rejects(place({ room: 'W2N1', x: 25, y: 25 }), 'room busy');
    await rejects(place({ room: 'W1N1', x: 10, y: 10 }), 'invalid location');
    await rejects(place({ room: 'W1N1', x: 0, y: 25 }), 'invalid location');
    // (1, 30) touches the open exit tile (0, 30).
    await rejects(place({ room: 'W1N1', x: 1, y: 30 }), 'invalid location');
    state.world.users['alice'] = {
      _id: 'alice',
      username: 'Alice',
      cpu: 100,
      lastRespawnDate: NOW - 1000,
    };
    await rejects(place({ room: 'W1N1', x: 25, y: 25 }), 'too soon after last respawn');
    state.world.users['alice'] = { _id: 'alice', username: 'Alice', cpu: 0 };
    await rejects(place({ room: 'W1N1', x: 25, y: 25 }), 'no cpu');
    state.world.users['alice'] = { _id: 'alice', username: 'Alice', cpu: 100, blocked: true };
    await rejects(place({ room: 'W1N1', x: 25, y: 25 }), 'blocked');
    assert.equal(objectsOf(state, 'W1N1').filter((item) => item.type === 'spawn').length, 0);
  });
});

void describe('create-construction', () => {
  void it('validates owner, RCL, structure type and site cost', async () => {
    const { state, context } = harness();
    const build = (body: Record<string, unknown>): Promise<Record<string, unknown>> =>
      call(context, 'POST', '/api/game/create-construction', { user: 'alice', body });
    for (const structureType of ['constructor', '__proto__', 'spawn']) {
      await rejects(build({ room: 'W1N1', x: 20, y: 21, structureType }), 'invalid params');
    }
    await rejects(
      build({ room: 'W2N1', x: 20, y: 21, structureType: 'road' }),
      'not a controller owner',
    );
    await rejects(
      build({ room: 'W1N1', x: 20, y: 21, structureType: 'extension' }),
      'RCL not enough',
    );
    const road = await build({ room: 'W1N1', x: 20, y: 20, structureType: 'road' });
    const site = state.world.roomObjects[String(road['_id'])];
    assert.equal(site?.progressTotal, 300 * 5);
    assert.equal(site.user, 'alice');
    await rejects(build({ room: 'W1N1', x: 20, y: 20, structureType: 'road' }), 'invalid location');
    const wallRoad = await build({ room: 'W1N1', x: 10, y: 10, structureType: 'road' });
    assert.equal(state.world.roomObjects[String(wallRoad['_id'])]?.progressTotal, 300 * 150);
  });
});

void describe('add-object-intent', () => {
  void it('queues sanitized intents only for the caller-owned objects of the room', async () => {
    const { state, context } = harness();
    state.world.roomObjects['aliceCreep'] = {
      _id: 'aliceCreep',
      type: 'creep',
      room: 'W2N1',
      x: 21,
      y: 21,
      user: 'alice',
    };
    const intent = (body: Record<string, unknown>): Promise<unknown> =>
      call(context, 'POST', '/api/game/add-object-intent', {
        user: 'alice',
        body: { room: 'W2N1', ...body },
      });
    await rejects(intent({ _id: 'bobCreep', name: 'suicide', intent: {} }), 'not owner');
    await rejects(intent({ _id: 'c2', name: 'unclaim', intent: {} }), 'not owner');
    await rejects(
      intent({ room: 'W1N1', _id: 'aliceCreep', name: 'suicide', intent: {} }),
      'invalid object',
    );
    await intent({ _id: 'aliceCreep', name: 'fly', intent: {} });
    assert.deepEqual(state.pendingIntents['W2N1']?.['alice']?.['aliceCreep'], {});
    await intent({
      _id: 'aliceCreep',
      name: 'say',
      intent: { message: 42, isPublic: 1, extra: 1 },
    });
    await intent({ _id: 'aliceCreep', name: 'suicide', intent: { id: 'aliceCreep' } });
    assert.deepEqual(state.pendingIntents, {
      W2N1: { alice: { aliceCreep: { say: { message: '42', isPublic: true }, suicide: {} } } },
    });
    assert.ok(state.world.activeRooms.includes('W2N1'));
  });

  void it('keeps room intents in the requested room and merges lists by index', async () => {
    const { state, context } = harness();
    const destroy = (intents: unknown): Promise<unknown> =>
      call(context, 'POST', '/api/game/add-object-intent', {
        user: 'bob',
        body: { room: 'W2N1', _id: 'room', name: 'destroyStructure', intent: intents },
      });
    await destroy([{ id: 'a', roomName: 'W2N1', user: 'bob' }]);
    await destroy([{ id: 'b', roomName: 'W2N1' }]);
    assert.deepEqual(state.pendingIntents['W2N1']?.['bob']?.['room'], {
      destroyStructure: [{ roomName: 'W2N1', id: 'b' }],
    });
    await rejects(destroy([{ id: 'c', roomName: 'W1N1' }]), 'invalid params');
    await rejects(destroy({ id: 'c', roomName: 'W2N1' }), 'invalid params');
    await rejects(destroy([{ id: 'c', roomName: '__proto__' }]), 'invalid params');
    assert.equal(Object.hasOwn(Object.prototype, 'room'), false);
  });

  void it('checks active safe mode before queueing controller intents for the processor', async () => {
    const { state, context } = harness();
    state.world.rooms['W4N1'] = { _id: 'W4N1', status: 'normal' };
    state.world.terrain['W4N1'] = terrain();
    state.world.roomObjects['c4'] = {
      _id: 'c4',
      type: 'controller',
      room: 'W4N1',
      x: 5,
      y: 5,
      level: 3,
      user: 'bob',
      safeModeAvailable: 1,
      downgradeTime: 100_000,
    };
    const activate = (room: string, id: string): Promise<unknown> =>
      call(context, 'POST', '/api/game/add-object-intent', {
        user: 'bob',
        body: { room, _id: id, name: 'activateSafeMode', intent: { id } },
      });
    await activate('W2N1', 'c2');
    await activate('W4N1', 'c4');
    assert.deepEqual(state.pendingIntents['W4N1']?.['bob']?.['c4'], { activateSafeMode: {} });
    state.pendingIntents = {};
    const c2 = state.world.roomObjects['c2'];
    assert.ok(c2);
    c2.safeMode = 200;
    await rejects(activate('W4N1', 'c4'), 'safe mode active already');
    c2.safeMode = null;
    c2.safeModeAvailable = 0;
    await activate('W2N1', 'c2');
    assert.deepEqual(state.pendingIntents['W2N1']?.['bob']?.['c2'], { activateSafeMode: {} });
  });

  void it('queues empty records for unknown global intents and sanitizes known ones', async () => {
    const { state, context } = harness();
    const global = (name: string, intent: unknown): Promise<unknown> =>
      call(context, 'POST', '/api/game/add-global-intent', {
        user: 'bob',
        body: { name, intent },
      });
    await global('notAnIntent', {});
    assert.deepEqual(state.pendingGlobalIntents, { bob: {} });
    await global('suicidePowerCreep', { id: 'pc1', extra: true });
    await global('suicidePowerCreep', { id: 'pc2' });
    assert.deepEqual(state.pendingGlobalIntents, {
      bob: { suicidePowerCreep: [{ id: 'pc1' }, { id: 'pc2' }] },
    });
  });
});

void describe('flags', () => {
  void it('creates, moves, recolors and removes flags with escaped names', async () => {
    const { state, context } = harness();
    const post = (path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> =>
      call(context, 'POST', path, { user: 'alice', body });
    const flagDocs = (): string[][] =>
      Object.values(state.world.flags).map((doc) => [doc.room, doc.data]);
    const flag = { name: 'a|b~c', color: 1, secondaryColor: 2, x: 10, y: 11, room: 'W1N1' };
    await post('/api/game/create-flag', { ...flag, x: 1.5 });
    assert.deepEqual(flagDocs(), [['W1N1', 'a$VLINE$b$TILDE$c~1~2~1.5~11']]);
    await rejects(post('/api/game/create-flag', { ...flag, color: 11 }), 'invalid params');
    await post('/api/game/create-flag', flag);
    assert.deepEqual(flagDocs(), [['W1N1', 'a$VLINE$b$TILDE$c~1~2~10~11']]);
    await post('/api/game/create-flag', { ...flag, room: 'W2N1', x: 3 });
    assert.deepEqual(flagDocs(), [
      ['W1N1', ''],
      ['W2N1', 'a$VLINE$b$TILDE$c~1~2~3~11'],
    ]);
    await rejects(post('/api/game/check-unique-flag-name', { name: 'a|b~c' }), 'name exists');
    assert.deepEqual(await post('/api/game/gen-unique-flag-name', {}), { name: 'Flag1' });
    await post('/api/game/change-flag-color', {
      room: 'W2N1',
      name: 'a|b~c',
      color: 5,
      secondaryColor: 6,
    });
    assert.deepEqual(flagDocs(), [
      ['W1N1', ''],
      ['W2N1', 'a$VLINE$b$TILDE$c~5~6~3~11'],
    ]);
    await post('/api/game/remove-flag', { room: 'W2N1', name: 'a|b~c' });
    assert.deepEqual(flagDocs(), [
      ['W1N1', ''],
      ['W2N1', ''],
    ]);
  });
});

void describe('invaders and notifications', () => {
  void it('only lets the summoner remove a summoned invader', async () => {
    const { state, context } = harness();
    await rejects(
      call(context, 'POST', '/api/game/create-invader', {
        user: 'alice',
        body: { room: 'W2N1', x: 30, y: 30, size: 'small', type: 'Melee' },
      }),
      'hostiles present',
    );
    delete state.world.roomObjects['bobCreep'];
    await rejects(
      call(context, 'POST', '/api/game/create-invader', {
        user: 'alice',
        body: { room: 'W2N1', x: 30, y: 30, size: 'small', type: 'Melee' },
      }),
      'not owned',
    );
    await rejects(
      call(context, 'POST', '/api/game/create-invader', {
        user: 'bob',
        body: { room: 'W2N1', x: 30, y: 30, size: 'huge', type: 'Melee' },
      }),
      'invalid params',
    );
    const creep = await call(context, 'POST', '/api/game/create-invader', {
      user: 'bob',
      body: { room: 'W2N1', x: 30, y: 30, size: 'small', type: 'Healer', boosted: true },
    });
    const id = String(creep['_id']);
    const stored = state.world.roomObjects[id];
    assert.equal(stored?.user, '2');
    assert.equal(stored.userSummoned, 'bob');
    assert.equal(stored.body?.length, 10);
    assert.equal(stored.body.find((part) => part.type === 'heal')?.boost, 'LO');
    await rejects(
      call(context, 'POST', '/api/game/remove-invader', { user: 'alice', body: { _id: id } }),
      'invalid object',
    );
    await call(context, 'POST', '/api/game/remove-invader', { user: 'bob', body: { _id: id } });
    assert.equal(state.world.roomObjects[id], undefined);
  });

  void it('changes notifyWhenAttacked of own or controlled structures only', async () => {
    const { state, context } = harness();
    state.world.roomObjects['wall'] = {
      _id: 'wall',
      type: 'constructedWall',
      room: 'W2N1',
      x: 9,
      y: 9,
    };
    const notify = (user: string, _id: string): Promise<unknown> =>
      call(context, 'POST', '/api/game/set-notify-when-attacked', {
        user,
        body: { _id, enabled: false },
      });
    await rejects(notify('alice', 'bobCreep'), 'not owner');
    await rejects(notify('alice', 'wall'), 'not controller owner');
    await notify('bob', 'c2');
    assert.equal(state.world.roomObjects['c2']?.notifyWhenAttacked, false);
    await notify('bob', 'wall');
    assert.equal(state.world.roomObjects['wall'].notifyWhenAttacked, false);
  });
});

void describe('power creeps', () => {
  function withPowerCreep(state: ServerState, power: number): void {
    state.world.users['alice'] = { _id: 'alice', username: 'Alice', cpu: 100, power };
    state.world.userPowerCreeps['pc'] = {
      _id: 'pc',
      user: 'alice',
      name: 'Op',
      className: 'operator',
      level: 0,
      hitsMax: 1000,
      store: {},
      storeCapacity: 100,
      spawnCooldownTime: 0,
      powers: {},
    };
  }

  void it('bounds upgrades by power level, class and ordering', async () => {
    const { state, context } = harness();
    withPowerCreep(state, 3 * 3 * 1000);
    const upgrade = (powers: unknown, id = 'pc', user = 'alice'): Promise<unknown> =>
      call(context, 'POST', '/api/game/power-creeps/upgrade', { user, body: { id, powers } });
    await rejects(upgrade({ 1: 1 }, 'pc', 'bob'), 'invalid id');
    await rejects(upgrade([1]), 'invalid powers');
    await rejects(upgrade(JSON.parse('{"__proto__": 1}')), 'invalid power __proto__');
    await rejects(upgrade({ 99: 1 }), 'invalid power 99');
    await rejects(upgrade({ 1: 1.5 }), 'invalid value for power 1');
    await rejects(upgrade({ 1: Number.NaN }), 'invalid value for power 1');
    await rejects(upgrade({ 1: 6 }), 'invalid max value for power 1');
    await rejects(upgrade({ 1: 2 }), 'powers set is not valid');
    await rejects(upgrade({ 1: 1, 2: 1, 3: 1 }), 'not enough power level');
    await upgrade({ 1: 1, 2: 1 });
    const creep = state.world.userPowerCreeps['pc'];
    assert.deepEqual(
      { level: creep?.level, hitsMax: creep?.hitsMax, storeCapacity: creep?.storeCapacity },
      { level: 2, hitsMax: 3000, storeCapacity: 300 },
    );
    assert.deepEqual(creep?.powers, { 1: { level: 1 }, 2: { level: 1 } });
    await rejects(upgrade({ 1: 1 }), 'cannot downgrade power 2');
    await rejects(upgrade({ 1: 0, 2: 1 }), 'cannot downgrade power 1');
  });

  void it('creates, renames and deletes with cooldown or experimentation', async () => {
    const { state, context } = harness();
    withPowerCreep(state, 1000);
    const post = (path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> =>
      call(context, 'POST', `/api/game/power-creeps/${path}`, { user: 'alice', body });
    await rejects(post('create', { name: 'X', className: 'operator' }), 'not enough power level');
    state.world.users['alice'] = { _id: 'alice', username: 'Alice', power: 4000 };
    await rejects(post('create', { name: 'X', className: 'nope' }), 'invalid class');
    await rejects(post('create', { name: 'Op', className: 'operator' }), 'name already exists');
    const created = await post('create', { name: 'Second', className: 'operator' });
    assert.equal(state.world.userPowerCreeps[String(created['_id'])]?.name, 'Second');
    await post('rename', { id: 'pc', name: 'Renamed' });
    assert.equal(state.world.userPowerCreeps['pc']?.name, 'Renamed');
    await post('delete', { id: 'pc' });
    assert.equal(state.world.userPowerCreeps['pc'].deleteTime, NOW + 24 * 3600 * 1000);
    await rejects(post('delete', { id: 'pc' }), 'already being deleted');
    await post('cancel-delete', { id: 'pc' });
    assert.equal(state.world.userPowerCreeps['pc'].deleteTime, undefined);
    await rejects(post('experimentation', {}), 'no power resets');
    state.world.users['alice'] = { _id: 'alice', username: 'Alice', powerExperimentations: 1 };
    await post('experimentation', {});
    await post('delete', { id: 'pc' });
    assert.equal(state.world.userPowerCreeps['pc'], undefined);
    state.world.userPowerCreeps['spawned'] = {
      _id: 'spawned',
      user: 'alice',
      name: 'Spawned',
      className: 'operator',
      level: 0,
      hitsMax: 1000,
      store: {},
      storeCapacity: 100,
      spawnCooldownTime: null,
      powers: {},
    };
    await rejects(post('rename', { id: 'spawned', name: 'Other' }), 'spawned');
    await rejects(post('delete', { id: 'spawned' }), 'spawned');
  });

  void it('passes raw names to game conversion for creation and rename', async () => {
    const { state, context } = harness();
    state.world.users['alice'] = { _id: 'alice', username: 'Alice', power: 1_000_000 };
    const post = (path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> =>
      call(context, 'POST', `/api/game/power-creeps/${path}`, { user: 'alice', body });
    const omitted = await post('create', { className: 'operator' });
    assert.equal(omitted['name'], 'undefined');
    const numeric = await post('create', { className: 'operator', name: 12 });
    assert.equal(numeric['name'], '12');
    const truncated = await post('create', { className: 'operator', name: 'B'.repeat(60) });
    assert.equal(truncated['name'], 'B'.repeat(50));
    const id = String(numeric['_id']);
    await post('rename', { id, name: 34 });
    assert.equal(state.world.userPowerCreeps[id]?.name, '34');
    await post('rename', { id, name: null });
    assert.equal(state.world.userPowerCreeps[id].name, 'null');
  });
});

void describe('statistics, market and leaderboard', () => {
  void it('buckets room statistics like upstream overview end times', async () => {
    const { state, context } = harness();
    const interval = 8 * 60_000;
    const lastEnd = Math.ceil(NOW / interval);
    // The current minute and a minute 8 minutes earlier land in the last two points.
    const minute = NOW - (NOW % 60_000);
    state.statistics.push(
      {
        time: minute,
        tick: 1,
        ticks: 1,
        rooms: { W2N1: { bob: { energyHarvested: 10 } } },
        users: {},
      },
      {
        time: minute - interval,
        tick: 2,
        ticks: 1,
        rooms: { W2N1: { bob: { energyHarvested: 4 }, ghost: { energyHarvested: 99 } } },
        users: {},
      },
    );
    const overview = await call(context, 'GET', '/api/game/room-overview', {
      user: 'alice',
      query: { room: 'W2N1', interval: '8' },
    });
    assert.deepEqual(overview['owner'], { username: 'Bob', badge: {} });
    const stats = overview['stats'] as Record<string, Array<{ value: number; endTime: number }>>;
    assert.equal(stats['energyHarvested']?.length, 8);
    assert.deepEqual(stats['energyHarvested'].slice(-2), [
      { value: 4, endTime: lastEnd - 1 },
      { value: 10, endTime: lastEnd },
    ]);
    assert.equal((overview['totals'] as Record<string, number>)['energyHarvested'], 14);
    const mapStats = await call(context, 'POST', '/api/game/map-stats', {
      user: 'alice',
      body: { rooms: ['W2N1', 'W9N9'], statName: 'energyHarvested8' },
    });
    const roomStats = (mapStats['stats'] as Record<string, Record<string, unknown>>)['W2N1'];
    assert.deepEqual(roomStats?.['energyHarvested8'], [{ user: 'bob', value: 14 }]);
    assert.deepEqual(roomStats['own'], { user: 'bob', level: 3 });
    assert.deepEqual(mapStats['statsMax'], { energyHarvested8: 14 });
    assert.deepEqual(Object.keys(mapStats['users'] as object), ['bob']);
  });

  void it('returns public order owners and converted prices without changing ownership filters', async () => {
    const { state, context } = harness();
    state.world.marketOrders['o1'] = {
      _id: 'o1',
      user: 'bob',
      active: true,
      type: 'sell',
      amount: 10,
      remainingAmount: 10,
      resourceType: 'energy',
      price: 1500,
      _skip: true,
    };
    const orders = await call(context, 'GET', '/api/game/market/orders', {
      user: 'alice',
      query: { resourceType: 'energy' },
    });
    assert.deepEqual(orders['list'], [
      {
        _id: 'o1',
        user: 'bob',
        active: true,
        type: 'sell',
        amount: 10,
        remainingAmount: 10,
        resourceType: 'energy',
        price: 1.5,
      },
    ]);
    const mine = await call(context, 'GET', '/api/game/market/my-orders', { user: 'bob' });
    assert.equal((mine['list'] as Array<Record<string, unknown>>)[0]?.['user'], 'bob');
    const others = await call(context, 'GET', '/api/game/market/my-orders', { user: 'alice' });
    assert.deepEqual(others['list'], []);
    const index = await call(context, 'GET', '/api/game/market/orders-index', { user: 'alice' });
    assert.deepEqual(index['list'], [{ _id: 'energy', count: 1, buying: 0, selling: 1 }]);
  });

  void it('ranks monthly progress recorded from tick statistics', async () => {
    const { state, context } = harness();
    recordLeaderboard(
      state,
      { W2N1: { bob: { energyControl: 50 }, alice: { energyControl: 70 } } },
      NOW,
    );
    recordLeaderboard(
      state,
      { W2N1: { bob: { energyControl: 30, powerProcessed: 5 }, ghost: { energyControl: 9 } } },
      NOW,
    );
    recordLeaderboard(state, { W2N1: { alice: { energyControl: 1 } } }, Date.UTC(2026, 8, 30));
    assert.deepEqual(state.leaderboard['2026-10'], {
      bob: { world: 80, power: 5 },
      alice: { world: 70, power: 0 },
    });
    const list = await call(context, 'GET', '/api/leaderboard/list', {
      query: { mode: 'world', season: '2026-10', limit: '10', offset: '0' },
    });
    const entries = list['list'] as Array<Record<string, unknown>>;
    assert.deepEqual(
      entries.map((entry) => [entry['user'], entry['rank'], entry['score']]),
      [
        ['bob', 0, 80],
        ['alice', 1, 70],
      ],
    );
    assert.equal(list['count'], 2);
    const users = list['users'] as Record<string, Record<string, unknown>>;
    assert.equal(users['bob']?.['gcl'], 5000);
    const found = await call(context, 'GET', '/api/leaderboard/find', {
      query: { mode: 'world', season: '2026-10', username: 'ALICE' },
    });
    assert.equal(found['rank'], 1);
    const history = await call(context, 'GET', '/api/leaderboard/find', {
      query: { mode: 'world', username: 'alice' },
    });
    assert.deepEqual(
      (history['list'] as Array<Record<string, unknown>>).map((entry) => entry['season']),
      ['2026-10', '2026-09'],
    );
    await rejects(
      call(context, 'GET', '/api/leaderboard/find', {
        query: { mode: 'power', season: '2026-10', username: 'alice' },
      }),
      'result not found',
    );
    const seasons = await call(context, 'GET', '/api/leaderboard/seasons');
    assert.deepEqual((seasons['seasons'] as Array<Record<string, unknown>>)[0], {
      _id: '2026-10',
      name: 'October 2026',
      date: '2026-10-01T00:00:00.000Z',
    });
  });
});
