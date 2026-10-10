import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { operationIds, operations } from '../src/generated/api/index.ts';
import { routePath } from '../src/api/operations.ts';
import { isRecord } from '../src/api/guards.ts';
import { createConfig } from '../src/config.ts';
import { OpenScreepsModule } from '../src/server.ts';
import { componentValidator } from './contract-harness.ts';

/** `METHOD path` of every route Express actually dispatches, as registered by Nest. */
function registeredRoutes(app: NestExpressApplication): string[] {
  const router: unknown = Reflect.get(app.getHttpAdapter().getInstance(), 'router');
  assert.ok(typeof router === 'function' || isRecord(router), 'Express router');
  const stack: unknown = Reflect.get(router, 'stack');
  assert.ok(Array.isArray(stack), 'Express 5 router stack');
  const routes: string[] = [];
  for (const layer of stack as unknown[]) {
    const route = isRecord(layer) ? layer['route'] : undefined;
    if (!isRecord(route) || typeof route['path'] !== 'string' || !isRecord(route['methods'])) {
      continue;
    }
    for (const [method, enabled] of Object.entries(route['methods'])) {
      if (enabled === true && method !== '_all') {
        routes.push(`${method.toUpperCase()} ${route['path']}`);
      }
    }
  }
  return routes.sort();
}

void describe('contract routes', () => {
  void it('registers every composed operation, and nothing else, as a real Nest route', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openscreeps-routes-'));
    const config = createConfig({
      database: join(directory, 'world.sqlite'),
      worldSize: 1,
      paused: true,
    });
    const app = await NestFactory.create<NestExpressApplication>(
      OpenScreepsModule.register(config),
      { bodyParser: false, logger: false, abortOnError: false },
    );
    try {
      await app.init();
      const expected = operationIds
        .map((id) => `${operations[id].method.toUpperCase()} ${routePath(id)}`)
        .sort();
      const registered = registeredRoutes(app);
      assert.deepEqual(
        {
          missing: expected.filter((route) => !registered.includes(route)),
          extra: registered.filter((route) => !expected.includes(route)),
          duplicate: registered.filter((route, index) => registered.indexOf(route) !== index),
        },
        { missing: [], extra: [], duplicate: [] },
      );
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

void describe('server-owned contract schemas', () => {
  void it('requires one administrator identity, real changes and whitelisted fields', () => {
    const validate = componentValidator('AdminCommand');
    assert.equal(validate({ action: 'user-update', username: 'ContractPlayer', cpu: 20 }), true);
    assert.equal(validate({ action: 'user-update', username: 'ContractPlayer' }), false);
    assert.equal(
      validate({ action: 'user-update', username: 'ContractPlayer', userId: 'id', cpu: 20 }),
      false,
    );
    assert.equal(validate({ action: 'user-remove' }), false);
    assert.equal(
      validate({ action: 'user-remove', username: 'ContractPlayer', force: true }),
      false,
    );
    assert.equal(
      validate({ action: 'user-update', username: 'ContractPlayer', resources: { energy: 100 } }),
      false,
    );
    assert.equal(
      validate({ action: 'user-update', username: 'ContractPlayer', resources: { pixel: 0 } }),
      true,
    );
    assert.equal(validate({ action: 'tick', count: 1001 }), false);
  });

  void it('requires a main bot module and rejects path-like module names', () => {
    const modules = componentValidator('AdminModules');
    assert.equal(modules({ main: 'module.exports.loop = () => {}' }), true);
    assert.equal(modules({ library: 'module.exports = {}' }), false);
    assert.equal(modules({ main: '', '../escape': '' }), false);
  });

  void it('keeps the standalone boolean Steam ownership flag as a profile variant', () => {
    const validate = componentValidator('AuthSteamAccount');
    assert.equal(validate({ id: '76561198000000001', ownership: false }), true);
    assert.equal(validate({ ownership: { app: 464350 } }), false);
  });
});
