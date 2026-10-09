import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { BotRuntime, createWorldState } from '@openscreeps/game';
import { PNG } from 'pngjs';
import {
  getAsset,
  renderRoomImage,
  renderSectorImage,
  sectorImageRoom,
  writeRoomImageAssets,
} from '../src/assets.ts';
import { createConfig } from '../src/config.ts';
import type { ServerContext, ServerEvents, ServerState } from '../src/contracts.ts';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

/** Plain room with a wall at (5,5), a swamp at (6,5) and a swampy wall at (7,5). */
function terrain(): string {
  const tiles = Array.from({ length: 2500 }, () => '0');
  tiles[5 * 50 + 5] = '1';
  tiles[5 * 50 + 6] = '2';
  tiles[5 * 50 + 7] = '3';
  return tiles.join('');
}

function pixel(image: PNG, x: number, y: number): number[] {
  const offset = (y * image.width + x) * 4;
  return [...image.data.subarray(offset, offset + 4)];
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'openscreeps-assets-'));
  cleanup.push(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function context(assetDirectory?: string): ServerContext {
  const runtime = new BotRuntime();
  cleanup.push(() => {
    runtime.dispose();
  });
  const state: ServerState = {
    version: 1,
    world: createWorldState({ terrain: { W1N1: terrain(), W3N3: '1'.repeat(2500) } }),
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
  return {
    config: createConfig({
      database: ':memory:',
      ...(assetDirectory === undefined ? {} : { assetDirectory }),
    }),
    state,
    runtime,
    events: new EventEmitter<ServerEvents>(),
    now: () => 0,
    read: async (operation) => operation(),
    mutate: async (operation) => operation(),
    publish: () => undefined,
    terrainChanged: () => undefined,
    step: () => Promise.reject(new Error('not used')),
    setPaused: () => Promise.resolve(),
    setTickDuration: () => Promise.resolve(),
  };
}

void describe('terrain images', () => {
  void it('draws rooms three pixels per tile in the upstream colors', () => {
    const image = PNG.sync.read(renderRoomImage(terrain()));
    assert.equal(image.width, 150);
    assert.equal(image.height, 150);
    assert.deepEqual(pixel(image, 5 * 3 + 1, 5 * 3 + 2), [0, 0, 0, 255]);
    assert.deepEqual(pixel(image, 6 * 3, 5 * 3), [35, 37, 19, 255]);
    assert.deepEqual(pixel(image, 7 * 3 + 2, 5 * 3 + 2), [0, 0, 0, 255]);
    assert.deepEqual(pixel(image, 0, 30), [50, 50, 50, 255]);
    assert.deepEqual(pixel(image, 149, 149), [50, 50, 50, 255]);
    assert.deepEqual(pixel(image, 30, 30), [43, 43, 43, 255]);
  });

  void it('places 4x4 rooms per zoom 2 image, transparent where no room exists', () => {
    assert.equal(sectorImageRoom('W1N1'), 'W3N3');
    assert.equal(sectorImageRoom('E0S0'), 'E0S0');
    assert.equal(sectorImageRoom('E5S6'), 'E4S4');
    const terrains: Array<string | undefined> = Array.from({ length: 16 }, () => undefined);
    terrains[2 * 4 + 2] = terrain();
    const image = PNG.sync.read(renderSectorImage(terrains));
    assert.equal(image.width, 200);
    assert.deepEqual(pixel(image, 0, 0), [0, 0, 0, 0]);
    assert.deepEqual(pixel(image, 100 + 5, 100 + 5), [0, 0, 0, 255]);
    assert.deepEqual(pixel(image, 100 + 6, 100 + 5), [35, 37, 19, 255]);
    assert.deepEqual(pixel(image, 100, 120), [50, 50, 50, 255]);
    assert.deepEqual(pixel(image, 99, 120), [0, 0, 0, 0]);
  });
});

void describe('asset requests', () => {
  void it('renders the map images the client requests from the committed terrain', async () => {
    const server = context();
    const room = await getAsset(server, 'map/W1N1.png');
    assert.ok(room);
    assert.equal(room.contentType, 'image/png');
    assert.deepEqual(room.body, renderRoomImage(terrain()));
    assert.equal(await getAsset(server, 'map/W1N1.png'), room);

    const sector = await getAsset(server, 'map/zoom2/W3N3.png');
    assert.ok(sector);
    const image = PNG.sync.read(sector.body);
    assert.deepEqual(pixel(image, 0, 0), [0, 0, 0, 255]);
    assert.deepEqual(pixel(image, 100 + 6, 100 + 5), [35, 37, 19, 255]);
    // Only block-aligned names exist, as upstream only wrote those files.
    assert.equal(await getAsset(server, 'map/zoom2/W1N1.png'), undefined);
    assert.equal(await getAsset(server, 'map/W9N9.png'), undefined);

    server.state.world.terrain.W1N1 = '1'.repeat(2500);
    const changed = await getAsset(server, 'map/W1N1.png');
    assert.deepEqual(changed?.body, renderRoomImage('1'.repeat(2500)));
  });

  void it('serves the operator directory without leaving it', async () => {
    const directory = temporaryDirectory();
    const assets = join(directory, 'assets');
    mkdirSync(join(assets, 'renderer'), { recursive: true });
    mkdirSync(join(assets, 'map'), { recursive: true });
    writeFileSync(join(assets, 'renderer', 'gift.png'), 'gift');
    writeFileSync(join(assets, 'renderer', 'data.json'), '{}');
    writeFileSync(join(assets, 'map', 'E9S9.png'), 'custom');
    writeFileSync(join(assets, '.secret'), 'hidden');
    writeFileSync(join(directory, 'outside.txt'), 'outside');
    const server = context(assets);

    assert.deepEqual(await getAsset(server, 'renderer/gift.png'), {
      body: Buffer.from('gift'),
      contentType: 'image/png',
    });
    assert.equal(
      (await getAsset(server, 'renderer/data.json'))?.contentType,
      'application/json; charset=utf-8',
    );
    assert.deepEqual((await getAsset(server, 'map/E9S9.png'))?.body, Buffer.from('custom'));
    for (const path of [
      '../outside.txt',
      'renderer/../../outside.txt',
      '.secret',
      'renderer//gift.png',
      'renderer\\..\\..\\outside.txt',
      `${directory}/outside.txt`,
      'C:/outside.txt',
      'renderer',
      'renderer/missing.png',
      'renderer/gift.png\0',
    ]) {
      assert.equal(await getAsset(server, path), undefined, path);
    }
    assert.equal(await getAsset(context(), 'renderer/gift.png'), undefined);
  });

  void it('writes the room and zoom 2 images like map.updateRoomImageAssets', async () => {
    const directory = temporaryDirectory();
    const world = { W1N1: terrain(), W3N3: '1'.repeat(2500) };
    await writeRoomImageAssets(directory, world, 'W1N1');
    assert.deepEqual(readFileSync(join(directory, 'map', 'W1N1.png')), renderRoomImage(terrain()));
    const sector = PNG.sync.read(readFileSync(join(directory, 'map', 'zoom2', 'W3N3.png')));
    assert.deepEqual(pixel(sector, 0, 0), [0, 0, 0, 255]);
    assert.deepEqual(pixel(sector, 100 + 6, 100 + 5), [35, 37, 19, 255]);
    await assert.rejects(writeRoomImageAssets(directory, world, 'W7N7'), /no terrain/);
  });
});
