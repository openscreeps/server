import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  adminRequestBody,
  adminTokenPath,
  main,
  parseInvocation,
  startServer,
  UsageError,
} from '../src/cli.ts';
import { isRecord } from '../src/api/guards.ts';
import type { RunningServer } from '../src/server.ts';

const environment: NodeJS.ProcessEnv = {};

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'openscreeps-cli-'));
}

function botDirectory(root: string): string {
  const directory = join(root, 'bot');
  mkdirSync(directory);
  writeFileSync(join(directory, 'main.js'), 'module.exports.loop = function () {};\n');
  writeFileSync(join(directory, 'role.harvester.js'), 'module.exports = {};\n');
  writeFileSync(join(directory, 'notes.txt'), 'ignored');
  return directory;
}

void describe('admin request mapping', () => {
  void it('maps ergonomic commands to admin DTOs', async () => {
    assert.deepEqual(await adminRequestBody(['tick'], environment), { action: 'tick' });
    assert.deepEqual(await adminRequestBody(['tick', '5'], environment), {
      action: 'tick',
      count: 5,
    });
    assert.deepEqual(await adminRequestBody(['tick-duration', '250'], environment), {
      action: 'tick-duration',
      milliseconds: 250,
    });
    assert.deepEqual(
      await adminRequestBody(
        ['user', 'update', 'alice', '--cpu', '50', '--no-active'],
        environment,
      ),
      { action: 'user-update', username: 'alice', cpu: 50, active: false },
    );
    assert.deepEqual(await adminRequestBody(['user', 'remove', 'abc', '--id'], environment), {
      action: 'user-remove',
      userId: 'abc',
    });
    assert.deepEqual(
      await adminRequestBody(
        [
          'room',
          'generate',
          'W1N1',
          '--options',
          '{"sources":1,"bus":true}',
          '--sources',
          '2',
          '--mineral',
          'none',
          '--no-controller',
        ],
        environment,
      ),
      {
        action: 'room-generate',
        room: 'W1N1',
        options: { sources: 2, bus: true, mineral: false, controller: false },
      },
    );
    assert.deepEqual(await adminRequestBody(['room', 'open', 'W1N1'], environment), {
      action: 'room-open',
      room: 'W1N1',
    });
    assert.deepEqual(await adminRequestBody(['message', 'hello', 'world'], environment), {
      action: 'server-message',
      message: 'hello world',
    });
    assert.deepEqual(
      await adminRequestBody(
        ['admin', 'stronghold-expand', '--json', '{"room":"W5N5"}'],
        environment,
      ),
      { action: 'stronghold-expand', room: 'W5N5' },
    );
  });

  void it('uploads bot code read locally instead of a server path', async () => {
    const root = temporaryDirectory();
    try {
      const directory = botDirectory(root);
      const body = await adminRequestBody(
        ['bot', 'add', 'simple', 'W1N1', '--dir', directory, '--cpu', '20'],
        environment,
      );
      assert.deepEqual(body, {
        action: 'bot-add',
        name: 'simple',
        modules: {
          main: 'module.exports.loop = function () {};\n',
          'role.harvester': 'module.exports = {};\n',
        },
        room: 'W1N1',
        options: { cpu: 20 },
      });
      assert.ok(!JSON.stringify(body).includes(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it('rejects invalid usage', async () => {
    for (const args of [
      ['frobnicate'],
      ['user'],
      ['--url', 'http://x', 'status'],
      ['status', '--bogus'],
      ['tick', 'many'],
      ['tick-duration'],
      ['user', 'update', 'alice'],
      ['bot', 'reload', 'simple'],
      ['admin', 'status', '--json', '[]'],
      ['admin', 'status', '--json', '{"action":"pause"}'],
      ['admin', 'Status'],
    ]) {
      await assert.rejects(adminRequestBody(args, environment), UsageError, args.join(' '));
    }
    assert.equal(parseInvocation(['help'], environment), undefined);
    assert.equal(parseInvocation(['status', '--help'], environment)?.help, true);
  });
});

void describe('init', () => {
  void it('creates the world and an owner-only token file without overwriting either', async () => {
    const root = temporaryDirectory();
    try {
      const database = join(root, 'world.sqlite');
      await main(['init', '--database', database, '--world-size', '3', '--username', 'alice'], {
        SCREEPS_INITIAL_PASSWORD: 'correct horse battery',
      });
      assert.ok(existsSync(database));
      const tokenFile = adminTokenPath(database);
      const token = readFileSync(tokenFile, 'utf8').trim();
      assert.ok(token.length >= 32);
      if (process.platform !== 'win32') assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
      await assert.rejects(main(['init', '--database', database], environment), /already exists/);
      assert.equal(readFileSync(tokenFile, 'utf8').trim(), token);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it('requires an explicit password for the initial player and leaves nothing behind on failure', async () => {
    const root = temporaryDirectory();
    try {
      const database = join(root, 'world.sqlite');
      await assert.rejects(
        main(['init', '--database', database, '--username', 'alice'], environment),
        UsageError,
      );
      await assert.rejects(
        main(['init', '--database', database, '--world-size', '3', '--username', 'x'], {
          SCREEPS_INITIAL_PASSWORD: 'correct horse battery',
        }),
      );
      assert.ok(!existsSync(database));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

void describe('administration over HTTP', () => {
  let root: string;
  let database: string;
  let server: RunningServer;
  let url: string;

  before(async () => {
    root = temporaryDirectory();
    database = join(root, 'world.sqlite');
    await main(['init', '--database', database, '--world-size', '3'], environment);
    const invocation = parseInvocation(
      ['start', '--database', database, '--host', '127.0.0.1', '--port', '0', '--paused'],
      environment,
    );
    assert.ok(invocation);
    server = await startServer(invocation.input);
    url = `http://127.0.0.1:${String(server.address.port)}`;
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  const admin = (...args: string[]): Promise<void> =>
    main([...args, '--url', url, '--database', database], environment);

  void it('authenticates with the token file and rejects other tokens', async () => {
    await admin('status');
    await assert.rejects(
      main(['status', '--url', url, '--admin-token', 'x'.repeat(40)], environment),
      /HTTP 40[13]/,
    );
  });

  void it('controls the scheduler', async () => {
    const time = server.kernel.state.world.gameTime;
    await admin('tick', '2');
    assert.equal(server.kernel.state.world.gameTime, time + 2);
    await admin('resume');
    assert.equal(server.kernel.state.paused, false);
    await admin('pause');
    assert.equal(server.kernel.state.paused, true);
    await admin('tick-duration', '500');
    assert.equal(server.kernel.state.tickDuration, 500);
  });

  void it('uploads NPC bot code and reports server errors', async () => {
    const room = Object.values(server.kernel.state.world.roomObjects).find(
      (object) => object.type === 'controller' && object.user === undefined,
    )?.room;
    assert.ok(room);
    await admin(
      'bot',
      'add',
      'simple',
      room,
      '--dir',
      botDirectory(root),
      '--username',
      'SimpleBot',
    );
    const bot = Object.values(server.kernel.state.world.users).find(
      (user) => user.username === 'SimpleBot',
    );
    assert.equal(bot?.bot, 'simple');
    await assert.rejects(admin('bot', 'reload', 'missing', '--dir', join(root, 'bot')), /HTTP 404/);
    await admin('bot', 'remove', 'SimpleBot');
  });

  void it('keeps room lifecycle state aligned with the game contract', async () => {
    const room = 'W50N50';
    const userId = await server.kernel.mutate(() => {
      const userId = 'room-lifecycle-user';
      const { state } = server.kernel;
      state.world.users[userId] = { _id: userId, username: 'RoomLifecycle', rooms: [room] };
      state.world.rooms[room] = { _id: room, status: 'out of borders' };
      state.world.terrain[room] = '0'.repeat(2500);
      state.world.roomObjects['room-lifecycle-object'] = {
        _id: 'room-lifecycle-object',
        type: 'controller',
        room,
        x: 25,
        y: 25,
        level: 0,
      };
      state.world.flags['room-lifecycle-flag'] = {
        _id: 'room-lifecycle-flag',
        user: userId,
        room,
        data: 'F~1~1~10~10',
      };
      state.world.roomEventLogs[room] = [];
      state.pendingIntents = { ...state.pendingIntents, [room]: { [userId]: { room: {} } } };
      server.kernel.terrainChanged();
      return userId;
    });
    const active = [...server.kernel.state.world.activeRooms];
    await admin('room', 'open', room);
    assert.equal(server.kernel.state.world.rooms[room]?.status, 'normal');
    assert.deepEqual(server.kernel.state.world.activeRooms, active);
    await admin('room', 'close', room);
    assert.equal(server.kernel.state.world.rooms[room].status, 'out of borders');
    await server.kernel.mutate(() => {
      server.kernel.state.world.activeRooms.push(room);
    });
    await admin('room', 'remove', room);
    const { state } = server.kernel;
    assert.equal(Object.hasOwn(state.world.rooms, room), false);
    assert.equal(Object.hasOwn(state.world.terrain, room), false);
    assert.equal(Object.hasOwn(state.world.roomObjects, 'room-lifecycle-object'), false);
    assert.equal(Object.hasOwn(state.world.flags, 'room-lifecycle-flag'), false);
    assert.equal(Object.hasOwn(state.pendingIntents, room), false);
    assert.deepEqual(state.world.users[userId]?.rooms, [room]);
    assert.equal(state.world.activeRooms.includes(room), true);
    assert.deepEqual(state.world.roomEventLogs[room], []);
    await admin('room', 'open', room);
    await admin('room', 'close', room);
    assert.equal(Object.hasOwn(server.kernel.state.world.rooms, room), false);
    await assert.rejects(admin('room', 'remove', room), /HTTP 400/);
  });

  void it('exports and imports durable snapshots', async () => {
    const file = join(root, 'snapshot.json');
    await admin('snapshot', 'export', file);
    const snapshot: unknown = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(isRecord(snapshot));
    assert.equal(snapshot.version, 1);
    await assert.rejects(admin('snapshot', 'export', file), /already exists/);
    await admin('snapshot', 'export', file, '--force');
    await admin('tick', '1');
    const time = server.kernel.state.world.gameTime;
    await admin('snapshot', 'import', file);
    assert.equal(server.kernel.state.world.gameTime, time - 1);
  });
});
