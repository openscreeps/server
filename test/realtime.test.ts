import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import { inflateSync } from 'node:zlib';
import {
  BotRuntime,
  createWorldState,
  type UserRunResult,
  type WorldState,
} from '@openscreeps/game';
import SockJS from 'sockjs-client';
import { createAuthService, issueApiToken } from '../src/api/auth.ts';
import { setUserPassword } from '../src/api/users.ts';
import { createConfig } from '../src/config.ts';
import type { ApiContext, ServerEvents, ServerState, TickEvent } from '../src/contracts.ts';
import { htmlEncode } from '../src/realtime/encode.ts';
import { RealtimeHub } from '../src/realtime/hub.ts';
import { installRealtime } from '../src/realtime/index.ts';
import { MessagesService } from '../src/services/messages.ts';
import { ApiTokensService } from '../src/services/api-tokens.ts';

const ALICE = 'a12';
/** A prefix of Alice's id: upstream let `user:a1` subscribe to `user:a12/...`. */
const BOB = 'a1';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function fixtureWorld(): WorldState {
  return createWorldState({
    gameTime: 100,
    rooms: {
      W1N1: { _id: 'W1N1', status: 'normal' },
      W2N1: { _id: 'W2N1', status: 'normal' },
      W3N1: { _id: 'W3N1', status: 'normal' },
    },
    terrain: { W1N1: '0'.repeat(2500), W2N1: '0'.repeat(2500), W3N1: '0'.repeat(2500) },
    users: {
      [ALICE]: {
        _id: ALICE,
        username: 'Alice',
        badge: {
          type: 1,
          color1: '#ff0000',
          color2: '#00ff00',
          color3: '#0000ff',
          param: 0,
          flip: false,
        },
        money: 12500,
        resources: { pixel: 3 },
      },
      [BOB]: { _id: BOB, username: 'Bob' },
    },
    roomObjects: {
      c1: {
        _id: 'c1',
        type: 'creep',
        name: 'Worker',
        user: ALICE,
        room: 'W1N1',
        x: 10,
        y: 10,
        body: [
          { type: 'work', hits: 100 },
          { type: 'carry', hits: 100 },
          { type: 'move', hits: 100 },
        ],
        store: { energy: 50, H: 5 },
        storeCapacity: 50,
        hits: 300,
        hitsMax: 300,
        actionLog: { harvest: null, say: null },
      },
      s1: {
        _id: 's1',
        type: 'source',
        room: 'W1N1',
        x: 20,
        y: 20,
        energy: 3000,
        energyCapacity: 3000,
      },
      k1: {
        _id: 'k1',
        type: 'controller',
        room: 'W1N1',
        x: 30,
        y: 30,
        level: 0,
        reservation: { user: BOB, endTime: 500 },
      },
      i1: { _id: 'i1', type: 'creep', name: 'Invader', user: '2', room: 'W1N1', x: 40, y: 40 },
      c2: { _id: 'c2', type: 'creep', name: 'Scout', user: ALICE, room: 'W2N1', x: 5, y: 5 },
      c3: { _id: 'c3', type: 'creep', name: 'Far', user: ALICE, room: 'W3N1', x: 6, y: 6 },
    },
    flags: { f1: { _id: 'f1', user: ALICE, room: 'W1N1', data: 'Flag1~1~1~25~25' } },
    mapViews: { W1N1: { w: [[0, 0]], [ALICE]: [[10, 10]] } },
  });
}

interface Harness {
  context: ApiContext;
  state: ServerState;
  runtime: BotRuntime;
  token(userId: string): Promise<string>;
  /** Commits a tick (after `change`) and emits its event; resolves to the new game time. */
  tick(options?: {
    change?: (world: WorldState) => void;
    users?: Record<string, Partial<UserRunResult>>;
  }): Promise<number>;
}

function harness(): Harness {
  const runtime = new BotRuntime();
  cleanup.push(() => {
    runtime.dispose();
  });
  const state: ServerState = {
    version: 1,
    world: fixtureWorld(),
    runtime: runtime.snapshot(),
    profiles: { [ALICE]: { registeredDate: 0 }, [BOB]: { registeredDate: 0 } },
    branches: {
      b1: {
        _id: 'b1',
        user: ALICE,
        branch: 'default',
        modules: { main: 'module.exports.loop = () => {};' },
        activeWorld: true,
        activeSim: false,
        timestamp: 5,
      },
    },
    tokens: {},
    apiTokens: {},
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
  // Serialized like the kernel's lock; a mutation's publications are delivered once it commits.
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => T | Promise<T>): Promise<T> => {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const events = new EventEmitter<ServerEvents>();
  let publications: Array<() => void> | undefined;
  const base = {
    config: createConfig({ database: ':memory:', socketUpdateThrottle: 0 }),
    state,
    runtime,
    events,
    now: () => Date.now(),
    read: serialize,
    mutate: <T>(operation: () => T | Promise<T>): Promise<T> =>
      serialize(async () => {
        const pending: Array<() => void> = [];
        publications = pending;
        let result: T;
        try {
          result = await operation();
        } catch (error) {
          publications = undefined;
          throw error;
        }
        publications = undefined;
        for (const deliver of pending) deliver();
        return result;
      }),
    publish: (channel: string, data: unknown) => {
      if (!publications) throw new Error('Publish must occur inside a mutation');
      publications.push(() => {
        events.emit('message', channel, data);
      });
    },
    terrainChanged: () => undefined,
    step: () => Promise.reject(new Error('not used')),
    setPaused: () => Promise.resolve(),
    setTickDuration: () => Promise.resolve(),
  };
  const context: ApiContext = { ...base, auth: createAuthService(base) };
  context.events.on('error', (error) => {
    throw error;
  });
  return {
    context,
    state,
    runtime,
    token: (userId) => context.mutate(() => context.auth.issue(userId)),
    async tick({ change, users = {} } = {}) {
      const processed = await context.mutate(() => {
        change?.(state.world);
        return state.world.gameTime++;
      });
      const event: TickEvent = {
        simulation: {
          gameTime: processed,
          processedRooms: [],
          history: {},
          roomStats: {},
          errors: [],
        },
        runtime: {
          intents: {},
          users: Object.fromEntries(
            Object.entries(users).map(([userId, result]) => [
              userId,
              {
                userId,
                intents: { rooms: {} },
                console: { log: [], results: [] },
                visual: {},
                cpu: { used: 0, charged: 0, limit: 100, bucket: 10000 },
                memorySize: 0,
                memoryRejected: false,
                reset: false,
                halted: false,
                ...result,
              },
            ]),
          ),
        },
        timestamp: Date.now(),
        maintenance: { ran: [], errors: [], notifications: [] },
      };
      context.events.emit('tick', event);
      return processed + 1;
    },
  };
}

function parseEvent(line: string): [string, unknown] | undefined {
  if (!line.startsWith('[')) return undefined;
  const parsed: unknown = JSON.parse(line);
  return Array.isArray(parsed) && typeof parsed[0] === 'string'
    ? [parsed[0], parsed[1]]
    : undefined;
}

function field(data: unknown, key: string): unknown {
  assert.ok(typeof data === 'object' && data !== null, `${key} of an object`);
  return Reflect.get(data, key);
}

function atGameTime(gameTime: number): (data: unknown) => boolean {
  return (data) =>
    typeof data === 'object' && data !== null && 'gameTime' in data && data.gameTime === gameTime;
}

/** Received frames, decoded like the client (`pako.ungzip(atob(...))` for `gz:` frames). */
class Inbox {
  readonly frames: string[] = [];
  readonly lines: string[] = [];
  closed = false;
  readonly closing: PromiseWithResolvers<void> = Promise.withResolvers();
  /** Lines already returned by `next`; each line is returned at most once. */
  readonly #consumed = new Set<number>();
  readonly #waiters = new Set<() => void>();

  push(frame: string): void {
    this.frames.push(frame);
    this.lines.push(
      frame.startsWith('gz:')
        ? inflateSync(Buffer.from(frame.slice(3), 'base64')).toString('utf8')
        : frame,
    );
    this.#wake();
  }

  close(): void {
    this.closed = true;
    this.closing.resolve();
  }

  #wake(): void {
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  /** The earliest line not returned before that satisfies `match`. */
  async next(match: (line: string) => boolean, description: string): Promise<string> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const index = this.lines.findIndex(
        (line, position) => !this.#consumed.has(position) && match(line),
      );
      if (index >= 0) {
        this.#consumed.add(index);
        return this.lines[index] ?? '';
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        assert.fail(`Timed out waiting for ${description}; received ${JSON.stringify(this.lines)}`);
      // The deadline only bounds a failing wait; arrivals resolve it immediately.
      const { promise, resolve }: PromiseWithResolvers<void> = Promise.withResolvers();
      const guard = setTimeout(resolve, remaining);
      this.#waiters.add(resolve);
      await promise;
      clearTimeout(guard);
    }
  }

  /** Data of the earliest event on `channel` not returned before. */
  async event(channel: string, accept: (data: unknown) => boolean = () => true): Promise<unknown> {
    const line = await this.next((candidate) => {
      const parsed = parseEvent(candidate);
      return parsed?.[0] === channel && accept(parsed[1]);
    }, `event ${channel}`);
    return parseEvent(line)?.[1];
  }

  /** Data of every event received on `channel`. */
  events(channel: string): unknown[] {
    return this.lines.flatMap((line) => {
      const parsed = parseEvent(line);
      return parsed?.[0] === channel ? [parsed[1]] : [];
    });
  }
}

interface TestClient {
  inbox: Inbox;
  send(message: string): void;
}

/** A session on the hub with a synchronous in-memory transport. */
function connect(hub: RealtimeHub): TestClient {
  const inbox = new Inbox();
  const connection = hub.connect({
    write: (message) => {
      inbox.push(message);
    },
    close: () => {
      inbox.close();
    },
  });
  assert.ok(connection);
  return {
    inbox,
    send: (message) => {
      connection.receive(message);
    },
  };
}

function startHub(h: Harness, random?: () => number): RealtimeHub {
  const hub = new RealtimeHub(h.context, random);
  cleanup.push(() => {
    hub.close();
  });
  return hub;
}

async function signIn(h: Harness, client: TestClient, userId: string): Promise<string> {
  client.send(`auth ${await h.token(userId)}`);
  const line = await client.inbox.next((candidate) => candidate.startsWith('auth '), 'auth reply');
  const token = /^auth ok (.+)$/.exec(line)?.[1];
  assert.ok(token, line);
  return token;
}

void describe('realtime sessions', () => {
  void it('greets with time and protocol 14 and rotates the token on authentication', async () => {
    const h = harness();
    const client = connect(startHub(h));
    assert.match(client.inbox.lines[0] ?? '', /^time \d+$/);
    assert.equal(client.inbox.lines[1], 'protocol 14');
    const original = await h.token(ALICE);
    client.send(`auth ${original}`);
    const issued = /^auth ok (.+)$/.exec(
      await client.inbox.next((line) => line.startsWith('auth '), 'auth'),
    )?.[1];
    assert.ok(issued);
    assert.notEqual(issued, original);
    assert.equal(await h.context.read(() => h.context.auth.check(issued)), ALICE);
    assert.equal(typeof h.state.profiles[ALICE]?.lastOnline, 'number');
    client.send('auth 0000');
    assert.equal(
      await client.inbox.next((line) => line.startsWith('auth '), 'second auth'),
      'auth failed',
    );
  });

  void it('sends the full room, then exact diffs with flags, visuals and new users', async () => {
    const h = harness();
    const client = connect(startHub(h));
    await signIn(h, client, ALICE);
    client.send('subscribe room:W1N1');
    const full = await client.inbox.event('room:W1N1');
    const objects = field(full, 'objects');
    assert.deepEqual(Object.keys(objects as object).sort(), ['c1', 'i1', 'k1', 's1']);
    assert.deepEqual(field(objects, 'c1'), h.state.world.roomObjects.c1);
    assert.deepEqual(field(full, 'users'), {
      [ALICE]: { _id: ALICE, username: 'Alice', badge: h.state.world.users[ALICE]?.badge },
      [BOB]: { _id: BOB, username: 'Bob' },
      '2': { _id: '2', username: 'Invader' },
      '3': { _id: '3', username: 'Source Keeper' },
    });
    assert.equal(field(full, 'flags'), 'Flag1~1~1~25~25');
    assert.deepEqual(field(full, 'info'), { mode: 'world' });
    assert.equal(field(full, 'gameTime'), 100);

    const gameTime = await h.tick({
      change: (world) => {
        const worker = world.roomObjects.c1;
        assert.ok(worker);
        worker.x = 11;
        worker.store = { energy: 50 };
        worker.actionLog = { harvest: { x: 20, y: 20 }, say: null };
        world.roomObjects.c9 = {
          _id: 'c9',
          type: 'creep',
          name: 'New',
          user: 'u9',
          room: 'W1N1',
          x: 1,
          y: 1,
        };
        world.users.u9 = { _id: 'u9', username: 'Newcomer' };
        Reflect.deleteProperty(world.roomObjects, 's1');
        Reflect.deleteProperty(world.flags, 'f1');
      },
      users: { [ALICE]: { visual: { '': 'global\n', W1N1: 'room\n', W2N1: 'other\n' } } },
    });
    assert.deepEqual(await client.inbox.event('room:W1N1', atGameTime(gameTime)), {
      objects: {
        s1: null,
        c1: { x: 11, store: { H: null }, actionLog: { harvest: { x: 20, y: 20 } } },
        c9: h.state.world.roomObjects.c9,
      },
      gameTime,
      visual: 'global\nroom\n',
      users: { u9: { _id: 'u9', username: 'Newcomer' } },
      info: { mode: 'world' },
    });

    const quiet = await h.tick();
    assert.deepEqual(await client.inbox.event('room:W1N1', atGameTime(quiet)), {
      objects: {},
      gameTime: quiet,
      visual: '',
      info: { mode: 'world' },
    });
  });

  void it('streams console, cpu, memory, resources, map views and map visuals to their owner', async () => {
    const h = harness();
    const client = connect(startHub(h));
    await signIn(h, client, ALICE);
    const memory = JSON.stringify({ stats: { count: 3 }, list: [1, 2] });
    await h.context.mutate(() => {
      h.runtime.setMemory(ALICE, memory);
    });
    for (const channel of [
      `user:${ALICE}/console`,
      `user:${ALICE}/cpu`,
      `user:${ALICE}/resources`,
      `user:${ALICE}/memory/stats.count`,
      `user:${ALICE}/memory/list`,
      `user:${ALICE}/memory/missing.deeper`,
      `mapVisual:${ALICE}`,
      'roomMap2:W1N1',
    ]) {
      client.send(`subscribe ${channel}`);
    }
    assert.deepEqual(await client.inbox.event(`user:${ALICE}/cpu`), {
      cpu: 0,
      memory: memory.length,
    });
    assert.deepEqual(await client.inbox.event(`user:${ALICE}/resources`), {
      pixel: 3,
      credits: 12.5,
    });
    assert.equal(await client.inbox.event(`user:${ALICE}/memory/stats.count`), '3');
    assert.equal(await client.inbox.event(`user:${ALICE}/memory/list`), '1,2');
    assert.equal(
      await client.inbox.event(`user:${ALICE}/memory/missing.deeper`),
      'Incorrect memory path',
    );
    assert.equal(await client.inbox.event(`mapVisual:${ALICE}`), null);
    assert.deepEqual(await client.inbox.event('roomMap2:W1N1'), h.state.world.mapViews.W1N1);

    await h.context.mutate(() => {
      h.runtime.setMemory(ALICE, JSON.stringify({ stats: { count: 4 } }));
    });
    await h.tick({
      change: (world) => {
        world.mapViews.W1N1 = { w: [[1, 1]] };
      },
      users: {
        [ALICE]: {
          console: {
            log: [
              { message: '<b>"hi" & \u{1F600}</b>', escape: true },
              { message: '<i>unsafe</i>', escape: false },
            ],
            results: ['42'],
            error: 'Error: CPU limit reached',
          },
          cpu: { used: 1.5, charged: 1.5, limit: 100, bucket: 9000 },
          memorySize: 20,
          visual: { map: 'mapline\n' },
        },
      },
    });
    assert.deepEqual(await client.inbox.event(`user:${ALICE}/console`), {
      messages: {
        log: ['&#x3C;b&#x3E;&#x22;hi&#x22; &#x26; &#x1F600;&#x3C;/b&#x3E;', '<i>unsafe</i>'],
        results: ['42'],
      },
    });
    assert.deepEqual(await client.inbox.event(`user:${ALICE}/console`), {
      error: 'Error: CPU limit reached',
    });
    assert.deepEqual(await client.inbox.event(`user:${ALICE}/cpu`), { cpu: 'error', memory: 20 });
    assert.deepEqual(await client.inbox.event('roomMap2:W1N1'), { w: [[1, 1]] });
    assert.equal(await client.inbox.event(`mapVisual:${ALICE}`), 'mapline\n');
    assert.deepEqual(await client.inbox.event(`user:${ALICE}/resources`), {
      pixel: 3,
      credits: 12.5,
    });
    assert.equal(await client.inbox.event(`user:${ALICE}/memory/stats.count`), '4');
    assert.equal(await client.inbox.event(`user:${ALICE}/memory/list`), 'undefined');

    // Every successful run publishes messages, which clears the client's error marker.
    await h.tick({ users: { [ALICE]: {} } });
    assert.deepEqual(await client.inbox.event(`user:${ALICE}/console`), {
      messages: { log: [], results: [] },
    });
  });

  void it('never delivers another user’s channels, to anonymous or prefix-sharing users', async () => {
    const h = harness();
    const hub = startHub(h);
    const anonymous = connect(hub);
    const bob = connect(hub);
    const alice = connect(hub);
    await signIn(h, bob, BOB);
    await signIn(h, alice, ALICE);
    const foreign = [
      'room:W1N1',
      'roomMap2:W1N1',
      `user:${ALICE}/console`,
      `user:${ALICE}/cpu`,
      `user:${ALICE}/resources`,
      `user:${ALICE}/memory/stats`,
      `user:${ALICE}/newMessage`,
      `mapVisual:${ALICE}`,
      'server-message',
    ];
    for (const channel of foreign) anonymous.send(`subscribe ${channel}`);
    for (const channel of foreign.slice(2)) bob.send(`subscribe ${channel}`);
    bob.send(`subscribe user:${BOB}/console`);
    bob.send(`subscribe user:${BOB}/resources`);
    alice.send(`subscribe user:${ALICE}/console`);
    alice.send('subscribe room:W1N1');
    await alice.inbox.event('room:W1N1');
    await bob.inbox.event(`user:${BOB}/resources`);
    await h.context.mutate(() => {
      h.runtime.setMemory(ALICE, '{"stats":1}');
    });
    const gameTime = await h.tick({
      users: {
        [ALICE]: {
          console: { log: [{ message: 'secret', escape: true }], results: [] },
          visual: { map: 'x' },
        },
        [BOB]: { console: { log: [{ message: 'bob', escape: true }], results: [] } },
      },
    });
    h.context.events.emit('message', `user:${ALICE}/newMessage`, { message: { text: 'private' } });
    await alice.inbox.event('room:W1N1', atGameTime(gameTime));
    // Bob's own flush-driven channel shows the update after this tick was sent to him.
    await bob.inbox.event(`user:${BOB}/resources`);
    assert.deepEqual(await bob.inbox.event(`user:${BOB}/console`), {
      messages: { log: ['bob'], results: [] },
    });
    h.context.events.emit('message', 'serverMessage', 'barrier');
    assert.equal(await anonymous.inbox.event('server-message'), 'barrier');
    assert.equal(await bob.inbox.event('server-message'), 'barrier');
    const leaked = (lines: string[]): string[] =>
      lines.filter(
        (line) =>
          line.startsWith('[') &&
          !line.startsWith('["server-message"') &&
          !line.startsWith(`["user:${BOB}/`),
      );
    assert.deepEqual(leaked(anonymous.inbox.lines), []);
    assert.deepEqual(leaked(bob.inbox.lines), []);
  });

  void it('drops the previous identity’s subscriptions when authentication fails or changes user', async () => {
    const h = harness();
    const hub = startHub(h);
    const client = connect(hub);
    const observer = connect(hub);
    await signIn(h, client, ALICE);
    await signIn(h, observer, BOB);
    observer.send(`subscribe user:${BOB}/resources`);
    await observer.inbox.event(`user:${BOB}/resources`);
    client.send('subscribe server-message');
    client.send(`subscribe user:${ALICE}/console`);
    client.send('subscribe room:W1N1');
    await client.inbox.event('room:W1N1');

    client.send('auth invalid');
    assert.equal(
      await client.inbox.next((line) => line.startsWith('auth '), 'auth failed'),
      'auth failed',
    );
    await h.tick({
      users: { [ALICE]: { console: { log: [{ message: 'x', escape: true }], results: [] } } },
    });
    await observer.inbox.event(`user:${BOB}/resources`);
    h.context.events.emit('message', 'serverMessage', 'one');
    assert.equal(await client.inbox.event('server-message'), 'one');
    assert.equal(client.inbox.events('room:W1N1').length, 1);
    assert.deepEqual(client.inbox.events(`user:${ALICE}/console`), []);

    await signIn(h, client, ALICE);
    client.send(`subscribe user:${ALICE}/console`);
    await signIn(h, client, BOB);
    await h.tick({ users: { [ALICE]: {} } });
    await observer.inbox.event(`user:${BOB}/resources`);
    h.context.events.emit('message', 'serverMessage', 'two');
    assert.equal(await client.inbox.event('server-message'), 'two');
    assert.deepEqual(client.inbox.events(`user:${ALICE}/console`), []);
  });

  void it('serves two of a user’s rooms per update in a new random room order', async () => {
    const h = harness();
    // `_.shuffle` draws, one per subscribed room; position i swaps with floor(draw * (i + 1)).
    const draws: number[] = [];
    const hub = startHub(h, () => {
      const draw = draws.shift();
      if (draw === undefined) throw new Error('unplanned room order draw');
      return draw;
    });
    const first = connect(hub);
    const second = connect(hub);
    const third = connect(hub);
    for (const client of [first, second, third]) await signIn(h, client, ALICE);
    // Before any update counted Alice's rooms, every subscription gets its full room at once.
    first.send('subscribe room:W1N1');
    await first.inbox.event('room:W1N1');
    first.send('subscribe room:W2N1');
    await first.inbox.event('room:W2N1');
    second.send('subscribe room:W3N1');
    await second.inbox.event('room:W3N1');
    second.send('subscribe room:W9N9');

    // Order W3N1, W2N1, W1N1: the oldest subscription is the one skipped.
    draws.push(0, 0.5, 0);
    const skipOldest = await h.tick();
    await first.inbox.event('room:W2N1', atGameTime(skipOldest));
    await second.inbox.event('room:W3N1', atGameTime(skipOldest));
    assert.equal(await first.inbox.event('err@room:W1N1'), 'subscribe limit reached');
    assert.deepEqual(first.inbox.events('room:W1N1').filter(atGameTime(skipOldest)), []);

    // The latest update counted three rooms: a new subscription waits for an update.
    third.send('subscribe room:W1N1');
    assert.equal(await third.inbox.event('err@room:W1N1'), 'subscribe limit reached');
    assert.deepEqual(third.inbox.events('room:W1N1'), []);

    // Order W1N1, W2N1, W3N1: both W1N1 subscriptions fill the limit, the others are skipped.
    draws.push(0, 0.99, 0.99);
    const skipNewest = await h.tick();
    const resumed = await first.inbox.event('room:W1N1', atGameTime(skipNewest));
    assert.deepEqual(field(resumed, 'objects'), {});
    const joined = await third.inbox.event('room:W1N1', atGameTime(skipNewest));
    assert.deepEqual(Object.keys(field(joined, 'objects') as object).sort(), [
      'c1',
      'i1',
      'k1',
      's1',
    ]);
    assert.equal(await first.inbox.event('err@room:W2N1'), 'subscribe limit reached');
    assert.equal(await second.inbox.event('err@room:W3N1'), 'subscribe limit reached');
    assert.deepEqual(first.inbox.events('room:W2N1').filter(atGameTime(skipNewest)), []);
    assert.deepEqual(second.inbox.events('room:W3N1').filter(atGameTime(skipNewest)), []);

    // Skipped subscriptions are told again on every update, like upstream.
    draws.push(0, 0.99, 0.99);
    const again = await h.tick();
    await third.inbox.event('room:W1N1', atGameTime(again));
    assert.equal(await first.inbox.event('err@room:W2N1'), 'subscribe limit reached');
    assert.equal(await second.inbox.event('err@room:W3N1'), 'subscribe limit reached');
    assert.deepEqual(second.inbox.events('room:W9N9'), []);
    assert.deepEqual(second.inbox.events('err@room:W9N9'), []);
  });

  void it('resolves code publications from the committed branch of the subscriber', async () => {
    const h = harness();
    const client = connect(startHub(h));
    await signIn(h, client, ALICE);
    client.send(`subscribe user:${ALICE}/code`);
    client.send(`subscribe user:${ALICE}/set-active-branch`);
    // Commands run in order: the authentication reply proves both subscriptions are registered.
    await signIn(h, client, ALICE);
    h.context.events.emit('message', `user:${ALICE}/set-active-branch`, {
      activeName: 'activeWorld',
      branch: 'default',
    });
    assert.deepEqual(await client.inbox.event(`user:${ALICE}/set-active-branch`), {
      activeName: 'activeWorld',
      branch: 'default',
    });
    h.context.events.emit('message', `user:${ALICE}/code`, { id: 'missing' });
    h.context.events.emit('message', `user:${ALICE}/code`, { id: 'b1', hash: 7 });
    assert.deepEqual(await client.inbox.event(`user:${ALICE}/code`), {
      branch: 'default',
      modules: { main: 'module.exports.loop = () => {};' },
      timestamp: 5,
      hash: 7,
    });
    assert.equal(client.inbox.events(`user:${ALICE}/code`).length, 1);
  });

  void it('closes every session of a user once a password change commits, never on rollback', async () => {
    const h = harness();
    const hub = startHub(h);
    const alice = connect(hub);
    const bob = connect(hub);
    const anonymous = connect(hub);
    await signIn(h, alice, ALICE);
    await signIn(h, bob, BOB);
    alice.send(`subscribe user:${ALICE}/console`);
    bob.send('subscribe server-message');
    anonymous.send('subscribe server-message');
    const secret = (message: string): Partial<UserRunResult> => ({
      console: { log: [{ message, escape: true }], results: [] },
    });

    // A transaction that fails after the password change publishes nothing; malformed
    // revocations are ignored. The session keeps receiving its private channels.
    await assert.rejects(
      h.context.mutate(() => {
        setUserPassword(h.context, ALICE, 'rolled back password');
        throw new Error('abort');
      }),
      /abort/,
    );
    h.context.events.emit('message', 'auth:revoked', { user: 7 });
    await h.tick({ users: { [ALICE]: secret('before') } });
    assert.deepEqual(await alice.inbox.event(`user:${ALICE}/console`), {
      messages: { log: ['before'], results: [] },
    });
    assert.equal(alice.inbox.closed, false);

    const second = connect(hub);
    const stale = await signIn(h, second, ALICE);
    await h.context.mutate(() => {
      setUserPassword(h.context, ALICE, 'correct horse battery');
    });
    // Delivered with the commit: both of Alice's sessions are closed, nobody else's.
    assert.equal(alice.inbox.closed, true);
    assert.equal(second.inbox.closed, true);
    assert.equal(bob.inbox.closed, false);
    assert.equal(anonymous.inbox.closed, false);

    await h.tick({ users: { [ALICE]: secret('after') } });
    await h.context.mutate(() => {
      h.context.publish('serverMessage', 'barrier');
    });
    assert.equal(await bob.inbox.event('server-message'), 'barrier');
    assert.equal(await anonymous.inbox.event('server-message'), 'barrier');
    assert.equal(alice.inbox.events(`user:${ALICE}/console`).length, 1);
    const retry = connect(hub);
    retry.send(`auth ${stale}`);
    assert.equal(
      await retry.inbox.next((line) => line.startsWith('auth '), 'auth reply'),
      'auth failed',
    );
  });

  void it('returns an API token unchanged and closes only its sessions once it is deleted', async () => {
    const h = harness();
    const hub = startHub(h);
    const apiToken = await h.context.mutate(() => issueApiToken(h.context, ALICE, null));
    const viaToken = connect(hub);
    viaToken.send(`auth ${apiToken}`);
    assert.equal(
      await viaToken.inbox.next((line) => line.startsWith('auth '), 'auth reply'),
      `auth ok ${apiToken}`,
    );
    // No session token was issued for it.
    assert.deepEqual(h.state.tokens, {});
    const viaSession = connect(hub);
    await signIn(h, viaSession, ALICE);
    viaToken.send(`subscribe user:${ALICE}/console`);

    const tokenId = await h.context.read(() => h.context.auth.apiTokenId(apiToken));
    assert.ok(tokenId);
    const service = new ApiTokensService(h.context);
    await h.context.mutate(() =>
      service.delete({
        query: new URLSearchParams(),
        body: { tokenId },
        userId: ALICE,
        headers: {},
      }),
    );
    assert.equal(viaToken.inbox.closed, true);
    assert.equal(viaSession.inbox.closed, false);
    const retry = connect(hub);
    retry.send(`auth ${apiToken}`);
    assert.equal(
      await retry.inbox.next((line) => line.startsWith('auth '), 'auth reply'),
      'auth failed',
    );
  });

  void it('fails an authentication whose token rotation races a committed revocation', async () => {
    const h = harness();
    let afterMutation: (() => Promise<void>) | undefined;
    // The revocation commits right after the hub's token rotation, before the hub resumes.
    const hub = startHub({
      ...h,
      context: {
        ...h.context,
        mutate: async <T>(operation: () => T | Promise<T>): Promise<T> => {
          const result = await h.context.mutate(operation);
          const hook = afterMutation;
          afterMutation = undefined;
          await hook?.();
          return result;
        },
      },
    });
    const client = connect(hub);
    const token = await h.token(ALICE);
    afterMutation = () =>
      h.context.mutate(() => {
        setUserPassword(h.context, ALICE, 'changed during rotation');
      });
    client.send(`auth ${token}`);
    assert.equal(
      await client.inbox.next((line) => line.startsWith('auth '), 'auth reply'),
      'auth failed',
    );
    assert.equal(afterMutation, undefined);
    assert.ok(Object.values(h.state.tokens).every((entry) => entry.userId !== ALICE));
    client.send(`subscribe user:${ALICE}/console`);
    client.send('auth invalid');
    assert.equal(
      await client.inbox.next((line) => line.startsWith('auth '), 'second auth reply'),
      'auth failed',
    );
    await h.tick({
      users: { [ALICE]: { console: { log: [{ message: 'x', escape: true }], results: [] } } },
    });
    assert.deepEqual(client.inbox.events(`user:${ALICE}/console`), []);
  });

  void it('closes every connection when the world is reset', async () => {
    const h = harness();
    const hub = startHub(h);
    const client = connect(hub);
    await signIn(h, client, ALICE);
    h.context.events.emit('reset');
    assert.equal(client.inbox.closed, true);
    assert.ok(connect(hub).inbox.lines.includes('protocol 14'));
  });
});

/** The official SockJS client library, as bundled by the game client. */
class SockClient {
  readonly inbox = new Inbox();
  readonly socket: WebSocket;
  readonly opened: Promise<void>;

  constructor(url: string, transport: string) {
    this.socket = new SockJS(url, null, { transports: [transport] });
    const { promise, resolve, reject }: PromiseWithResolvers<void> = Promise.withResolvers();
    this.opened = promise;
    this.socket.onopen = () => {
      resolve();
    };
    this.socket.onerror = () => {
      reject(new Error(`${transport} failed`));
    };
    this.socket.onmessage = (event: { data: unknown }) => {
      this.inbox.push(String(event.data));
    };
    this.socket.onclose = () => {
      this.inbox.close();
    };
    cleanup.push(() => {
      this.socket.close();
    });
  }
}

async function listen(h: Harness): Promise<string> {
  const server = createServer((_request, response) => {
    response.end('api');
  });
  const realtime = installRealtime(server, h.context);
  const listening: PromiseWithResolvers<void> = Promise.withResolvers();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  cleanup.push(() => {
    realtime.close();
    server.closeAllConnections();
    const closed: PromiseWithResolvers<void> = Promise.withResolvers();
    server.close(() => {
      closed.resolve();
    });
    return closed.promise;
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return `http://127.0.0.1:${String(address.port)}`;
}

/** Status of a raw POST, or `undefined` when the server drops the connection unanswered. */
function post(url: string, body: Buffer, chunked: boolean): Promise<number | undefined> {
  const { promise, resolve }: PromiseWithResolvers<number | undefined> = Promise.withResolvers();
  const headers = chunked
    ? { 'transfer-encoding': 'chunked' }
    : { 'content-length': String(body.length) };
  const request = httpRequest(url, { method: 'POST', headers }, (response) => {
    response.resume();
    resolve(response.statusCode);
  });
  request.on('error', () => {
    resolve(undefined);
  });
  request.end(body);
  return promise;
}

void describe('SockJS endpoint', () => {
  void it('serves the official client over websocket with gzip frames and leaves other requests alone', async () => {
    const h = harness();
    const base = await listen(h);
    assert.equal(await (await fetch(`${base}/api/version`)).text(), 'api');
    const client = new SockClient(`${base}/socket`, 'websocket');
    await client.opened;
    await client.inbox.next((line) => line === 'protocol 14', 'protocol');
    client.socket.send('gzip on');
    client.socket.send(`auth ${await h.token(ALICE)}`);
    await client.inbox.next((line) => line.startsWith('auth ok '), 'auth ok');
    client.socket.send('subscribe room:W1N1');
    client.socket.send(`subscribe user:${ALICE}/resources`);
    const full = await client.inbox.event('room:W1N1');
    assert.deepEqual(field(field(full, 'objects'), 'c1'), h.state.world.roomObjects.c1);
    assert.ok(client.inbox.frames.some((frame) => frame.startsWith('gz:')));
    await client.inbox.event(`user:${ALICE}/resources`);

    const gameTime = await h.tick({
      change: (world) => {
        const worker = world.roomObjects.c1;
        assert.ok(worker);
        worker.y = 12;
      },
    });
    const update = await client.inbox.event('room:W1N1', atGameTime(gameTime));
    assert.deepEqual(field(update, 'objects'), { c1: { y: 12 } });
    await client.inbox.event(`user:${ALICE}/resources`);

    client.socket.send('unsubscribe room:W1N1');
    // Commands run in order: the authentication reply proves the unsubscription happened.
    client.socket.send(`auth ${await h.token(ALICE)}`);
    await client.inbox.next((line) => line.startsWith('auth ok '), 'second auth ok');
    const later = await h.tick();
    // Room updates precede the other channels of the same update, and sends stay ordered.
    await client.inbox.event(`user:${ALICE}/resources`);
    assert.equal(client.inbox.events('room:W1N1').filter(atGameTime(later)).length, 0);
    client.socket.close();
    await client.inbox.closing.promise;
  });

  void it('delivers sent messages with ISO dates to both parties over real sockets', async () => {
    const h = harness();
    const base = await listen(h);
    const open = async (userId: string, channels: string[]): Promise<SockClient> => {
      const client = new SockClient(`${base}/socket`, 'websocket');
      await client.opened;
      client.socket.send(`auth ${await h.token(userId)}`);
      for (const channel of channels) client.socket.send(`subscribe ${channel}`);
      // Commands run in order: a second authentication reply proves the subscriptions happened.
      client.socket.send(`auth ${await h.token(userId)}`);
      await client.inbox.next((line) => line.startsWith('auth ok '), 'first auth ok');
      await client.inbox.next((line) => line.startsWith('auth ok '), 'second auth ok');
      return client;
    };
    const alice = await open(ALICE, [`user:${ALICE}/message:${BOB}`]);
    const bob = await open(BOB, [`user:${BOB}/message:${ALICE}`, `user:${BOB}/newMessage`]);

    await h.context.mutate(() =>
      new MessagesService(h.context).send({
        query: new URLSearchParams(),
        body: { respondent: BOB, text: 'hi bob' },
        userId: ALICE,
        headers: {},
      }),
    );
    const stored = Object.values(h.state.messages);
    const outMessage = stored.find((message) => message.type === 'out');
    const inMessage = stored.find((message) => message.type === 'in');
    assert.ok(outMessage && inMessage);
    assert.equal(typeof inMessage.date, 'number');
    const iso = new Date(inMessage.date).toISOString();
    assert.deepEqual(await alice.inbox.event(`user:${ALICE}/message:${BOB}`), {
      message: { ...outMessage, date: iso },
    });
    assert.deepEqual(await bob.inbox.event(`user:${BOB}/message:${ALICE}`), {
      message: { ...inMessage, date: iso },
    });
    assert.deepEqual(await bob.inbox.event(`user:${BOB}/newMessage`), {
      message: { ...inMessage, date: iso },
    });
    assert.deepEqual(
      bob.inbox.lines.flatMap((line) => parseEvent(line)?.[0] ?? []),
      [`user:${BOB}/message:${ALICE}`, `user:${BOB}/newMessage`],
    );
  });

  for (const transport of ['xhr-streaming', 'xhr-polling']) {
    void it(`carries the protocol over the ${transport} fallback`, async () => {
      const h = harness();
      const client = new SockClient(`${await listen(h)}/socket`, transport);
      await client.opened;
      await client.inbox.next((line) => line === 'protocol 14', 'protocol');
      client.socket.send('gzip on');
      client.socket.send(`auth ${await h.token(BOB)}`);
      await client.inbox.next((line) => line.startsWith('auth ok '), 'auth ok');
      client.socket.send('subscribe room:W1N1');
      const full = await client.inbox.event('room:W1N1');
      assert.deepEqual(Object.keys(field(full, 'objects') as object).sort(), [
        'c1',
        'i1',
        'k1',
        's1',
      ]);
      assert.equal(field(full, 'flags'), undefined);
      assert.ok(client.inbox.frames.some((frame) => frame.startsWith('gz:')));
    });
  }

  void it('drops fallback POST bodies above the frame limit instead of buffering them', async () => {
    const url = `${await listen(harness())}/socket/000/unknown/xhr_send`;
    // Within the limit SockJS reads the body and answers (no such session).
    assert.equal(await post(url, Buffer.from('["x"]'), false), 404);
    // Above it, declared or streamed, the connection is dropped before SockJS buffers it all.
    assert.equal(await post(url, Buffer.alloc(2 * 1024 * 1024, 0x61), false), undefined);
    assert.equal(await post(url, Buffer.alloc(4 * 1024 * 1024, 0x61), true), undefined);
  });
});

void describe('console escaping', () => {
  void it('matches he.encode with default options', () => {
    assert.equal(
      htmlEncode(`<a href='x'>"&"</a>\``),
      '&#x3C;a href=&#x27;x&#x27;&#x3E;&#x22;&#x26;&#x22;&#x3C;/a&#x3E;&#x60;',
    );
    assert.equal(htmlEncode('line\nnext\r\ttab\0'), 'line\nnext\r&#x9;tab\0');
    assert.equal(htmlEncode('\x7F\x80\x81\x9D\x9F\xA0é'), '&#x7F;\x80&#x81;&#x9D;\x9F&#xA0;&#xE9;');
    assert.equal(htmlEncode('\u{1F600}\uD800x'), '&#x1F600;&#xD800;x');
  });
});
