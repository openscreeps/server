import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { runInNewContext } from 'node:vm';
import { gunzipSync } from 'node:zlib';
import { BotRuntime, createWorldState } from '@openscreeps/game';
import { ApiTestClient, type ApiCallOptions } from './api-harness.ts';
import { createAuthService } from '../src/api/auth.ts';
import { isRecord } from '../src/api/guards.ts';
import { createUser } from '../src/api/users.ts';
import { createConfig } from '../src/config.ts';
import {
  ApiError,
  RawResponse,
  type ApiContext,
  type ServerConfig,
  type ServerEvents,
  type ServerState,
  type UserMessage,
} from '../src/contracts.ts';
import { StateStore } from '../src/services/state-store.service.ts';
import { STEAM_NEWS_TTL_MS } from '../src/services/steam-news.ts';

interface Harness {
  context: ApiContext;
  published: Array<[channel: string, data: unknown]>;
  clock: { now: number };
  call(method: 'GET' | 'POST', path: string, options?: ApiCallOptions): Promise<unknown>;
}

const runtimes: BotRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  mock.restoreAll();
});

function emptyState(runtime: BotRuntime): ServerState {
  return {
    version: 1,
    world: createWorldState(),
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
}

function harness(
  options: { config?: Partial<ServerConfig>; state?: ServerState; now?: number } = {},
): Harness {
  const clock = { now: options.now ?? 1_700_000_000_000 };
  const runtime = new BotRuntime({
    now: () => clock.now,
    ...(options.state ? { snapshot: options.state.runtime } : {}),
  });
  runtimes.push(runtime);
  const state = options.state ?? emptyState(runtime);
  const config = createConfig({ database: ':memory:', ...options.config });
  const published: Harness['published'] = [];
  const base = {
    config,
    state,
    runtime,
    events: new EventEmitter<ServerEvents>(),
    now: () => clock.now,
    read: async <T>(operation: () => T | Promise<T>) => operation(),
    mutate: async <T>(operation: () => T | Promise<T>) => {
      const result = await operation();
      // Commit: the persisted runtime snapshot is taken from the live runtime.
      state.runtime = runtime.snapshot();
      return result;
    },
    publish: (channel: string, data: unknown) => {
      published.push([channel, data]);
    },
    terrainChanged: () => undefined,
    step: () => Promise.reject(new Error('not used')),
    setPaused: () => Promise.resolve(),
    setTickDuration: () => Promise.resolve(),
  };
  const context: ApiContext = { ...base, auth: createAuthService(base) };
  const client = new ApiTestClient(context);
  return {
    context,
    published,
    clock,
    call: (method, path, callOptions) => client.call(method, path, callOptions),
  };
}

function signIn(
  h: Harness,
  username = 'Alice',
  password = 'correct horse',
): {
  userId: string;
  token: string;
} {
  const user = createUser(h.context, { username, password });
  return { userId: user._id, token: h.context.auth.issue(user._id) };
}

async function rejects(promise: Promise<unknown>, message: string, status = 200): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ApiError, String(error));
    assert.equal(error.message, message);
    assert.equal(error.status, status);
    return true;
  });
}

void describe('account authentication', () => {
  void it('signs in with a username or email and never exposes credentials', async () => {
    const h = harness();
    const user = createUser(h.context, {
      username: 'Alice',
      password: 'correct horse',
      email: 'Alice@Example.com',
    });
    const byName = (await h.call('POST', '/api/auth/signin', {
      body: { email: 'alice', password: 'correct horse' },
    })) as { token: string };
    assert.match(byName.token, /^[0-9a-f]{64}$/);
    assert.equal(h.context.auth.check(byName.token), user._id);
    const byEmail = (await h.call('POST', '/api/auth/signin', {
      body: { email: 'alice@example.com', password: 'correct horse' },
    })) as { token: string };
    assert.equal(h.context.auth.check(byEmail.token), user._id);

    // Tokens are persisted only as hashes.
    const persisted = JSON.stringify(h.context.state);
    assert.ok(!persisted.includes(byName.token));
    assert.ok(!persisted.includes('correct horse'));

    const me = await h.call('GET', '/api/auth/me', { token: byName.token });
    const json = JSON.stringify(me);
    assert.ok(!json.includes('scrypt'));
    assert.ok(!json.includes('passwordHash'));
    assert.ok(me && typeof me === 'object' && 'password' in me && 'email' in me);
    assert.deepEqual([me.password, me.email], [true, 'alice@example.com']);

    await rejects(
      h.call('POST', '/api/auth/signin', { body: { email: 'alice', password: 'wrong password' } }),
      'unauthorized',
      401,
    );
    await rejects(
      h.call('POST', '/api/auth/signin', { body: { email: 'nobody', password: 'correct horse' } }),
      'unauthorized',
      401,
    );
  });

  void it('expires tokens and rejects malformed or unknown tokens', async () => {
    const h = harness({ config: { tokenLifetimeMs: 60_000 } });
    const { userId, token } = signIn(h);
    assert.equal(h.context.auth.check(token), userId);
    assert.equal(h.context.auth.check(token.toUpperCase()), undefined);
    assert.equal(h.context.auth.check('0'.repeat(64)), undefined);
    h.clock.now += 60_000;
    assert.equal(h.context.auth.check(token), undefined);
    await rejects(h.call('GET', '/api/auth/me', { token }), 'unauthorized', 401);
    // Issuing prunes expired entries.
    h.context.auth.issue(userId);
    assert.equal(Object.keys(h.context.state.tokens).length, 1);
  });

  void it('validates the user registry', () => {
    const h = harness();
    createUser(h.context, { username: 'Alice', email: 'a@example.com' });
    assert.throws(() => createUser(h.context, { username: 'alice' }), /username already exists/);
    assert.throws(() => createUser(h.context, { username: 'Screeps' }), /username already exists/);
    assert.throws(() => createUser(h.context, { username: 'a b' }), /invalid username/);
    assert.throws(
      () => createUser(h.context, { username: 'Bob', email: 'A@example.com' }),
      /email already exists/,
    );
    assert.throws(
      () => createUser(h.context, { steamId: '1', password: 'longenough' }),
      /requires a username/,
    );
    assert.throws(() => createUser(h.context, { username: 'Bob', password: 'short' }), /password/);
    assert.throws(() => createUser(h.context, {}), /required/);
  });

  void it('creates a default branch and runtime state for new users', () => {
    const h = harness();
    const user = createUser(h.context, { username: 'Alice' });
    const branches = Object.values(h.context.state.branches);
    assert.equal(branches.length, 1);
    assert.deepEqual(
      { ...branches[0], _id: undefined },
      {
        _id: undefined,
        user: user._id,
        branch: 'default',
        modules: { main: '' },
        activeWorld: true,
        activeSim: true,
      },
    );
    assert.deepEqual(h.context.runtime.getCode(user._id), {
      modules: { main: '' },
      branch: 'default',
    });
    assert.equal(h.context.runtime.getMemory(user._id), '{}');
  });

  void it('returns money history dates as ISO strings without changing numeric world logs', async () => {
    const h = harness();
    const alice = signIn(h, 'Alice');
    const bob = signIn(h, 'Bob');
    const entries = Array.from({ length: 21 }, (_, index) => ({
      _id: `money-${String(index)}`,
      user: alice.userId,
      date: h.clock.now - index * 1000,
      tick: 100 - index,
      type: 'market.sell',
      balance: 1000,
      change: 10,
      market: { resourceType: 'energy', amount: 10, price: 1 },
    }));
    for (const entry of entries) h.context.state.world.usersMoney[entry._id] = entry;
    const first = entries[0];
    assert.ok(first);
    h.context.state.world.usersMoney['foreign'] = {
      ...first,
      _id: 'foreign',
      user: bob.userId,
      date: h.clock.now + 1000,
    };
    const wire = entries.map((entry) => ({
      ...entry,
      date: new Date(entry.date).toISOString(),
    }));
    assert.deepEqual(await h.call('GET', '/api/user/money-history', { token: alice.token }), {
      page: 0,
      list: wire.slice(0, 20),
      hasMore: true,
    });
    assert.deepEqual(
      await h.call('GET', '/api/user/money-history', {
        token: alice.token,
        query: { page: '1' },
      }),
      { page: 1, list: wire.slice(20), hasMore: false },
    );
    for (const entry of entries) {
      assert.equal(h.context.state.world.usersMoney[entry._id]?.date, entry.date);
    }
  });
});

void describe('steam ticket authentication', () => {
  function steamReply(body: unknown, status = 200): () => Promise<Response> {
    return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
  }

  void it('fails closed without a configured key or with native auth', async () => {
    const h = harness();
    const fetchMock = mock.method(globalThis, 'fetch', steamReply({}));
    await rejects(
      h.call('POST', '/api/auth/steam-ticket', { body: { ticket: 'abcd' } }),
      'authentication method is not supported',
    );
    const keyed = harness({ config: { steamKey: 'KEY' } });
    await rejects(
      keyed.call('POST', '/api/auth/steam-ticket', {
        body: { ticket: 'abcd', useNativeAuth: true },
      }),
      'authentication method is not supported',
    );
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(Object.keys(keyed.context.state.world.users).length, 0);
  });

  void it('rejects unverified tickets and transport failures', async () => {
    const h = harness({ config: { steamKey: 'KEY' } });
    for (const reply of [
      steamReply({ response: { error: { errorcode: 3, errordesc: 'Invalid ticket' } } }),
      steamReply({ response: { params: { result: 'Denied', steamid: '76561198000000000' } } }),
      steamReply({ response: { params: { result: 'OK' } } }),
      steamReply({ response: { params: { result: 'OK', steamid: '76561198000000000' } } }, 403),
      () => Promise.reject(new Error('network down')),
    ]) {
      mock.method(globalThis, 'fetch', reply);
      await rejects(
        h.call('POST', '/api/auth/steam-ticket', { body: { ticket: 'abcd' } }),
        'could not authenticate',
      );
      mock.restoreAll();
    }
    await rejects(
      h.call('POST', '/api/auth/steam-ticket', { body: { ticket: 'not hex' } }),
      'could not authenticate',
    );
    assert.equal(Object.keys(h.context.state.world.users).length, 0);
  });

  void it('verifies with the Steam Web API and finds or creates the account', async () => {
    const h = harness({ config: { steamKey: 'KEY' } });
    const fetchMock = mock.method(
      globalThis,
      'fetch',
      steamReply({ response: { params: { result: 'OK', steamid: '76561198000000001' } } }),
    );
    const first = (await h.call('POST', '/api/auth/steam-ticket', {
      body: { ticket: 'ABCD' },
    })) as {
      token: string;
      steamid: string;
    };
    const url = fetchMock.mock.calls[0]?.arguments[0];
    assert.ok(url instanceof URL);
    assert.equal(
      url.origin + url.pathname,
      'https://api.steampowered.com/ISteamUserAuth/AuthenticateUserTicket/v1/',
    );
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      key: 'KEY',
      appid: '464350',
      ticket: 'ABCD',
    });
    assert.equal(first.steamid, '76561198000000001');
    const userId = h.context.auth.check(first.token);
    assert.ok(userId);
    const second = (await h.call('POST', '/api/auth/steam-ticket', {
      body: { ticket: 'ABCD' },
    })) as {
      token: string;
    };
    assert.equal(h.context.auth.check(second.token), userId);
    assert.equal(Object.keys(h.context.state.world.users).length, 1);

    // Steam accounts choose a username once.
    await h.call('POST', '/api/register/set-username', {
      token: second.token,
      body: { username: 'SteamUser', email: 'S@example.com' },
    });
    await rejects(
      h.call('POST', '/api/register/set-username', {
        token: second.token,
        body: { username: 'Other' },
      }),
      'username already set',
    );
    await rejects(
      h.call('GET', '/api/register/check-username', { query: { username: 'steamuser' } }),
      'exists',
    );
    await rejects(
      h.call('GET', '/api/register/check-email', { query: { email: 's@EXAMPLE.com' } }),
      'exists',
    );
  });
});

void describe('official client platform endpoints', () => {
  const appnews = {
    appid: 464350,
    newsitems: [{ gid: '1842212951300141', title: 'Season #11 starts on September 1' }],
    count: 143,
  };

  void it('relays the latest Steam announcement and shares one request per poll interval', async () => {
    const h = harness();
    const fetchMock = mock.method(globalThis, 'fetch', () =>
      Promise.resolve(new Response(JSON.stringify({ appnews }))),
    );
    const [first, concurrent] = await Promise.all([
      h.call('GET', '/api/steam/news'),
      h.call('GET', '/api/steam/news'),
    ]);
    assert.deepEqual(first, { appnews });
    assert.deepEqual(concurrent, { appnews });
    assert.equal(fetchMock.mock.callCount(), 1);

    h.clock.now += STEAM_NEWS_TTL_MS - 1;
    await h.call('GET', '/api/steam/news');
    assert.equal(fetchMock.mock.callCount(), 1);
    h.clock.now += 1;
    await h.call('GET', '/api/steam/news');
    assert.equal(fetchMock.mock.callCount(), 2);
  });

  void it('reports unavailable Steam news without caching the failure', async () => {
    const h = harness();
    for (const reply of [
      () => Promise.resolve(new Response(JSON.stringify({ appnews }), { status: 503 })),
      () => Promise.resolve(new Response(JSON.stringify({ appnews: { appid: 464350 } }))),
      () => Promise.resolve(new Response('not json')),
      () => Promise.reject(new Error('network down')),
    ]) {
      mock.method(globalThis, 'fetch', reply);
      await rejects(h.call('GET', '/api/steam/news'), 'steam news unavailable', 502);
      mock.restoreAll();
    }
    mock.method(globalThis, 'fetch', () =>
      Promise.resolve(new Response(JSON.stringify({ appnews }))),
    );
    assert.deepEqual(await h.call('GET', '/api/steam/news'), { appnews });
  });

  void it('reports no Xsolla promotion or decorations without that inventory', async () => {
    const h = harness();
    const fetchMock = mock.method(globalThis, 'fetch', () => Promise.reject(new Error('unused')));
    const { token } = signIn(h);
    const callers: ApiCallOptions[] = [{}, { token }];
    for (const options of callers) {
      assert.deepEqual(await h.call('GET', '/api/xsolla/active-promotion', options), {});
      assert.deepEqual(
        await h.call('GET', '/api/game/room-decorations', {
          ...options,
          query: { room: 'W1N1', shard: 'shard0' },
        }),
        { decorations: [] },
      );
    }
    assert.equal(fetchMock.mock.callCount(), 0);
    for (const path of ['/api/user/decorations/inventory', '/api/user/decorations/themes']) {
      await rejects(h.call('GET', path), 'unauthorized', 401);
      assert.deepEqual(await h.call('GET', path, { token }), { list: [] });
    }
  });
});

void describe('code branches', () => {
  void it('keeps the runtime code equal to the activeWorld branch', async () => {
    const h = harness();
    const { userId, token } = signIn(h);
    await h.call('POST', '/api/user/code', {
      token,
      body: {
        branch: 'default',
        modules: {
          main: 'module.exports.loop = 1;',
          'lib.util': 'x',
          '.hidden': 'y',
          wasm: { binary: 'AGFzbQ==' },
        },
        _hash: 7,
      },
    });
    const expected = {
      main: 'module.exports.loop = 1;',
      'lib.util': 'x',
      wasm: { binary: 'AGFzbQ==' },
    };
    assert.deepEqual(h.context.runtime.getCode(userId)?.modules, expected);
    assert.deepEqual(await h.call('GET', '/api/user/code', { token }), {
      branch: 'default',
      modules: expected,
    });
    assert.deepEqual(h.published.at(-1), [
      `user:${userId}/code`,
      { id: Object.keys(h.context.state.branches)[0], hash: 7 },
    ]);

    await h.call('POST', '/api/user/clone-branch', {
      token,
      body: { branch: 'default', newName: 'next' },
    });
    const cloned = Object.values(h.context.state.branches).find(
      (branch) => branch.branch === 'next',
    );
    assert.ok(cloned);
    assert.equal(Object.hasOwn(cloned, 'activeWorld'), false);
    assert.equal(Object.hasOwn(cloned, 'activeSim'), false);
    assert.equal(cloned.timestamp, h.clock.now);
    await h.call('POST', '/api/user/code', {
      token,
      body: { branch: 'next', modules: { main: 'next();' } },
    });
    assert.deepEqual(
      h.context.runtime.getCode(userId)?.modules,
      expected,
      'inactive branch edits do not run',
    );

    await h.call('POST', '/api/user/set-active-branch', {
      token,
      body: { branch: 'next', activeName: 'activeWorld' },
    });
    assert.deepEqual(h.context.runtime.getCode(userId), {
      modules: { main: 'next();' },
      branch: 'next',
    });
    await h.call('POST', '/api/user/set-active-branch', {
      token,
      body: { branch: 'default', activeName: 'activeSim' },
    });
    assert.deepEqual(
      h.context.runtime.getCode(userId)?.branch,
      'next',
      'simulation branch is client-side',
    );

    const list = (await h.call('GET', '/api/user/branches', { token })) as {
      list: Array<{ branch: string; activeWorld?: boolean; activeSim?: boolean }>;
    };
    assert.deepEqual(
      list.list
        .map(({ branch, activeWorld, activeSim }) => ({ branch, activeWorld, activeSim }))
        .sort((a, b) => a.branch.localeCompare(b.branch)),
      [
        { branch: 'default', activeWorld: false, activeSim: true },
        { branch: 'next', activeWorld: true, activeSim: false },
      ],
    );

    // Active branches are never deleted.
    await h.call('POST', '/api/user/delete-branch', { token, body: { branch: 'next' } });
    assert.equal(Object.keys(h.context.state.branches).length, 2);
    await h.call('POST', '/api/user/clone-branch', { token, body: { newName: 'scratch' } });
    await h.call('POST', '/api/user/delete-branch', { token, body: { branch: 'scratch' } });
    assert.equal(Object.keys(h.context.state.branches).length, 2);

    await rejects(
      h.call('POST', '/api/user/code', { token, body: { branch: 'missing', modules: {} } }),
      'branch does not exist',
    );
    await rejects(
      h.call('POST', '/api/user/code', { token, body: { modules: { main: 5 } } }),
      'invalid params',
    );
    await rejects(
      h.call('POST', '/api/user/clone-branch', { token, body: { newName: '$activeWorld' } }),
      'invalid branch name',
    );
  });

  void it('does not touch other users branches', async () => {
    const h = harness();
    const alice = signIn(h, 'Alice');
    const bob = signIn(h, 'Bob');
    await h.call('POST', '/api/user/clone-branch', {
      token: bob.token,
      body: { newName: 'secret' },
    });
    await rejects(
      h.call('POST', '/api/user/set-active-branch', {
        token: alice.token,
        body: { branch: 'secret', activeName: 'activeWorld' },
      }),
      'no branch',
    );
    await rejects(
      h.call('GET', '/api/user/code', { token: alice.token, query: { branch: 'secret' } }),
      'no code',
    );
  });

  void it('limits a player to 30 branches except tutorial branches', async () => {
    const h = harness();
    const { token } = signIn(h);
    for (let i = 1; i < 30; i++) {
      await h.call('POST', '/api/user/clone-branch', { token, body: { newName: `b${String(i)}` } });
    }
    await rejects(
      h.call('POST', '/api/user/clone-branch', { token, body: { newName: 'b30' } }),
      'too many branches',
    );
    await h.call('POST', '/api/user/clone-branch', { token, body: { newName: 'tutorial-1' } });
    await h.call('POST', '/api/user/clone-branch', {
      token,
      body: { newName: 'b1', defaultModules: { main: 'x' } },
    });
  });
});

void describe('memory', () => {
  void it('returns gzipped memory at safe paths', async () => {
    const h = harness();
    const { userId, token } = signIn(h);
    h.context.runtime.setMemory(
      userId,
      JSON.stringify({ creeps: { a: { role: 'harvester' } }, n: 5 }),
    );
    const decode = (data: unknown): unknown => {
      assert.equal(typeof data, 'string');
      const text = String(data);
      assert.ok(text.startsWith('gz:'));
      return JSON.parse(gunzipSync(Buffer.from(text.slice(3), 'base64')).toString());
    };
    const all = (await h.call('GET', '/api/user/memory', { token })) as { data: unknown };
    assert.deepEqual(decode(all.data), { creeps: { a: { role: 'harvester' } }, n: 5 });
    const nested = (await h.call('GET', '/api/user/memory', {
      token,
      query: { path: 'creeps.a.role' },
    })) as { data: unknown };
    assert.equal(decode(nested.data), 'harvester');
    assert.deepEqual(
      await h.call('GET', '/api/user/memory', { token, query: { path: 'creeps.b' } }),
      {},
    );
    assert.deepEqual(
      await h.call('GET', '/api/user/memory', { token, query: { path: 'n.toString' } }),
      {},
    );
    for (const path of ['missing.deeper', '__proto__', 'creeps..a']) {
      assert.deepEqual(await h.call('GET', '/api/user/memory', { token, query: { path } }), {
        data: 'Incorrect memory path',
      });
    }
  });

  void it('queues hidden console edits that create intermediate objects', async () => {
    const h = harness();
    const { userId, token } = signIn(h);
    const run = (memory: Record<string, unknown>): Record<string, unknown> => {
      const commands = h.context.state.runtime.users[userId]?.consoleCommands ?? [];
      const command = commands.at(-1);
      assert.ok(command);
      assert.equal(command.hidden, true);
      runInNewContext(command.expression, { Memory: memory });
      // Normalize objects created inside the VM realm for structural comparison.
      const normalized: unknown = JSON.parse(JSON.stringify(memory));
      assert.ok(isRecord(normalized));
      return normalized;
    };
    await h.call('POST', '/api/user/memory', { token, body: { path: "a.b'c.d", value: { x: 1 } } });
    assert.deepEqual(run({ keep: 1 }), { keep: 1, a: { "b'c": { d: { x: 1 } } } });
    await h.call('POST', '/api/user/memory', { token, body: { path: 'a.b', value: undefined } });
    assert.deepEqual(run({ a: { b: 1, c: 2 } }), { a: { c: 2 } });
    assert.deepEqual(run({}), {}, 'deleting a missing path is a no-op');
    await h.call('POST', '/api/user/memory', { token, body: { value: { fresh: true } } });
    assert.deepEqual(run({ old: 1 }), { fresh: true });
    await h.call('POST', '/api/user/memory', { token, body: { path: 'a.b', value: 1 } });
    assert.throws(() => run({ a: 5 }), /not an object/);

    assert.equal(
      h.context.runtime.getMemory(userId),
      '{}',
      'the API never writes a second memory copy',
    );
    await rejects(
      h.call('POST', '/api/user/memory', {
        token,
        body: { path: 'x', value: 'y'.repeat(1024 * 1024) },
      }),
      'memory size is too large',
    );
    await rejects(
      h.call('POST', '/api/user/memory', { token, body: { path: '__proto__.x', value: 1 } }),
      'Incorrect memory path',
    );
  });

  void it('reads and writes segments and console commands', async () => {
    const h = harness();
    const { userId, token } = signIn(h);
    assert.deepEqual(
      await h.call('GET', '/api/user/memory-segment', { token, query: { segment: '3' } }),
      { data: null },
    );
    await h.call('POST', '/api/user/memory-segment', {
      token,
      body: { segment: 3, data: 'hello' },
    });
    assert.deepEqual(
      await h.call('GET', '/api/user/memory-segment', { token, query: { segment: '3' } }),
      { data: 'hello' },
    );
    await rejects(
      h.call('POST', '/api/user/memory-segment', { token, body: { segment: 100, data: '' } }),
      'invalid segment ID',
    );
    await rejects(
      h.call('POST', '/api/user/memory-segment', {
        token,
        body: { segment: 1, data: 'x'.repeat(100 * 1024 + 1) },
      }),
      'length limit exceeded',
    );
    await h.call('POST', '/api/user/console', { token, body: { expression: 'Game.time' } });
    assert.deepEqual(h.context.state.runtime.users[userId]?.consoleCommands, [
      { expression: 'Game.time' },
    ]);
    await rejects(
      h.call('POST', '/api/user/console', { token, body: { expression: 'x'.repeat(1100) } }),
      'expression size is too large',
    );
  });
});

void describe('persistence', () => {
  void it('survives a restart through the state store', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openscreeps-accounts-'));
    try {
      const database = join(directory, 'world.sqlite');
      const h = harness();
      const { userId, token } = signIn(h);
      await h.call('POST', '/api/user/code', {
        token,
        body: { modules: { main: 'persisted();' } },
      });
      await h.call('POST', '/api/user/memory-segment', {
        token,
        body: { segment: 0, data: 'seg' },
      });
      await h.call('POST', '/api/user/badge', {
        token,
        body: {
          badge: {
            type: 3,
            color1: '#112233',
            color2: '#445566',
            color3: '#778899',
            param: 10,
            flip: true,
          },
        },
      });
      const store = await StateStore.open(createConfig({ database }));
      await store.save(h.context.state);
      await store.close();
      const reopened = await StateStore.open(createConfig({ database }));
      const state = reopened.load();
      await reopened.close();
      assert.ok(state);
      const restarted = harness({ state, now: h.clock.now });
      assert.equal(restarted.context.auth.check(token), userId);
      assert.deepEqual(restarted.context.runtime.getCode(userId)?.modules, {
        main: 'persisted();',
      });
      assert.equal(restarted.context.runtime.getSegment(userId, 0), 'seg');
      const signin = (await restarted.call('POST', '/api/auth/signin', {
        body: { email: 'Alice', password: 'correct horse' },
      })) as { token: string };
      assert.equal(restarted.context.auth.check(signin.token), userId);
      const svg = await restarted.call('GET', '/api/user/badge-svg', {
        query: { username: 'alice' },
      });
      assert.ok(svg instanceof RawResponse);
      assert.match(String(svg.body), /fill="#112233"/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

void describe('badges', () => {
  void it('validates submitted badges and renders escaped SVG', async () => {
    const h = harness();
    const { userId, token } = signIn(h);
    const valid = {
      type: 24,
      color1: '#ff0000',
      color2: '#00ff00',
      color3: '#0000ff',
      param: -50,
      flip: false,
    };
    for (const badge of [
      { ...valid, color1: '#ff0000"/><script>alert(1)</script>' },
      { ...valid, type: 25 },
      { ...valid, type: 1.5 },
      { ...valid, param: 101 },
      { ...valid, type: { path1: 'M 0 0', path2: '' } },
    ]) {
      await rejects(
        h.call('POST', '/api/user/badge', { token, body: { badge } }),
        'invalid params',
      );
    }
    const custom = { path1: 'M 0 0 L 100 100" onload="x', path2: '' };
    const profile = h.context.state.profiles[userId];
    assert.ok(profile);
    profile.customBadge = custom;
    await h.call('POST', '/api/user/badge', {
      token,
      body: { badge: { ...valid, type: { ...custom } } },
    });
    const svg = await h.call('GET', '/api/user/badge-svg', {
      query: { username: 'ALICE', border: '1' },
    });
    assert.ok(svg instanceof RawResponse);
    assert.equal(svg.contentType, 'image/svg+xml; charset=utf-8');
    assert.ok(!String(svg.body).includes('" onload="'));
    assert.match(String(svg.body), /stroke-width="5"/);
    const missing = await h.call('GET', '/api/user/badge-svg', { query: { username: 'nobody' } });
    assert.ok(missing instanceof RawResponse);
    assert.equal(missing.status, 404);
  });
});

void describe('messages', () => {
  void it('delivers, indexes, notifies and marks messages read', async () => {
    const h = harness();
    const alice = signIn(h, 'Alice');
    const bob = signIn(h, 'Bob');
    const carol = signIn(h, 'Carol');
    const start = h.clock.now;
    const iso = (offset: number): string => new Date(start + offset).toISOString();
    await h.call('POST', '/api/user/messages/send', {
      token: alice.token,
      body: { respondent: bob.userId, text: 'hi bob' },
    });
    h.clock.now += 1;
    await h.call('POST', '/api/user/messages/send', {
      token: carol.token,
      body: { respondent: bob.userId, text: 'hi from carol' },
    });
    h.clock.now += 1;
    await h.call('POST', '/api/user/messages/send', {
      token: bob.token,
      body: { respondent: alice.userId, text: 'hello alice' },
    });

    const pick = (type: 'in' | 'out', text: string): UserMessage => {
      const stored = Object.values(h.context.state.messages).find(
        (m) => m.type === type && m.text === text,
      );
      assert.ok(stored);
      return stored;
    };
    // Upstream publishes the stored `Date` through JSON: ISO strings, numeric dates stay stored.
    assert.deepEqual(h.published.slice(0, 3), [
      [
        `user:${alice.userId}/message:${bob.userId}`,
        { message: { ...pick('out', 'hi bob'), date: iso(0) } },
      ],
      [
        `user:${bob.userId}/message:${alice.userId}`,
        { message: { ...pick('in', 'hi bob'), date: iso(0) } },
      ],
      [`user:${bob.userId}/newMessage`, { message: { ...pick('in', 'hi bob'), date: iso(0) } }],
    ]);
    assert.equal(pick('in', 'hi bob').date, start);
    assert.deepEqual(await h.call('GET', '/api/user/messages/unread-count', { token: bob.token }), {
      count: 2,
    });

    const index = (await h.call('GET', '/api/user/messages/index', { token: bob.token })) as {
      messages: Array<{ _id: string; message: { text: string; date: unknown } }>;
      users: Record<string, { username?: string }>;
    };
    assert.deepEqual(
      index.messages.map((entry) => [entry._id, entry.message.text, entry.message.date]),
      [
        [alice.userId, 'hello alice', iso(2)],
        [carol.userId, 'hi from carol', iso(1)],
      ],
    );
    assert.equal(index.users[carol.userId]?.username, 'Carol');

    const list = (await h.call('GET', '/api/user/messages/list', {
      token: bob.token,
      query: { respondent: alice.userId },
    })) as { messages: Array<{ _id: string; type: string; text: string; date: unknown }> };
    assert.deepEqual(
      list.messages.map((m) => [m.type, m.text, m.date]),
      [
        ['in', 'hi bob', iso(0)],
        ['out', 'hello alice', iso(2)],
      ],
    );

    const incoming = list.messages[0];
    assert.ok(incoming);
    await rejects(
      h.call('POST', '/api/user/messages/mark-read', {
        token: alice.token,
        body: { id: incoming._id },
      }),
      'invalid id',
    );
    await h.call('POST', '/api/user/messages/mark-read', {
      token: bob.token,
      body: { id: incoming._id },
    });
    assert.deepEqual(await h.call('GET', '/api/user/messages/unread-count', { token: bob.token }), {
      count: 1,
    });
    const sent = Object.values(h.context.state.messages).find(
      (m) => m.type === 'out' && m.text === 'hi bob',
    );
    assert.equal(sent?.unread, false);

    const notifications = Object.values(h.context.state.world.notifications).filter(
      (n) => n.user === bob.userId,
    );
    assert.equal(notifications.length, 2, 'one notification per sender while offline');

    await rejects(
      h.call('POST', '/api/user/messages/send', {
        token: alice.token,
        body: { respondent: 'nobody', text: 'x' },
      }),
      'invalid respondent',
    );
  });

  void it('does not mail online players unless sendOnline is set', async () => {
    const h = harness();
    const alice = signIn(h, 'Alice');
    const bob = signIn(h, 'Bob');
    const profile = h.context.state.profiles[bob.userId];
    assert.ok(profile);
    profile.lastOnline = h.clock.now;
    await h.call('POST', '/api/user/messages/send', {
      token: alice.token,
      body: { respondent: bob.userId, text: 'x' },
    });
    assert.equal(Object.keys(h.context.state.world.notifications).length, 0);
    await h.call('POST', '/api/user/notify-prefs', {
      token: bob.token,
      body: { sendOnline: true, interval: 60, errorsInterval: 7 },
    });
    assert.deepEqual(profile.notifyPrefs, { sendOnline: true, interval: 60 });
    await h.call('POST', '/api/user/messages/send', {
      token: alice.token,
      body: { respondent: bob.userId, text: 'y' },
    });
    assert.equal(Object.keys(h.context.state.world.notifications).length, 1);
  });
});

void describe('profile and statistics', () => {
  void it('finds public profiles without private data', async () => {
    const h = harness();
    const { userId } = signIn(h);
    const found = (await h.call('GET', '/api/user/find', { query: { username: 'ALICE' } })) as {
      user: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(found.user).sort(), ['_id', 'gcl', 'username']);
    assert.equal(found.user._id, userId);
    await rejects(
      h.call('GET', '/api/user/find', { query: { username: 'nobody' } }),
      'user not found',
    );
  });

  void it('aggregates statistics minute buckets into interval points', async () => {
    const minute = 60_000;
    const period = 8 * minute;
    const now = 1000 * period + 3 * minute;
    const h = harness({ now });
    const { userId, token } = signIn(h);
    h.context.state.world.roomObjects.c1 = {
      _id: 'c1',
      type: 'controller',
      room: 'W1N1',
      x: 1,
      y: 1,
      user: userId,
      level: 2,
    };
    h.context.state.statistics.push(
      {
        time: 1000 * period + minute,
        tick: 50,
        ticks: 3,
        rooms: { W1N1: { [userId]: { energyHarvested: 10, creepsLost: 1 } } },
        users: {},
      },
      {
        time: 1000 * period - minute,
        tick: 40,
        ticks: 3,
        rooms: { W1N1: { [userId]: { energyHarvested: 5 } } },
        users: {},
      },
      {
        time: 990 * period,
        tick: 1,
        ticks: 1,
        rooms: { W1N1: { [userId]: { energyHarvested: 100 } } },
        users: {},
      },
    );
    const overview = (await h.call('GET', '/api/user/overview', {
      token,
      query: { interval: '8' },
    })) as {
      rooms: string[];
      stats: Record<string, Array<{ value: number; endTime: number }>>;
      statsMax: number;
      totals: Record<string, number>;
      gametimes: Array<number | null>;
    };
    assert.deepEqual(overview.rooms, ['W1N1']);
    assert.deepEqual(overview.stats.W1N1?.slice(-2), [
      { value: 5, endTime: 1000 },
      { value: 10, endTime: 1001 },
    ]);
    assert.equal(overview.stats.W1N1.length, 8);
    assert.equal(overview.statsMax, 10);
    assert.deepEqual(overview.totals, { energyHarvested: 15, creepsLost: 1 });
    assert.deepEqual(overview.gametimes.slice(-2), [40, 50]);

    assert.deepEqual(
      await h.call('GET', '/api/user/stats', { query: { id: userId, interval: '8' } }),
      {
        stats: { energyHarvested: 15, creepsLost: 1 },
      },
    );
    await rejects(
      h.call('GET', '/api/user/stats', { query: { id: userId, interval: '9' } }),
      'invalid params',
    );
    assert.deepEqual(await h.call('GET', '/api/user/rooms', { query: { id: userId } }), {
      rooms: ['W1N1'],
    });
  });
});
