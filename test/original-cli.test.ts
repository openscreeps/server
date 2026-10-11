import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { createUser } from '../src/api/users.ts';
import {
  OriginalCliConfig,
  startOriginalCli,
  type OriginalCliOptions,
  type OriginalCliServer,
} from '../src/compatibility/original-cli.ts';
import {
  createOriginalStorage,
  type OriginalStorage,
} from '../src/compatibility/original-storage.ts';
import { createConfig } from '../src/config.ts';
import type { ServerConfig } from '../src/contracts.ts';
import { ServerKernel } from '../src/services/server-kernel.service.ts';

const TIMEOUT = 30000;

interface Session {
  readonly socket: Socket;
  readonly closed: Promise<void>;
  /** Output received since `from` once it matches `pattern`. */
  until(pattern: RegExp, from?: number): Promise<string>;
  /** Sends one command line and waits for output after it matching `pattern`. */
  run(command: string, pattern: RegExp): Promise<string>;
}

async function openSession(port: number): Promise<Session> {
  const socket = connect(port, '127.0.0.1');
  socket.setEncoding('utf8');
  socket.on('error', () => undefined);
  let text = '';
  let ended = false;
  let notify: (() => void) | undefined;
  socket.on('data', (chunk: string) => {
    text += chunk;
    notify?.();
  });
  const closing: PromiseWithResolvers<void> = Promise.withResolvers();
  socket.once('close', () => {
    ended = true;
    notify?.();
    closing.resolve();
  });
  const connected: PromiseWithResolvers<void> = Promise.withResolvers();
  socket.once('connect', connected.resolve);
  socket.once('error', connected.reject);
  await connected.promise;
  // Waits for the output itself; a missing result fails through the test timeout.
  const until = async (pattern: RegExp, from = 0): Promise<string> => {
    for (;;) {
      const received = text.slice(from);
      if (pattern.test(received)) return received;
      if (ended)
        throw new Error(`Session closed before ${String(pattern)}: ${JSON.stringify(received)}`);
      const next: PromiseWithResolvers<void> = Promise.withResolvers();
      notify = next.resolve;
      await next.promise;
    }
  };
  const closed = closing.promise;
  return {
    socket,
    closed,
    until,
    run(command, pattern) {
      const from = text.length;
      socket.write(`${command}\r\n`);
      return until(pattern, from);
    },
  };
}

interface Fixture {
  readonly kernel: ServerKernel;
  readonly server: OriginalCliServer;
  readonly logs: string[];
  open(): Promise<Session>;
  close(): Promise<void>;
}

async function startFixture(
  config: Partial<ServerConfig> = {},
  options: OriginalCliOptions | ((kernel: ServerKernel) => OriginalCliOptions) = {},
): Promise<Fixture> {
  const kernel = await ServerKernel.create(
    createConfig({ database: ':memory:', worldSize: 2, paused: true, ...config }),
  );
  const logs: string[] = [];
  let server: OriginalCliServer;
  try {
    server = await startOriginalCli(kernel, {
      port: 0,
      log: (line) => logs.push(line),
      ...(typeof options === 'function' ? options(kernel) : options),
    });
  } catch (error) {
    await kernel.close();
    throw error;
  }
  return {
    kernel,
    server,
    logs,
    open: async () => {
      const session = await openSession(server.address.port);
      await session.until(/< \r\n$/);
      return session;
    },
    close: async () => {
      await server.close();
      await kernel.close();
    },
  };
}

void it(
  'greets like the original and keeps JavaScript state per connection',
  { timeout: TIMEOUT },
  async () => {
    const fixture = await startFixture({}, { version: '4.2.0' });
    try {
      const first = await openSession(fixture.server.address.port);
      assert.equal(
        await first.until(/< \r\n$/),
        'Screeps server v4.2.0 running on port 21025.\r\nThis CLI interface contains a virtual JavaScript machine which you can use to invoke internal server commands. Any valid JavaScript code is allowed. Type "help()" to learn more about commands.\r\n< \r\n',
      );
      assert.equal(await first.run('var counter = 41', /^< $/), '< ');
      assert.equal(await first.run('counter + 1', /\r\n$/), '< 42\r\n');
      assert.equal(
        await first.run("print('a', {b: 1}); 'done'", /< done\r\n$/),
        "'a' { b: 1 }\r\n< done\r\n",
      );

      const second = await fixture.open();
      assert.equal(
        await second.run('counter', /\r\n$/),
        '< ReferenceError: counter is not defined\r\n',
      );
      assert.equal(await first.run('counter', /\r\n$/), '< 41\r\n');

      assert.match(
        await first.run('help()', /usage of the object\.\r\n$/),
        /^< The supported commands are:\r\n {4}\* help\(\) - Print this help text\.\r\n/,
      );
      const mapHelp = await first.run(
        'help(map)',
        /updateTerrainData\(\) - Update cached world terrain data\.\r\n$/,
      );
      assert.match(
        mapHelp,
        /^< Available methods:\r\n - map\.generateRoom\(roomName, \[opts\]\) - /,
      );
      assert.match(
        await first.run(
          'help(system)',
          /Set current minimal tick duration \(in milliseconds\)\.\r\n$/,
        ),
        / - system\.pauseSimulation\(\) - Stop main simulation loop execution\.\r\n/,
      );
      assert.match(
        await first.run('help(storage.db)', /\.then\(print\);\r\n$/),
        /^< Database collections: \r\n(.|\r\n)* - users\r\n/,
      );
      assert.equal(
        await first.run('help(42)', /\r\n$/),
        '< There is no help page for this object.\r\n',
      );
    } finally {
      await fixture.close();
    }
  },
);

void it(
  'reads and writes original storage against the canonical world',
  { timeout: TIMEOUT },
  async () => {
    const fixture = await startFixture();
    const { kernel } = fixture;
    try {
      await kernel.mutate(() => createUser(kernel, { username: 'alice' }));
      const room = Object.keys(kernel.state.world.rooms)[0];
      assert.ok(room);
      const session = await fixture.open();

      assert.equal(
        await session.run(
          "storage.db.users.findOne({username: 'alice'}).then(user => user.username)",
          /\r\n$/,
        ),
        "< 'alice'\r\n",
      );
      assert.equal(
        await session.run(
          `storage.db.rooms.update({_id: '${room}'}, {$set: {status: 'out of borders'}})`,
          /\r\n$/,
        ),
        '< { modified: 1 }\r\n',
      );
      assert.equal(
        await kernel.read(() => kernel.state.world.rooms[room]?.status),
        'out of borders',
      );

      await kernel.mutate(() => {
        const target = kernel.state.world.rooms[room];
        assert.ok(target);
        target.status = 'normal';
      });
      assert.equal(
        await session.run(
          `storage.db.rooms.findOne({_id: '${room}'}).then(r => r.status)`,
          /\r\n$/,
        ),
        "< 'normal'\r\n",
      );
    } finally {
      await fixture.close();
    }
  },
);

void it(
  'controls the simulation from commands without deadlocking',
  { timeout: TIMEOUT },
  async () => {
    const fixture = await startFixture();
    const { kernel } = fixture;
    try {
      const session = await fixture.open();
      assert.equal(await session.run('system.resumeSimulation()', /\r\n$/), "< 'OK'\r\n");
      assert.equal(kernel.state.paused, false);
      const [, paused] = await Promise.all([
        kernel.step(),
        session.run('system.pauseSimulation()', /\r\n$/),
      ]);
      assert.equal(paused, "< 'OK'\r\n");
      assert.equal(kernel.state.paused, true);

      assert.equal(await session.run('system.setTickDuration(250)', /\r\n$/), "< 'OK'\r\n");
      assert.equal(await session.run('system.getTickDuration()', /\r\n$/), '< 250\r\n');
      assert.equal(kernel.state.tickDuration, 250);

      assert.equal(
        await session.run(
          'storage.db.users.find({}).then(() => system.resumeSimulation())' +
            '.then(() => storage.env.get(storage.env.keys.GAMETIME))' +
            ".then(() => system.pauseSimulation()).then(() => 'chained')",
          /\r\n$/,
        ),
        "< 'chained'\r\n",
      );
      assert.equal(
        await session.run(
          'Promise.all([system.resumeSimulation(), storage.db.rooms.count({}), ' +
            "system.setTickDuration(300), system.runCronjob('roomsForceUpdate'), " +
            'system.pauseSimulation()]).then(results => results[3])',
          /\r\n$/,
        ),
        "< 'OK'\r\n",
      );
      assert.equal(kernel.state.paused, true);
      assert.equal(kernel.state.tickDuration, 300);

      assert.equal(
        await session.run("system.runCronjob('missing')", /\r\n$/),
        '< Error: Cronjob "missing" not found\r\n',
      );
      assert.equal(
        await session.run("system.setTickDuration('abc')", /\r\n$/),
        '< Error: Invalid minimal duration abc, integer expected.\r\n',
      );
    } finally {
      await fixture.close();
    }
  },
);

void it(
  'applies mod greeting, sandbox and cliSandbox customizations',
  { timeout: TIMEOUT },
  async () => {
    const cli = new OriginalCliConfig();
    cli.greeting = 'Custom {build} CLI\r\n';
    cli.on('cliSandbox', (sandbox) => {
      sandbox.test = function () {
        sandbox.print('This is the test!');
        return 'Test result';
      };
    });
    const createSandbox = cli.createSandbox;
    cli.createSandbox = (output) => Object.assign(createSandbox(output), { answer: 42 });
    const fixture = await startFixture({}, { cli });
    try {
      const session = await openSession(fixture.server.address.port);
      assert.equal(await session.until(/< \r\n$/), 'Custom CLI\r\n< \r\n');
      assert.equal(
        await session.run('test()', /< Test result\r\n$/),
        "'This is the test!'\r\n< Test result\r\n",
      );
      assert.equal(await session.run('answer', /\r\n$/), '< 42\r\n');
      assert.ok(!fixture.logs.some((line) => line.includes('deprecated')));
      cli.createSandbox(() => undefined);
      assert.ok(
        fixture.logs.some((line) => line.includes('config.cli.createSandbox is deprecated')),
      );
    } finally {
      await fixture.close();
    }
  },
);

void it(
  'reports synchronous and asynchronous failures like the original',
  { timeout: TIMEOUT },
  async () => {
    const fixture = await startFixture();
    try {
      const session = await fixture.open();
      assert.equal(
        await session.run('throw new TypeError("bad")', /\r\n$/),
        '< TypeError: bad\r\n',
      );
      assert.match(await session.run('(', /\r\n$/), /^< SyntaxError: /);
      assert.match(
        await session.run('Promise.reject(new Error("boom"))', /\r\n$/),
        /^< Error: Error: boom\n\s+at /,
      );
      assert.equal(await session.run('Promise.reject("plain")', /\r\n$/), '< Error: plain\r\n');
      assert.equal(
        await session.run("(async () => { throw 'from async'; })()", /\r\n$/),
        '< Error: from async\r\n',
      );
      assert.equal(
        await session.run("map.removeRoom('W99N99')", /\r\n$/),
        '< Error: The room W99N99 is not found\r\n',
      );
      assert.match(
        await session.run("bots.spawn('missing', 'W0N0')", /\r\n$/),
        /^< Error: Error: Bot AI with the name "missing" doesn't exist\n/,
      );
      assert.equal(
        await session.run("strongholds.expand('W0N0')", /\r\n$/),
        '< Error: There is no NPC Stronghold in this room\r\n',
      );
      // Falsy promise results print nothing, as upstream.
      assert.equal(await session.run("Promise.resolve(0)\r\n'next'", /< next\r\n$/), '< next\r\n');
    } finally {
      await fixture.close();
    }
  },
);

void it(
  'manages rooms, bots and the world through the original methods',
  { timeout: TIMEOUT },
  async () => {
    const assets = await mkdtemp(join(tmpdir(), 'openscreeps-cli-assets-'));
    const botDirectory = await mkdtemp(join(tmpdir(), 'openscreeps-cli-bot-'));
    await writeFile(join(botDirectory, 'main.js'), 'module.exports.loop = function () {};\n');
    await writeFile(join(botDirectory, 'role.worker.js'), 'module.exports = {};\n');
    await writeFile(join(assets, 'keep.txt'), 'operator file');
    const fixture = await startFixture(
      { assetDirectory: assets },
      { bots: { testbot: botDirectory } },
    );
    const { kernel } = fixture;
    try {
      const session = await fixture.open();

      assert.equal(
        await session.run("map.generateRoom('E0N0', {sources: 1, mineral: false})", /\r\n$/),
        "< 'OK'\r\n",
      );
      assert.equal(kernel.state.world.rooms.E0N0?.status, 'normal');
      assert.ok((await stat(join(assets, 'map', 'E0N0.png'))).isFile());
      assert.equal(await session.run("map.closeRoom('E0N0')", /\r\n$/), '< { modified: 1 }\r\n');
      assert.equal(kernel.state.world.rooms.E0N0.status, 'out of borders');
      assert.equal(await session.run("map.closeRoom('E0N0')", /\r\n$/), '< {}\r\n');
      assert.equal(await session.run("map.openRoom('E0N0')", /\r\n$/), '< { modified: 1 }\r\n');
      assert.equal(kernel.state.world.rooms.E0N0.status, 'normal');
      assert.equal(await session.run("map.removeRoom('E0N0')", /\r\n$/), "< 'OK'\r\n");
      assert.equal(Object.hasOwn(kernel.state.world.rooms, 'E0N0'), false);
      await assert.rejects(stat(join(assets, 'map', 'E0N0.png')), { code: 'ENOENT' });

      const room = Object.values(kernel.state.world.roomObjects).find(
        (object) => object.type === 'controller' && !object.user,
      )?.room;
      assert.ok(room);
      assert.equal(
        await session.run(`bots.spawn('testbot', '${room}', {username: 'TestBot'})`, /\r\n$/),
        `< 'User TestBot with bot AI "testbot" spawned in ${room}'\r\n`,
      );
      const bot = Object.values(kernel.state.world.users).find(
        (user) => user.username === 'TestBot',
      );
      assert.equal(bot?.bot, 'testbot');
      assert.equal(
        await session.run("bots.reload('testbot')", /\r\n$/),
        "< 'Reloaded scripts for users: TestBot'\r\n",
      );
      assert.equal(
        await session.run("bots.reload('nobody')", /\r\n$/),
        "< 'No bot players found'\r\n",
      );
      assert.match(
        await session.run('help(bots)', /\]\r\n$/),
        new RegExp(` - testbot \\[${botDirectory.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\\]`),
      );
      assert.equal(
        await session.run("bots.removeUser('TestBot')", /\r\n$/),
        "< 'User removed successfully'\r\n",
      );
      assert.ok(
        !Object.values(kernel.state.world.users).some((user) => user.username === 'TestBot'),
      );
      assert.equal(
        await session.run("bots.removeUser('TestBot')", /\r\n$/),
        '< Error: User not found\r\n',
      );

      const messages: unknown[] = [];
      kernel.events.on('message', (channel, data) => {
        if (channel === 'serverMessage') messages.push(data);
      });
      assert.equal(
        await session.run("system.sendServerMessage('hello').then(() => 'sent')", /\r\n$/),
        "< 'sent'\r\n",
      );
      assert.deepEqual(messages, ['hello']);

      await kernel.mutate(() => createUser(kernel, { username: 'alice' }));
      await kernel.step();
      assert.equal(
        await session.run("system.resetAllData().then(() => 'reset')", /\r\n$/),
        "< 'reset'\r\n",
      );
      assert.ok(!Object.values(kernel.state.world.users).some((user) => user.username === 'alice'));
      assert.deepEqual(kernel.state.profiles, {});
      assert.equal((await stat(join(assets, 'keep.txt'))).isFile(), true);
    } finally {
      await fixture.close();
      await rm(assets, { recursive: true, force: true });
      await rm(botDirectory, { recursive: true, force: true });
    }
  },
);

void it('closes sessions, subscriptions and the listener', { timeout: TIMEOUT }, async () => {
  const cli = new OriginalCliConfig();
  const received: unknown[] = [];
  const early: PromiseWithResolvers<void> = Promise.withResolvers();
  cli.on('cliSandbox', (sandbox) => {
    sandbox.record = (data: unknown) => {
      received.push(data);
      early.resolve();
    };
  });
  const created: { storage?: OriginalStorage } = {};
  const fixture = await startFixture({}, (kernel) => {
    created.storage = createOriginalStorage(kernel);
    return { cli, storage: created.storage };
  });
  const { kernel, server } = fixture;
  const { storage } = created;
  try {
    assert.ok(storage);
    const session = await fixture.open();
    await session.run(
      "storage.pubsub.subscribe('custom', data => record(data)); 'subscribed'",
      /< subscribed\r\n$/,
    );
    await storage.pubsub.publish('custom', 'early');
    await early.promise;
    await server.close();
    await session.closed;
    // A later subscriber is delivered in the same dispatch the closed CLI's would have been.
    const late: PromiseWithResolvers<void> = Promise.withResolvers();
    const unsubscribe = storage.pubsub.subscribe('custom', () => {
      late.resolve();
    });
    await storage.pubsub.publish('custom', 'late');
    await late.promise;
    unsubscribe();
    assert.deepEqual(received, ['early']);
    const refused: PromiseWithResolvers<void> = Promise.withResolvers();
    const probe = connect(server.address.port, '127.0.0.1');
    probe.once('connect', () => {
      probe.destroy();
      refused.resolve();
    });
    probe.once('error', refused.reject);
    await assert.rejects(refused.promise, { code: 'ECONNREFUSED' });
    await server.close();
    assert.equal(await kernel.read(() => kernel.state.paused), true);
  } finally {
    await fixture.close();
  }
});
