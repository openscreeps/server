import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { hashPassword } from '../src/api/auth.ts';
import { createUser } from '../src/api/users.ts';
import {
  createOriginalStorage,
  ORIGINAL_DB_COLLECTIONS,
  type OriginalCollection,
  type OriginalStorage,
} from '../src/compatibility/original-storage.ts';
import { createConfig } from '../src/config.ts';
import { ServerKernel } from '../src/services/server-kernel.service.ts';

/** Lets pending immediates (pubsub deliveries) run. */
function settle(): Promise<void> {
  const { promise, resolve }: PromiseWithResolvers<void> = Promise.withResolvers();
  setImmediate(resolve);
  return promise;
}

/** A file-backed world; `reopen` restarts the server from its committed database. */
async function withWorld(
  run: (kernel: ServerKernel, reopen: () => Promise<ServerKernel>) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'original-storage-'));
  const config = createConfig({
    database: join(directory, 'world.sqlite'),
    worldSize: 2,
    paused: true,
  });
  let kernel = await ServerKernel.create(config);
  try {
    await run(kernel, async () => {
      await kernel.close();
      kernel = await ServerKernel.create(config);
      return kernel;
    });
  } finally {
    await kernel.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function collection(storage: OriginalStorage, name: string): OriginalCollection {
  const result = storage.db[name];
  assert.ok(result, name);
  return result;
}

void it('queries and updates canonical room objects with the original LokiJS semantics', async () => {
  await withWorld(async (kernel) => {
    const storage = createOriginalStorage(kernel);
    const objects = collection(storage, 'rooms.objects');
    const { world } = kernel.state;
    const all = Object.values(world.roomObjects);
    const controllers = all.filter((object) => object.type === 'controller');
    const controller = controllers[0];
    assert.ok(controller);

    const found = await objects.find({ type: 'controller' });
    assert.equal(found.length, controllers.length);
    assert.ok(found.every((doc) => doc.type === 'controller' && !('$loki' in doc)));
    assert.equal(
      await objects.count({ type: { $in: ['controller', 'source'] } }),
      all.filter((object) => object.type === 'controller' || object.type === 'source').length,
    );
    // Storage `recursReplaceNeNull`: `$ne: null` also excludes absent fields.
    assert.equal(
      (await objects.find({ type: 'controller', user: { $ne: null } })).length,
      controllers.filter((object) => object.user !== null && object.user !== undefined).length,
    );
    assert.equal((await objects.findOne({ _id: controller._id }))?.room, controller.room);
    assert.equal((await objects.by('_id', controller._id))?.type, 'controller');

    const level = controller.level ?? 0;
    assert.deepEqual(
      await objects.update(
        { _id: controller._id },
        { $set: { safeModeAvailable: 7 }, $inc: { level: 1 } },
      ),
      { modified: 1 },
    );
    assert.equal(world.roomObjects[controller._id]?.safeModeAvailable, 7);
    assert.equal(world.roomObjects[controller._id]?.level, level + 1);
    // Updated last: the `room` index returns it first, and the engine processes it in that order.
    assert.equal(world.roomObjectWriteSeq?.[controller._id], world.writeSeq);
    assert.equal((await objects.find({ room: controller.room }))[0]?._id, controller._id);

    // Results are copies.
    const copy = found[0];
    assert.ok(copy);
    copy.type = 'changed';
    assert.equal(world.roomObjects[String(copy._id)]?.type, 'controller');

    const sorted = await objects.findEx(
      { room: { $regex: '^[WE]' } },
      { sort: { x: -1 }, limit: 2 },
    );
    assert.equal(sorted.length, 2);
    assert.equal(sorted[0]?.x, Math.max(...all.map((object) => object.x)));

    const inserted = await objects.insert({ type: 'probe', room: controller.room, x: 5, y: 6 });
    assert.ok(!Array.isArray(inserted) && typeof inserted._id === 'string');
    assert.equal(world.roomObjects[inserted._id]?.type, 'probe');
    assert.equal(world.roomObjectWriteSeq?.[inserted._id], world.writeSeq);
    await objects.removeWhere({ type: 'probe' });
    assert.equal(world.roomObjects[inserted._id], undefined);
  });
});

void it('stages every write: a rejected operation changes nothing and unsafe keys are refused', async () => {
  await withWorld(async (kernel) => {
    const storage = createOriginalStorage(kernel);
    const objects = collection(storage, 'rooms.objects');
    const { world } = kernel.state;
    const room = Object.values(world.rooms)[0]?._id;
    assert.ok(room);
    const count = Object.keys(world.roomObjects).length;
    const idCounter = world.idCounter;

    // `assert.rejects` takes native promises; storage calls return q promises.
    await assert.rejects(
      Promise.resolve(
        objects.bulk([
          { op: 'insert', data: { _id: 'dup', type: 'probe', room, x: 1, y: 1 } },
          { op: 'insert', data: { _id: 'dup', type: 'probe', room, x: 2, y: 2 } },
        ]),
      ),
      (reason: unknown) => reason === 'Duplicate key for property _id: dup',
    );
    await assert.rejects(
      Promise.resolve(objects.insert([{ type: 'probe', room, x: 1, y: 1 }, { type: 'probe' }])),
      /room must be a string/,
    );
    assert.equal(Object.keys(kernel.state.world.roomObjects).length, count);
    assert.equal(kernel.state.world.idCounter, idCounter);

    const target = Object.keys(kernel.state.world.roomObjects)[0];
    assert.ok(target);
    const pollution: unknown = JSON.parse('{"$merge": {"__proto__": {"polluted": true}}}');
    await assert.rejects(Promise.resolve(objects.update({ _id: target }, pollution)), /__proto__/);
    assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
    await assert.rejects(
      Promise.resolve(objects.update({ _id: target }, { $set: { x: 'left' } })),
      /x must be a number/,
    );
    assert.equal(typeof kernel.state.world.roomObjects[target]?.x, 'number');
  });
});

void it('maps users onto world users and private profiles, code branches and player runtime', async () => {
  await withWorld(async (kernel, reopen) => {
    const storage = createOriginalStorage(kernel);
    const users = collection(storage, 'users');
    const user = await kernel.mutate(() =>
      createUser(kernel, {
        username: 'alice',
        password: 'correct horse battery',
        email: 'alice@example.com',
      }),
    );
    await kernel.mutate(() => {
      kernel.state.tokens.session = { userId: user._id, expires: kernel.now() + 60000 };
    });

    const doc = await users.findOne({ username: 'alice' });
    assert.ok(doc);
    assert.equal(doc.email, 'alice@example.com');
    assert.match(String(doc.password), /^scrypt\$/);
    const profile = kernel.state.profiles[user._id];
    assert.ok(profile);
    assert.equal(doc.registeredDate, new Date(profile.registeredDate).toISOString());

    await users.update(
      { username: 'alice' },
      { $set: { email: 'new@example.com', cpu: 50, modField: 'kept', lastNotifyDate: 123 } },
    );
    assert.equal(kernel.state.profiles[user._id]?.email, 'new@example.com');
    const worldUser = kernel.state.world.users[user._id];
    assert.ok(worldUser);
    assert.equal(worldUser.cpu, 50);
    assert.equal(Reflect.get(worldUser, 'modField'), 'kept');
    assert.ok(
      !('email' in worldUser) && !('password' in worldUser),
      'credentials stay out of the game',
    );
    assert.equal(kernel.state.jobs[`notify:${user._id}`], 123);
    assert.ok(kernel.state.tokens.session, 'unchanged credentials keep sessions');

    await assert.rejects(
      Promise.resolve(users.update({ _id: user._id }, { $set: { password: 'plain' } })),
      /scrypt/,
    );
    await assert.rejects(
      Promise.resolve(users.update({ _id: user._id }, { $set: { salt: 'abc' } })),
      /salt/,
    );
    await users.update({ _id: user._id }, { $set: { password: hashPassword('another secret') } });
    assert.equal(kernel.state.tokens.session, undefined, 'a new password revokes sessions');

    const code = collection(storage, 'users.code');
    const branch = await code.findOne({ user: user._id, activeWorld: true });
    assert.ok(branch);
    const modules = {
      main: 'module.exports.loop = function () {};',
      'lib.util': 'module.exports = 1;',
    };
    await code.update(
      { _id: branch._id },
      { $set: { modules: { main: modules.main, lib$DOT$util: modules['lib.util'] } } },
    );
    assert.deepEqual(kernel.state.branches[String(branch._id)]?.modules, modules);
    assert.deepEqual(kernel.runtime.getCode(user._id)?.modules, modules);
    const stored = await code.findOne({ _id: branch._id });
    assert.deepEqual(stored?.modules, { main: modules.main, lib$DOT$util: modules['lib.util'] });

    const commands = collection(storage, 'users.console');
    await commands.insert({ user: user._id, expression: 'Game.time', hidden: false });
    assert.deepEqual(
      (await commands.find({ user: user._id })).map((item) => item.expression),
      ['Game.time'],
    );
    await assert.rejects(
      Promise.resolve(commands.removeWhere({ user: user._id })),
      /only be inserted/,
    );

    const reopened = await reopen();
    const after = createOriginalStorage(reopened);
    const restored = await collection(after, 'users').findOne({ _id: user._id });
    assert.ok(restored);
    assert.equal(restored.email, 'new@example.com');
    assert.equal(restored.modField, 'kept');
    assert.equal(restored.lastNotifyDate, 123);
    assert.deepEqual(reopened.runtime.getCode(user._id)?.modules, modules);
  });
});

void it('maps intents, terrain and leaderboard documents onto canonical records', async () => {
  await withWorld(async (kernel) => {
    const storage = createOriginalStorage(kernel);
    const { state } = kernel;
    const controller = Object.values(state.world.roomObjects).find(
      (object) => object.type === 'controller',
    );
    assert.ok(controller);
    const user = await kernel.mutate(() => createUser(kernel, { username: 'bob' }));

    await collection(storage, 'rooms.intents').update(
      { room: controller.room },
      {
        $merge: {
          users: { [user._id]: { objectsManual: { [controller._id]: { activateSafeMode: {} } } } },
        },
      },
      { upsert: true },
    );
    assert.deepEqual(state.pendingIntents[controller.room]?.[user._id]?.[controller._id], {
      activateSafeMode: {},
    });

    const global = collection(storage, 'users.intents');
    await global.insert({ user: user._id, intents: { notify: [{ message: 'a' }] } });
    await global.insert({ user: user._id, intents: { notify: [{ message: 'b' }] } });
    assert.deepEqual(state.pendingGlobalIntents[user._id], {
      notify: [{ message: 'a' }, { message: 'b' }],
    });

    const terrain = state.world.terrain[controller.room];
    assert.ok(terrain);
    const changed =
      terrain.slice(0, 51) + String((Number(terrain.charAt(51)) + 1) % 4) + terrain.slice(52);
    const terrainDocs = collection(storage, 'rooms.terrain');
    assert.deepEqual(await terrainDocs.findOne({ room: controller.room }), {
      room: controller.room,
      terrain,
      type: 'terrain',
      _id: controller.room,
    });
    await terrainDocs.update({ room: controller.room }, { $set: { terrain: changed } });
    assert.equal(state.world.terrain[controller.room], changed);
    await assert.rejects(
      Promise.resolve(terrainDocs.update({ room: controller.room }, { $set: { terrain: 'x' } })),
      /terrain digits/,
    );

    await kernel.mutate(() => {
      state.leaderboard['2026-10'] = { [user._id]: { world: 50, power: 0 } };
    });
    assert.deepEqual(await collection(storage, 'leaderboard.world').find({ season: '2026-10' }), [
      { _id: `2026-10-world-${user._id}`, season: '2026-10', user: user._id, score: 50, rank: 0 },
    ]);
    assert.deepEqual(
      await collection(storage, 'leaderboard.power').update(
        { season: '2026-10', user: user._id },
        { $set: { score: 7 } },
        { upsert: true },
      ),
      { inserted: 1 },
    );
    assert.deepEqual(state.leaderboard['2026-10']?.[user._id], { world: 50, power: 7 });
  });
});

void it('serves env keys from the world and persists mod data across a restart', async () => {
  await withWorld(async (kernel, reopen) => {
    const names = [...ORIGINAL_DB_COLLECTIONS];
    const storage = createOriginalStorage(kernel, { collections: names });
    const { env } = storage;
    const user = await kernel.mutate(() => createUser(kernel, { username: 'carol' }));

    // Original `env.keys` names.
    assert.equal(await env.get('gameTime'), kernel.state.world.gameTime);
    await env.set(`memory:${user._id}`, '{"a":1}');
    assert.equal(kernel.runtime.getMemory(user._id), '{"a":1}');
    await env.hset(`memorySegments:${user._id}`, '3', 'segment');
    assert.equal(kernel.runtime.getSegment(user._id, 3), 'segment');
    // Like the storage RPC, missing hash fields come back as JSON nulls.
    assert.deepEqual(await env.hmget(`memorySegments:${user._id}`, ['3', '4']), ['segment', null]);
    await env.set('mainLoopPaused', '0');
    assert.equal(kernel.state.paused, false);
    await env.set('mainLoopPaused', '1');
    assert.equal(kernel.state.paused, true);
    await env.set('tickRate', 250);
    assert.equal(kernel.state.tickDuration, 250);
    assert.deepEqual(await env.smembers('activeRooms'), kernel.state.world.activeRooms);
    await assert.rejects(Promise.resolve(env.expire('gameTime', 10)), /cannot expire/);
    await assert.rejects(Promise.resolve(env.set('accessibleRooms', '[]')), /derived/);

    await env.hmset('mymod:config', { a: 1 });
    await env.hset('mymod:config', 'b', 2);
    assert.deepEqual(await env.get('mymod:config'), { a: 1, b: 2 });
    assert.deepEqual(await env.sadd('mymod:set', ['x', 'y', 'x']), ['x', 'y']);
    await env.setex('mymod:temporary', 3600, 'soon gone');
    assert.equal(await env.del('mymod:missing'), 0);

    names.push('mymod.data');
    assert.equal(storage.db['mymod.data'], undefined);
    await storage._connect();
    assert.equal(storage._connected, true);
    const data = collection(storage, 'mymod.data');
    await data.insert([
      { name: 'a', n: 1 },
      { name: 'b', n: 2 },
    ]);
    assert.deepEqual(await data.update({ name: 'c' }, { $set: { n: 3 } }, { upsert: true }), {
      inserted: 1,
    });
    assert.deepEqual(await data.update({ n: { $gte: 2 } }, { $inc: { n: 10 } }), { modified: 2 });
    await data.removeWhere({ name: 'missing' });

    const reopened = await reopen();
    const after = createOriginalStorage(reopened, {
      collections: [...ORIGINAL_DB_COLLECTIONS, 'mymod.data'],
    });
    assert.deepEqual(
      (await collection(after, 'mymod.data').find()).map((doc) => [doc.name, doc.n]),
      [
        ['a', 1],
        ['b', 12],
        ['c', 13],
      ],
    );
    assert.deepEqual(await after.env.get('mymod:config'), { a: 1, b: 2 });
    assert.deepEqual(await after.env.smembers('mymod:set'), ['x', 'y']);
    const ttl = await after.env.ttl('mymod:temporary');
    assert.ok(ttl > 0 && ttl <= 3600, String(ttl));
    assert.equal(await after.env.get(`memory:${user._id}`), '{"a":1}');
    assert.equal(reopened.state.tickDuration, 250);
    assert.equal(reopened.state.originalStorage?.collections['mymod.data']?.length, 3);
  });
});

void it('publishes and subscribes like the original pubsub, including committed ticks', async () => {
  await withWorld(async (kernel) => {
    const storage = createOriginalStorage(kernel);
    const { pubsub } = storage;
    const seen: Array<[string, unknown]> = [];
    const stop = pubsub.subscribe('*', function (data) {
      seen.push([this.channel, data]);
    });
    const done: unknown[] = [];
    pubsub.subscribe('roomsDone', (data) => {
      done.push(data);
    });

    const tick = await kernel.step();
    await settle();
    assert.deepEqual(done, [tick.simulation.gameTime]);
    assert.ok(seen.some(([channel, data]) => channel === 'tickStarted' && data === '1'));

    const messages: Array<[string, unknown]> = [];
    kernel.events.on('message', (channel, data) => {
      messages.push([channel, data]);
    });
    const text = JSON.stringify({ messages: { log: ['hi'], results: [] }, userId: 'u1' });
    await pubsub.publish('user:u1/console', text);
    assert.deepEqual(messages.at(-1), ['user:u1/console', JSON.parse(text)]);
    await pubsub.publish('mymod:event', { a: 1 });
    await settle();
    assert.deepEqual(seen.slice(-2), [
      ['user:u1/console', text],
      ['mymod:event', { a: 1 }],
    ]);

    stop();
    await pubsub.publish('mymod:event', { a: 2 });
    await settle();
    assert.deepEqual(seen.at(-1), ['mymod:event', { a: 1 }]);
  });
});
