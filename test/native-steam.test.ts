import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { BotRuntime, createWorldState } from '@openscreeps/game';
import { ApiTestClient } from './api-harness.ts';
import { createAuthService } from '../src/api/auth.ts';
import { createConfig } from '../src/config.ts';
import {
  ApiError,
  type ApiContext,
  type ServerEvents,
  type ServerState,
} from '../src/contracts.ts';
import { SteamAuthService } from '../src/services/native-steam.ts';

/** Published Screeps encrypted-app-ticket key the backend passes to `decryptAppTicket`. */
const SCREEPS_KEY = 'ed66a45b50c848a0c463ec18e0eab308fe9b8d3edcb0484b2def7e52f7297e75';
const STEAM_ID = '76561198000000042';
const load = createRequire(import.meta.url);

interface FakeOptions {
  running?: boolean;
  init?: boolean;
  /** `'env'` reports the `SteamAppId` environment variable, as SteamAPI_Init does. */
  appId?: number | 'env';
  omit?: string;
}

interface FakeGreenworks {
  inits: number;
  /** Arguments that did not come from a successful decryption (the real SDK may crash). */
  unsafe: string[];
  keys: string[];
}

const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

/**
 * Writes a stand-in for the Greenworks module honouring the SDK contract the backend relies on:
 * decryption yields a fresh buffer or `undefined`, the ticket accessors take decrypted tickets.
 * Fake "encryption": `SCRP` + JSON `{app, steamid}`, accepted only with the Screeps key.
 */
function fakeGreenworks(options: FakeOptions = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'openscreeps-greenworks-'));
  directories.push(directory);
  writeFileSync(join(directory, 'package.json'), '{"type":"commonjs"}');
  writeFileSync(
    join(directory, 'greenworks.js'),
    `'use strict';
const options = ${JSON.stringify(options)};
const decrypted = new WeakSet();
const api = {
  inits: 0,
  unsafe: [],
  keys: [],
  isSteamRunning: () => options.running !== false,
  initAPI() { api.inits++; return options.init !== false; },
  getAppId: () => options.appId === 'env' ? Number(process.env.SteamAppId) : options.appId ?? 464350,
  decryptAppTicket(ticket, key) {
    if (!Buffer.isBuffer(ticket) || !Buffer.isBuffer(key)) throw new TypeError('Bad arguments');
    if (key.length !== 32) throw new TypeError('The key length is not matched');
    api.keys.push(key.toString('hex'));
    if (key.toString('hex') !== ${JSON.stringify(SCREEPS_KEY)}) return undefined;
    if (ticket.subarray(0, 4).toString() !== 'SCRP') return undefined;
    const result = Buffer.from(ticket.subarray(4));
    decrypted.add(result);
    return result;
  },
  isTicketForApp(ticket, appId) {
    if (!decrypted.has(ticket)) { api.unsafe.push('isTicketForApp'); throw new Error('crash'); }
    return JSON.parse(ticket.toString()).app === appId;
  },
  getTicketSteamId(ticket) {
    if (!decrypted.has(ticket)) { api.unsafe.push('getTicketSteamId'); throw new Error('crash'); }
    return { raw: JSON.parse(ticket.toString()).steamid, getRawSteamID() { return this.raw; } };
  },
};
if (options.omit) delete api[options.omit];
module.exports = api;
`,
  );
  return directory;
}

function fake(directory: string): FakeGreenworks {
  return load(join(directory, 'greenworks.js')) as FakeGreenworks;
}

function ticket(fields: Record<string, unknown>, prefix = 'SCRP'): string {
  return Buffer.concat([Buffer.from(prefix), Buffer.from(JSON.stringify(fields))]).toString('hex');
}

function service(config: { steamKey?: string; steamGreenworks?: string }): SteamAuthService {
  return new SteamAuthService({ config });
}

async function rejects(promise: Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.message, message);
    return true;
  });
}

void describe('native Steam encrypted-ticket authentication', () => {
  void it('initializes Greenworks for app 464350 at startup and verifies native tickets', async () => {
    const directory = fakeGreenworks({ appId: 'env' });
    const previous = process.env.SteamAppId;
    delete process.env.SteamAppId;
    try {
      const steam = service({ steamGreenworks: directory });
      assert.equal(process.env.SteamAppId, '464350');
      assert.equal(steam.mode, 'native');
      assert.equal(steam.useNativeAuth, true);
      const steamId = await steam.authenticate({
        ticket: ticket({ app: 464350, steamid: STEAM_ID }),
        useNativeAuth: true,
      });
      assert.equal(steamId, STEAM_ID);
      assert.deepEqual(fake(directory).keys, [SCREEPS_KEY]);
      // The Steam API is process-wide: one module path is initialized once.
      service({ steamGreenworks: join(directory, 'greenworks.js') });
      service({ steamGreenworks: directory });
      assert.equal(fake(directory).inits, 1);
    } finally {
      if (previous === undefined) delete process.env.SteamAppId;
      else process.env.SteamAppId = previous;
    }
  });

  void it('rejects bad tickets without handing undecrypted bytes to the SDK', async () => {
    const directory = fakeGreenworks();
    const steam = service({ steamGreenworks: directory });
    for (const bad of [
      undefined,
      42,
      '',
      'abc',
      'zz',
      'not hex!',
      'ab'.repeat(4097),
      ticket({ app: 464350, steamid: STEAM_ID }, 'XXXX'),
      ticket({ app: 440, steamid: STEAM_ID }),
      ticket({ app: 464350, steamid: '0' }),
      ticket({ app: 464350, steamid: 'abc' }),
      ticket({ app: 464350, steamid: 42 }),
      ticket({ app: 464350 }),
    ]) {
      await rejects(
        steam.authenticate({ ticket: bad, useNativeAuth: true }),
        'invalid encrypted ticket',
      );
    }
    assert.deepEqual(fake(directory).unsafe, []);
  });

  void it('rejects requests for the scheme the server does not run', async () => {
    const native = service({ steamGreenworks: fakeGreenworks() });
    await rejects(
      native.authenticate({ ticket: ticket({ app: 464350, steamid: STEAM_ID }) }),
      'authentication method is not supported',
    );
    const webApi = service({ steamKey: 'KEY' });
    assert.equal(webApi.mode, 'webapi');
    assert.equal(webApi.useNativeAuth, false);
    await rejects(
      webApi.authenticate({ ticket: ticket({ app: 464350, steamid: STEAM_ID }), useNativeAuth: 1 }),
      'authentication method is not supported',
    );
    const disabled = service({});
    assert.equal(disabled.mode, 'disabled');
    for (const useNativeAuth of [true, false]) {
      await rejects(
        disabled.authenticate({ ticket: 'abcd', useNativeAuth }),
        'authentication method is not supported',
      );
    }
  });

  void it('fails startup closed when native mode is unusable', () => {
    const missing = join(tmpdir(), 'openscreeps-no-greenworks', 'greenworks.js');
    assert.throws(
      () => service({ steamGreenworks: missing }),
      /Cannot load the greenworks library/,
    );
    assert.throws(
      () => service({ steamGreenworks: fakeGreenworks({ omit: 'decryptAppTicket' }) }),
      /does not provide greenworks\.decryptAppTicket\(\)/,
    );
    assert.throws(
      () => service({ steamGreenworks: fakeGreenworks({ running: false }) }),
      /^Error: Steam client is not running$/,
    );
    assert.throws(
      () => service({ steamGreenworks: fakeGreenworks({ init: false }) }),
      /greenworks\.initAPI\(\) failure/,
    );
    assert.throws(
      () => service({ steamGreenworks: fakeGreenworks({ appId: 440 }) }),
      /app id 440; native Screeps authentication requires 464350/,
    );
    assert.throws(
      () => service({ steamKey: 'KEY', steamGreenworks: fakeGreenworks() }),
      /exclusive/,
    );
  });
});

void describe('POST /api/auth/steam-ticket in native mode', () => {
  const runtimes: BotRuntime[] = [];
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.dispose();
  });

  function context(steamGreenworks: string): ApiContext {
    const runtime = new BotRuntime({ now: () => 1_700_000_000_000 });
    runtimes.push(runtime);
    const state: ServerState = {
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
    const base = {
      config: createConfig({ database: ':memory:', steamGreenworks }),
      state,
      runtime,
      events: new EventEmitter<ServerEvents>(),
      now: () => 1_700_000_000_000,
      read: async <T>(operation: () => T | Promise<T>) => operation(),
      mutate: async <T>(operation: () => T | Promise<T>) => operation(),
      publish: () => undefined,
      terrainChanged: () => undefined,
      step: () => Promise.reject(new Error('not used')),
      setPaused: () => Promise.resolve(),
      setTickDuration: () => Promise.resolve(),
    };
    return { ...base, auth: createAuthService(base) };
  }

  void it('signs in with a native ticket, finding or creating the Steam account', async () => {
    const api = context(fakeGreenworks());
    const client = new ApiTestClient(api);
    const body = { ticket: ticket({ app: 464350, steamid: STEAM_ID }), useNativeAuth: true };
    const first = (await client.call('POST', '/api/auth/steam-ticket', { body })) as {
      token: string;
      steamid: string;
    };
    assert.equal(first.steamid, STEAM_ID);
    const userIds = Object.keys(api.state.profiles);
    assert.equal(userIds.length, 1);
    assert.equal(api.state.profiles[userIds[0] ?? '']?.steam?.id, STEAM_ID);
    const me = (await client.call('GET', '/api/auth/me', { token: first.token })) as {
      steam: { id: string };
    };
    assert.equal(me.steam.id, STEAM_ID);
    const second = (await client.call('POST', '/api/auth/steam-ticket', { body })) as {
      steamid: string;
    };
    assert.equal(second.steamid, STEAM_ID);
    assert.equal(Object.keys(api.state.profiles).length, 1);

    await assert.rejects(
      client.call('POST', '/api/auth/steam-ticket', {
        body: { ticket: ticket({ app: 440, steamid: STEAM_ID }), useNativeAuth: true },
      }),
      { message: 'invalid encrypted ticket' },
    );
    await assert.rejects(
      client.call('POST', '/api/auth/steam-ticket', { body: { ticket: body.ticket } }),
      { message: 'authentication method is not supported' },
    );
    assert.equal(Object.keys(api.state.profiles).length, 1);
  });
});

/**
 * Real Steamworks round trip, run when `OPENSCREEPS_GREENWORKS` names a Greenworks module (for
 * example the one shipped with the Steam Screeps client) and a Steam client owning Screeps runs.
 */
void describe('native Steam SDK round trip', { skip: !process.env.OPENSCREEPS_GREENWORKS }, () => {
  void it('verifies a fresh encrypted app ticket from the local Steam client', async () => {
    const path = process.env.OPENSCREEPS_GREENWORKS ?? '';
    const steam = service({ steamGreenworks: path });
    assert.equal(steam.useNativeAuth, true);
    const greenworks = load(path.endsWith('.js') ? path : join(path, 'greenworks.js')) as {
      getEncryptedAppTicket(
        userData: string,
        success: (ticket: Buffer) => void,
        failure: (error: unknown) => void,
      ): void;
      getSteamId(): { getRawSteamID(): string };
    };
    const pending = Promise.withResolvers<Buffer>();
    greenworks.getEncryptedAppTicket('', pending.resolve, pending.reject);
    const encrypted = await pending.promise;
    const hex = encrypted.toString('hex');
    const steamId = await steam.authenticate({ ticket: hex, useNativeAuth: true });
    assert.equal(steamId, greenworks.getSteamId().getRawSteamID());
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 5] = (tampered[tampered.length - 5] ?? 0) ^ 0xff;
    await rejects(
      steam.authenticate({ ticket: tampered.toString('hex'), useNativeAuth: true }),
      'invalid encrypted ticket',
    );
    await rejects(
      steam.authenticate({ ticket: hex.slice(0, -2), useNativeAuth: true }),
      'invalid encrypted ticket',
    );
    await rejects(steam.authenticate({ ticket: hex }), 'authentication method is not supported');
  });
});
