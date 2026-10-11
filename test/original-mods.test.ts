import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isRecord, recordRoomObjectWrite, spawnBot } from '@openscreeps/game';
import { createServer, type RunningServer } from '../src/server.ts';

// Same CommonJS dependency in both worlds: Node's process-global require cache must not leak it.
void test('original mods keep module state, constants, storage and player hooks scoped to their world', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openscreeps-mods-'));
  const servers: RunningServer[] = [];
  try {
    await writeFile(
      join(directory, 'shared.cjs'),
      'let count = 0; module.exports = () => ++count;',
    );
    for (const lifetime of [300, 700]) {
      const mod = `module.exports = function(config) {
        const common = require('@screeps/common');
        const next = require('./shared.cjs');
        config.common.constants.CREEP_LIFE_TIME = ${String(lifetime)};
        config.common.dbCollections.push('mod.records');
        if (config.backend) config.backend.router.get('/mod-probe', async (_request, response) => {
          const value = next();
          await common.storage.db['mod.records'].insert({_id:'record', value});
          response.json(await common.storage.db['mod.records'].findOne({_id:'record'}));
        });
        if (config.engine) {
          config.engine.registerCustomObjectPrototype('modCounter', 'ModCounter', {
            properties: {counter: object => object.counter}, findConstant: 10000,
            prototypeExtender(prototype, scope) {
              prototype.increment = function(value) {
                scope.intents.set(this.id, 'incCounter', {value});
              };
            },
          });
          config.engine.customIntentTypes.incCounter = {value: 'number'};
          config.engine.on('processObjectIntents', (object, _user, intents, _objects, _terrain, _time, _info, bulk) => {
            if (object.type === 'modCounter' && intents.incCounter) {
              bulk.update(object, {counter: object.counter + intents.incCounter.value});
            }
          });
          config.engine.on('playerSandbox', sandbox => sandbox.set('modValue', ${String(lifetime)}));
          config.engine.on('processObject', (object, _objects, _terrain, _time, _info, bulk) => {
            if (object.type === 'modCounter') bulk.update(object, {counter: object.counter + 1});
          });
        }
      };`;
      await writeFile(join(directory, `mod-${String(lifetime)}.cjs`), mod);
      const manifest = join(directory, `mods-${String(lifetime)}.json`);
      await writeFile(manifest, JSON.stringify({ mods: [`mod-${String(lifetime)}.cjs`] }));
      const server = await createServer({
        database: ':memory:',
        port: 0,
        worldSize: 3,
        paused: true,
        modFile: manifest,
        ...(lifetime === 700
          ? { runnerCount: 1, processorCount: 1, workerRestartInterval: 0 }
          : {}),
      });
      servers.push(server);
    }
    for (const [index, server] of servers.entries()) {
      const lifetime = index === 0 ? 300 : 700;
      const response = await fetch(`http://127.0.0.1:${String(server.address.port)}/api/mod-probe`);
      assert.equal(response.status, 200);
      const record: unknown = await response.json();
      assert.ok(isRecord(record));
      assert.equal(record.value, 1);
      const user = await server.kernel.mutate(() => {
        const world = server.kernel.state.world;
        const controller = Object.values(world.roomObjects).find(
          (object) => object.type === 'controller',
        );
        assert.ok(controller);
        const player = spawnBot(
          server.context,
          'probe',
          {
            main: 'module.exports.loop = () => { const counter = Game.getObjectById("mod-counter"); Memory.probe = [CREEP_LIFE_TIME, modValue, counter.counter]; counter.increment(7); };',
          },
          controller.room,
          { username: 'ModProbe' },
        );
        const counter = {
          _id: 'mod-counter',
          type: 'modCounter',
          room: controller.room,
          x: 24,
          y: 24,
          counter: 0,
        };
        world.roomObjects['mod-counter'] = counter;
        recordRoomObjectWrite(world, 'mod-counter');
        return player;
      });
      await server.kernel.step();
      await server.kernel.step();
      const runtime = server.kernel.runtime.snapshot().users[user.userId];
      assert.ok(runtime);
      const memory: unknown = JSON.parse(runtime.memory);
      assert.ok(isRecord(memory));
      assert.deepEqual(memory.probe, [lifetime, lifetime, 8]);
      const counter = server.kernel.state.world.roomObjects['mod-counter'];
      assert.ok(counter && 'counter' in counter);
      assert.equal(counter.counter, 16);
      assert.equal(server.kernel.state.originalStorage?.collections['mod.records']?.[0]?.value, 1);
    }
  } finally {
    await Promise.all(servers.map((server) => server.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
