import assert from 'node:assert/strict';
import { it } from 'node:test';
import { gameStateOf, spawnBot } from '@openscreeps/game';
import { createUser } from '../src/api/users.ts';
import { createConfig } from '../src/config.ts';
import { ServerKernel } from '../src/services/server-kernel.service.ts';

void it('delivers maintenance notifications to account addresses outside the game state', async () => {
  const kernel = await ServerKernel.create(
    createConfig({ database: ':memory:', worldSize: 2, paused: true }),
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
  const kernel = await ServerKernel.create(
    createConfig({ database: ':memory:', worldSize: 2, paused: true }),
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
