import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import {
  gameStateOf,
  MAINTENANCE_JOBS,
  spawnBot,
  type NotificationBatch,
  type User,
} from '@openscreeps/game';
import { createUser } from '../src/api/users.ts';
import { createConfig } from '../src/config.ts';
import {
  defaultCronjobs,
  MAINTENANCE_INTERVAL,
  ServerKernel,
} from '../src/services/server-kernel.service.ts';
import { StateStore } from '../src/services/state-store.service.ts';

const CLOCK = 1_700_000_000_000;

/** Lets every pending promise continuation run (`setImmediate` is never mocked here). */
function settle(): Promise<void> {
  const { promise, resolve }: PromiseWithResolvers<void> = Promise.withResolvers();
  setImmediate(resolve);
  return promise;
}

/** Creates a player with an address and one due notification. */
function notifiedUser(kernel: ServerKernel, username: string): Promise<User> {
  return kernel.mutate(() => {
    const user = createUser(kernel, { username, email: `${username}@example.com` });
    const id = `notification-${username}`;
    kernel.state.world.notifications[id] = {
      _id: id,
      user: user._id,
      message: `attacked ${username}`,
      date: kernel.now() - 1,
      type: 'msg',
      count: 1,
    };
    return user;
  });
}

/** A paused world on a store the test observes, flushed once so it starts clean. */
async function flushedKernel(
  options: Parameters<typeof createConfig>[0],
): Promise<{ kernel: ServerKernel; store: StateStore }> {
  const config = createConfig({ database: ':memory:', worldSize: 2, paused: true, ...options });
  const store = await StateStore.open(config);
  const kernel = await ServerKernel.create(config, {}, store);
  await kernel.flush();
  return { kernel, store };
}

void it('delivers maintenance notifications to account addresses outside the game state', async () => {
  const now = Date.now();
  const kernel = await ServerKernel.create(
    createConfig({ database: ':memory:', worldSize: 2, paused: true }),
    { now: () => now },
  );
  try {
    const user = await kernel.mutate(() => {
      const created = createUser(kernel, {
        username: 'alice',
        password: 'correct horse battery',
        email: 'alice@example.com',
      });
      kernel.state.tokens['token-hash'] = { userId: created._id, expires: kernel.now() + 60000 };
      kernel.state.world.notifications.n1 = {
        _id: 'n1',
        user: created._id,
        message: 'attacked',
        date: kernel.now() - 1,
        type: 'msg',
        count: 1,
      };
      return created;
    });
    const tick = await kernel.step();
    assert.deepEqual(tick.maintenance.errors, []);
    assert.equal(kernel.state.notificationOutbox.length, 1);
    assert.equal(kernel.state.notificationOutbox[0]?.userId, user._id);
    assert.equal(kernel.state.notificationOutbox[0].email, 'alice@example.com');
    const batch = kernel.state.notificationOutbox[0];
    assert.deepEqual(batch.notifications, [
      { message: 'attacked', date: now - 1, count: 1, type: 'msg' },
    ]);
    assert.ok(tick.maintenance.ran.includes('sendNotifications'));

    const game = JSON.stringify(gameStateOf(kernel.state));
    for (const secret of ['passwordHash', 'token-hash', 'alice@example.com', 'profiles']) {
      assert.ok(!game.includes(secret), secret);
    }
    assert.ok(game.includes('"alice"'));
  } finally {
    await kernel.close();
  }
});

void it('preserves a committed terrain invalidation across a later rejected mutation', async () => {
  // W1N1 is the controller room of a centred 3-room world (W1N1..E0S0)
  const kernel = await ServerKernel.create(
    createConfig({ database: ':memory:', worldSize: 3, paused: true }),
  );
  try {
    const room = Object.values(kernel.state.world.roomObjects).find(
      (object) => object.type === 'controller',
    )?.room;
    assert.ok(room);
    const bot = await kernel.mutate(() =>
      spawnBot(
        kernel,
        'terrain-probe',
        {
          main: `module.exports.loop = () => {
        global.runs = (global.runs || 0) + 1;
        Memory.runs = global.runs;
        Memory.tile = Game.map.getRoomTerrain(${JSON.stringify(room)}).get(1, 1);
      };`,
        },
        room,
      ),
    );
    await kernel.step();
    const terrain = kernel.state.world.terrain[room];
    assert.ok(terrain);
    const expected = (Number(terrain.charAt(51)) + 1) % 4;
    await kernel.mutate(() => {
      kernel.state.world.terrain[room] =
        terrain.slice(0, 51) + String(expected) + terrain.slice(52);
      kernel.terrainChanged();
    });
    await assert.rejects(
      kernel.mutate(() => {
        kernel.state.paused = false;
        throw new Error('rejected operation');
      }),
      /rejected operation/,
    );
    const tick = await kernel.step();
    assert.deepEqual(tick.simulation.errors, []);
    assert.equal(kernel.state.paused, true);
    assert.deepEqual(JSON.parse(kernel.runtime.getMemory(bot.userId)), { runs: 2, tile: expected });
  } finally {
    await kernel.close();
  }
});

void it('rejects malformed nested snapshots before replacing a usable world', async () => {
  const kernel = await ServerKernel.create(
    createConfig({ database: ':memory:', worldSize: 2, paused: true }),
  );
  try {
    const committed = await kernel.exportSnapshot();
    const malformed = [
      { ...committed, history: { unused: null } },
      { ...committed, history: { unused: [{ time: 1, objects: null }] } },
      { ...committed, branches: { broken: {} } },
      { ...committed, runtime: { ...committed.runtime, users: { broken: {} } } },
      { ...committed, statistics: [{ time: 1, tick: 1, ticks: 1, rooms: null, users: {} }] },
    ];
    for (const snapshot of malformed) {
      await assert.rejects(kernel.importSnapshot(snapshot), /Invalid/);
      assert.deepEqual(await kernel.exportSnapshot(), committed);
    }
    const result = await kernel.step();
    assert.deepEqual(result.simulation.errors, []);
    assert.equal(kernel.state.world.gameTime, committed.world.gameTime + 1);
  } finally {
    await kernel.close();
  }
});

void it('runs due maintenance on its own wall clock while the world is paused', async (t) => {
  let clock = CLOCK;
  let probe: PromiseWithResolvers<void> = Promise.withResolvers();
  const kernel = await ServerKernel.create(
    createConfig({ database: ':memory:', worldSize: 2, paused: true }),
    {
      now: () => clock,
      cronjobs: (context) => ({
        ...defaultCronjobs(context),
        probe: {
          interval: 0,
          run: () => {
            probe.resolve();
          },
        },
      }),
    },
  );
  try {
    const user = await notifiedUser(kernel, 'alice');
    await kernel.mutate(() => {
      kernel.state.tokens.expired = { userId: user._id, expires: clock - 1 };
    });
    const gameTime = kernel.state.world.gameTime;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    kernel.start();
    assert.equal(kernel.state.jobs['cron:sendNotifications'], undefined);

    t.mock.timers.tick(MAINTENANCE_INTERVAL);
    await probe.promise;
    await kernel.read(() => undefined);
    assert.equal(kernel.state.world.gameTime, gameTime, 'a paused world does not tick');
    for (const name of Object.keys(MAINTENANCE_JOBS)) {
      assert.equal(kernel.state.jobs[`cron:${name}`], clock, name);
    }
    assert.equal(kernel.state.tokens.expired, undefined);
    assert.equal(kernel.state.notificationOutbox.length, 1);
    assert.deepEqual(kernel.state.notificationOutbox[0]?.notifications, [
      { message: 'attacked alice', date: clock - 1, count: 1, type: 'msg' },
    ]);

    // Only the jobs whose interval elapsed run again: roomsForceUpdate every 20 s, not hourly ones.
    await settle();
    const first = clock;
    clock += 21000;
    probe = Promise.withResolvers();
    t.mock.timers.tick(MAINTENANCE_INTERVAL);
    await probe.promise;
    await kernel.read(() => undefined);
    assert.equal(kernel.state.jobs['cron:roomsForceUpdate'], clock);
    assert.equal(kernel.state.jobs['cron:sendNotifications'], first);
    assert.equal(kernel.state.jobs['cron:purgeTransactions'], first);
    assert.equal(kernel.state.world.gameTime, gameTime);
  } finally {
    await kernel.close();
  }
});

void it('serializes maintenance with ticks and runs each due job once', async () => {
  const entered: PromiseWithResolvers<void> = Promise.withResolvers();
  const gate: PromiseWithResolvers<void> = Promise.withResolvers();
  const order: string[] = [];
  let runs = 0;
  const kernel = await ServerKernel.create(
    createConfig({ database: ':memory:', worldSize: 2, paused: true }),
    {
      now: () => CLOCK,
      cronjobs: (context) => ({
        ...defaultCronjobs(context),
        slow: {
          interval: 60,
          run: async () => {
            runs++;
            order.push('slow:start');
            entered.resolve();
            await gate.promise;
            // Kernel calls made by a job join its mutation instead of deadlocking behind it.
            const time = await context.read(() => context.state.world.gameTime);
            await context.mutate(() => {
              context.state.jobs['test:nested'] = time;
            });
            order.push('slow:end');
          },
        },
      }),
    },
  );
  try {
    kernel.events.on('tick', () => order.push('tick'));
    const gameTime = kernel.state.world.gameTime;
    const pass = kernel.maintain();
    await entered.promise;
    const step = kernel.step();
    await settle();
    assert.equal(kernel.state.world.gameTime, gameTime, 'the tick waits for the pass');
    assert.deepEqual(order, ['slow:start']);
    gate.resolve();
    const [report, tick] = await Promise.all([pass, step]);
    assert.deepEqual(report.ran, [...Object.keys(MAINTENANCE_JOBS), 'slow']);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(tick.maintenance.ran, [], 'no job is due again at the same instant');
    assert.deepEqual(order, ['slow:start', 'slow:end', 'tick']);
    assert.equal(runs, 1);
    assert.equal(kernel.state.jobs['test:nested'], gameTime);
    assert.equal(kernel.state.world.gameTime, gameTime + 1);
    assert.deepEqual(await kernel.maintain(), { ran: [], errors: [], notifications: [] });
    await assert.rejects(
      kernel.read(() => kernel.mutate(() => undefined)),
      /Cannot mutate the world inside a read/,
    );
  } finally {
    await kernel.close();
  }
});

void it('rolls back only a failing maintenance job and keeps its schedule', async () => {
  const kernel = await ServerKernel.create(
    createConfig({ database: ':memory:', worldSize: 2, paused: true }),
    {
      now: () => CLOCK,
      cronjobs: (context) => ({
        broken: {
          interval: 60,
          run: () => {
            context.state.jobs['test:partial'] = 1;
            context.publish('test:partial', 1);
            throw new Error('boom');
          },
        },
        after: {
          interval: 60,
          run: () => {
            context.state.jobs['test:after'] = 1;
          },
        },
      }),
    },
  );
  try {
    const errors: Error[] = [];
    const messages: string[] = [];
    kernel.events.on('error', (error) => errors.push(error));
    kernel.events.on('message', (channel) => messages.push(channel));
    const report = await kernel.maintain();
    assert.deepEqual(report.ran, ['broken', 'after']);
    assert.deepEqual(
      report.errors.map(({ job }) => job),
      ['broken'],
    );
    assert.equal(kernel.state.jobs['test:partial'], undefined);
    assert.equal(kernel.state.jobs['test:after'], 1);
    assert.equal(kernel.state.jobs['cron:broken'], CLOCK);
    assert.equal(kernel.state.jobs['cron:sendNotifications'], undefined, 'built-ins replaced');
    assert.deepEqual(messages, []);
    assert.match(errors[0]?.message ?? '', /Maintenance job failed: broken/);
    assert.deepEqual((await kernel.maintain()).ran, []);
  } finally {
    await kernel.close();
  }
});

void it('restores room history recorded by a failing maintenance job', async () => {
  const frame = (time: number) => ({ time, objects: {} });
  const kernel = await ServerKernel.create(
    createConfig({ database: ':memory:', worldSize: 2, paused: true }),
    {
      now: () => CLOCK,
      cronjobs: (context) => ({
        broken: {
          interval: 60,
          run: () => {
            context.state.history.W1N1?.push(frame(2));
            context.state.history.W2N2 = [frame(2)];
            throw new Error('boom');
          },
        },
        after: {
          interval: 60,
          run: () => {
            context.state.history.W1N1?.push(frame(3));
          },
        },
      }),
    },
  );
  try {
    await kernel.mutate(() => {
      kernel.state.history.W1N1 = [frame(1)];
    });
    const report = await kernel.maintain();
    assert.deepEqual(
      report.errors.map(({ job }) => job),
      ['broken'],
    );
    assert.deepEqual(kernel.state.history, { W1N1: [frame(1), frame(3)] });
  } finally {
    await kernel.close();
  }
});

void it('writes the world to the store every commitTicks ticks', async () => {
  const { kernel, store } = await flushedKernel({ commitTicks: 3 });
  try {
    const revision = store.revision;
    await kernel.step();
    await kernel.step();
    assert.equal(store.revision, revision, 'commitTicks - 1 ticks stay in memory');
    await kernel.step();
    assert.equal(store.revision, revision + 1);
    assert.equal(store.load()?.world.gameTime, kernel.state.world.gameTime);
  } finally {
    await kernel.close();
  }
});

void it('flushes changes of a paused world after commitTicks tick durations', async (t) => {
  const { kernel, store } = await flushedKernel({ commitTicks: 5, tickDuration: 100 });
  try {
    const revision = store.revision;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await kernel.mutate(() => {
      kernel.state.jobs['test:write'] = 1;
    });
    t.mock.timers.tick(499);
    await kernel.read(() => undefined);
    assert.equal(store.revision, revision);
    t.mock.timers.tick(1);
    await kernel.read(() => undefined);
    assert.equal(store.revision, revision + 1);
    assert.equal(store.load()?.jobs['test:write'], 1);
  } finally {
    await kernel.close();
  }
});

void it('rolls back only the failed mutation, keeping unflushed successful ones', async () => {
  const { kernel, store } = await flushedKernel({});
  try {
    const revision = store.revision;
    const time = kernel.state.world.gameTime;
    await kernel.mutate(() => {
      kernel.state.jobs['test:first'] = 1;
    });
    await kernel.step();
    await assert.rejects(
      kernel.mutate(() => {
        kernel.state.jobs['test:first'] = 2;
        kernel.state.jobs['test:second'] = 2;
        throw new Error('rejected operation');
      }),
      /rejected operation/,
    );
    assert.equal(kernel.state.jobs['test:first'], 1);
    assert.equal(kernel.state.jobs['test:second'], undefined);
    assert.equal(kernel.state.world.gameTime, time + 1);
    assert.equal(store.revision, revision, 'nothing was flushed yet');
    await kernel.flush();
    assert.equal(store.revision, revision + 1);
    assert.equal(store.load()?.jobs['test:first'], 1);
    assert.equal(store.load()?.world.gameTime, time + 1);
  } finally {
    await kernel.close();
  }
});

void it('delivers notifications generated outside ticks and retries failed deliveries', async () => {
  const firstAttempt: PromiseWithResolvers<void> = Promise.withResolvers();
  const delivered: NotificationBatch[] = [];
  let attempts = 0;
  const kernel = await ServerKernel.create(
    createConfig({ database: ':memory:', worldSize: 2, paused: true }),
    {
      now: () => CLOCK,
      deliverNotifications: (batch) => {
        attempts++;
        if (attempts === 1) {
          firstAttempt.resolve();
          return Promise.reject(new Error('mail server down'));
        }
        delivered.push(batch);
        return Promise.resolve();
      },
    },
  );
  try {
    const errors: Error[] = [];
    kernel.events.on('error', (error) => errors.push(error));
    const user = await notifiedUser(kernel, 'alice');
    await assert.rejects(kernel.runCronjob('missing'), /^Error: Cronjob "missing" not found$/);
    await kernel.runCronjob('sendNotifications');
    assert.equal(kernel.state.jobs['cron:sendNotifications'], undefined, 'schedule untouched');

    // The commit that queued the batch starts delivery; a failure keeps the batch queued.
    await firstAttempt.promise;
    await settle();
    assert.equal(kernel.state.notificationOutbox.length, 1);
    assert.match(errors[0]?.message ?? '', /Notification delivery failed/);

    await kernel.flushNotifications();
    assert.equal(attempts, 2);
    assert.deepEqual(kernel.state.notificationOutbox, []);
    assert.equal(delivered.length, 1);
    const [batch] = delivered;
    assert.ok(batch);
    assert.deepEqual(
      { userId: batch.userId, email: batch.email, messages: batch.messages, date: batch.date },
      {
        userId: user._id,
        email: 'alice@example.com',
        messages: ['attacked alice\n[msg] (1)'],
        date: CLOCK,
      },
    );
    assert.deepEqual(batch.notifications, [
      { message: 'attacked alice', date: CLOCK - 1, count: 1, type: 'msg' },
    ]);
  } finally {
    await kernel.close();
  }
});

void it('upgrades queued notification batches persisted without source details', async () => {
  const kernel = await ServerKernel.create(
    createConfig({ database: ':memory:', worldSize: 2, paused: true }),
  );
  try {
    const committed = await kernel.exportSnapshot();
    const legacy = { id: 'legacy', userId: 'user', messages: ['hi\nthere\n[attack] (3)', 'plain'] };
    await kernel.importSnapshot({ ...committed, notificationOutbox: [{ ...legacy, date: 5 }] });
    assert.deepEqual(kernel.state.notificationOutbox[0]?.notifications, [
      { message: 'hi\nthere', date: 5, count: 3, type: 'attack' },
      { message: 'plain', date: 5, count: 1, type: 'msg' },
    ]);
    await assert.rejects(
      kernel.importSnapshot({
        ...committed,
        notificationOutbox: [{ ...legacy, date: 5, notifications: [] }],
      }),
      /Invalid notification outbox/,
    );
  } finally {
    await kernel.close();
  }
});

void it('stops wall-clock work on close after in-flight work commits', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'openscreeps-kernel-'));
  const config = createConfig({
    database: join(directory, 'world.sqlite'),
    worldSize: 2,
    paused: true,
  });
  let clock = CLOCK;
  let passes = 0;
  const passing: PromiseWithResolvers<void> = Promise.withResolvers();
  const gate: PromiseWithResolvers<void> = Promise.withResolvers();
  const delivering: PromiseWithResolvers<void> = Promise.withResolvers();
  const release: PromiseWithResolvers<void> = Promise.withResolvers();
  const delivered: string[] = [];
  const kernel = await ServerKernel.create(config, {
    now: () => clock,
    cronjobs: (context) => ({
      ...defaultCronjobs(context),
      probe: {
        interval: 0,
        run: async () => {
          passes++;
          if (passes === 2) {
            passing.resolve();
            await gate.promise;
          }
        },
      },
    }),
    deliverNotifications: async (batch) => {
      delivered.push(batch.userId);
      delivering.resolve();
      await release.promise;
    },
  });
  try {
    await notifiedUser(kernel, 'alice');
    await notifiedUser(kernel, 'bob');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    kernel.start();

    // The first pass queues two batches; delivering the first one blocks outside the lock.
    t.mock.timers.tick(MAINTENANCE_INTERVAL);
    await delivering.promise;
    await settle();
    assert.equal(kernel.state.notificationOutbox.length, 2);
    // A second pass runs meanwhile and blocks inside its mutation.
    clock += 1;
    t.mock.timers.tick(MAINTENANCE_INTERVAL);
    await passing.promise;

    const closing = kernel.close();
    assert.equal(kernel.healthy, false);
    gate.resolve();
    release.resolve();
    await closing;
    assert.equal(delivered.length, 1, 'no new delivery starts while closing');
    t.mock.timers.tick(10 * MAINTENANCE_INTERVAL);
    assert.equal(passes, 2, 'no pass runs after close');
    await assert.rejects(
      kernel.read(() => undefined),
      /Server is closing/,
    );
    t.mock.timers.reset();

    const reopened = await ServerKernel.create(config);
    try {
      assert.equal(reopened.state.jobs['cron:probe'], clock, 'the in-flight pass committed');
      assert.equal(reopened.state.notificationOutbox.length, 1, 'the delivered batch was removed');
      assert.notEqual(reopened.state.notificationOutbox[0]?.userId, delivered[0]);
    } finally {
      await reopened.close();
    }
  } finally {
    gate.resolve();
    release.resolve();
    await kernel.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
