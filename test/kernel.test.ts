import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createConfig } from '../src/config.ts';
import { ServerKernel } from '../src/kernel.ts';
import { spawnBot } from '../src/world/index.ts';

void it('preserves a committed terrain invalidation across a later rejected mutation', async () => {
  const kernel = new ServerKernel(
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
  const kernel = new ServerKernel(
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
