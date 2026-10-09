import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import { NestFactory } from '@nestjs/core';
import Database from 'better-sqlite3';
import pg from 'pg';
import { DataSource } from 'typeorm';
import { constants as C } from '@openscreeps/game';
import { ApiTestClient } from './api-harness.ts';
import { createUser } from '../src/api/users.ts';
import { createServer } from '../src/server.ts';
import { adminTokenPath, main } from '../src/cli.ts';
import { configFromEnvironment, createConfig } from '../src/config.ts';
import type { ServerConfig, ServerState } from '../src/contracts.ts';
import { databaseLabel } from '../src/database.ts';
import { PersistenceModule } from '../src/persistence.module.ts';
import { ServerKernel } from '../src/services/server-kernel.service.ts';
import { StateStore } from '../src/services/state-store.service.ts';

/** Set to a PostgreSQL URL (any database the user may create schemas in) to test PostgreSQL. */
const postgresUrl = process.env.SCREEPS_TEST_DATABASE_URL;

interface TestWorld {
  config(): ServerConfig;
  /** Runs SQL against the world's database as an outside client, bypassing the server. */
  execute(sql: string): Promise<void>;
  dispose(): Promise<void>;
}

function sqliteWorld(): Promise<TestWorld> {
  const directory = mkdtempSync(join(tmpdir(), 'openscreeps-persistence-'));
  const database = join(directory, 'world.sqlite');
  return Promise.resolve({
    config: () => createConfig({ database, worldSize: 2, paused: true }),
    execute: (sql) => {
      const connection = new Database(database, { timeout: 100 });
      try {
        connection.exec(sql);
      } finally {
        connection.close();
      }
      return Promise.resolve();
    },
    // Fails on Windows when a test leaks an open database handle.
    dispose: () => {
      rmSync(directory, { recursive: true, force: true });
      return Promise.resolve();
    },
  });
}

/** An isolated schema per test; the server reaches it through the URL's search_path. */
async function postgresWorld(): Promise<TestWorld> {
  assert.ok(postgresUrl);
  const schema = `openscreeps_test_${randomBytes(6).toString('hex')}`;
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  const url = new URL(postgresUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const directory = mkdtempSync(join(tmpdir(), 'openscreeps-persistence-'));
  return {
    config: () =>
      createConfig({
        database: join(directory, 'world.sqlite'),
        databaseUrl: url.href,
        worldSize: 2,
        paused: true,
      }),
    execute: async (sql) => {
      await client.query(sql);
    },
    dispose: async () => {
      try {
        await client.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await client.end();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

async function withWorld(
  create: () => Promise<TestWorld>,
  test: (world: TestWorld) => Promise<void>,
): Promise<void> {
  const world = await create();
  try {
    await test(world);
  } finally {
    await world.dispose();
  }
}

function persistenceContext(config: ServerConfig) {
  return NestFactory.createApplicationContext(PersistenceModule.register(config), {
    logger: false,
    abortOnError: false,
  });
}

const backends = [
  { name: 'SQLite', create: sqliteWorld, skip: false },
  {
    name: 'PostgreSQL',
    create: postgresWorld,
    skip: postgresUrl === undefined && 'set SCREEPS_TEST_DATABASE_URL to test PostgreSQL',
  },
] as const;

for (const backend of backends) {
  void describe(`${backend.name} persistence`, { skip: backend.skip }, () => {
    void it('reopens the committed world at its durable revision', () =>
      withWorld(backend.create, async (world) => {
        const kernel = await ServerKernel.create(world.config());
        await kernel.step();
        await kernel.step();
        const committed = JSON.stringify(await kernel.exportSnapshot());
        await kernel.close();

        const store = await StateStore.open(world.config());
        try {
          assert.equal(store.revision, 3);
          assert.equal(store.serialized, committed);
          const loaded = store.load();
          assert.ok(loaded);
          await store.save(loaded);
          assert.equal(store.revision, 3, 'an unchanged world is not rewritten');
        } finally {
          await store.close();
        }

        const reopened = await ServerKernel.create(world.config());
        try {
          assert.equal(JSON.stringify(reopened.state), committed);
          const time = reopened.state.world.gameTime;
          await reopened.step();
          assert.equal(reopened.state.world.gameTime, time + 1);
        } finally {
          await reopened.close();
        }
      }));

    void it('refuses a second writer until the owner closes', () =>
      withWorld(backend.create, async (world) => {
        const owner = await ServerKernel.create(world.config());
        try {
          await assert.rejects(
            ServerKernel.create(world.config()),
            /database is locked|owns this PostgreSQL world/,
          );
          await assert.rejects(
            persistenceContext(world.config()),
            /database is locked|owns this PostgreSQL world/,
          );
          await owner.step();
        } finally {
          await owner.close();
        }
        const successor = await ServerKernel.create(world.config());
        try {
          assert.equal(successor.state.world.gameTime, owner.state.world.gameTime);
        } finally {
          await successor.close();
        }
      }));

    void it('stops on a failed commit and keeps the last committed world', () =>
      withWorld(backend.create, async (world) => {
        const store = await StateStore.open(world.config());
        const kernel = await ServerKernel.create(world.config(), {}, store);
        let committed: string | undefined;
        try {
          committed = JSON.stringify(await kernel.exportSnapshot());
          mock.method(store, 'save', () => Promise.reject(new Error('disk full')));
          await assert.rejects(kernel.step(), /Durable commit failed/);
          assert.equal(kernel.healthy, false);
          await assert.rejects(
            kernel.read(() => undefined),
            /Durable commit failed/,
          );
        } finally {
          mock.restoreAll();
          await kernel.close();
        }
        const reopened = await StateStore.open(world.config());
        try {
          assert.equal(reopened.revision, 1);
          assert.equal(reopened.serialized, committed);
        } finally {
          await reopened.close();
        }
      }));

    void it('rolls back a rejected HTTP flag move in memory and in the durable snapshot', () =>
      withWorld(backend.create, async (world) => {
        const server = await createServer({ ...world.config(), host: '127.0.0.1', port: 0 });
        const api = new ApiTestClient(server.context);
        let committed: ServerState;
        try {
          const token = await server.kernel.mutate(() => {
            const { state } = server.kernel;
            const user = createUser(server.context, { username: 'FlagMover' });
            state.world.rooms['W9N9'] = { _id: 'W9N9', status: 'normal' };
            state.world.rooms['W9N8'] = { _id: 'W9N8', status: 'normal' };
            state.world.flags['old-room'] = {
              _id: 'old-room',
              user: user._id,
              room: 'W9N9',
              data: 'moving~1~1~10~10',
            };
            state.world.flags['full-room'] = {
              _id: 'full-room',
              user: user._id,
              room: 'W9N8',
              data: Array.from(
                { length: C.FLAGS_LIMIT },
                (_, index) => `F${String(index)}~1~1~10~10`,
              ).join('|'),
            };
            return server.context.auth.issue(user._id);
          });
          committed = await server.kernel.exportSnapshot();
          await assert.rejects(
            api.call('POST', '/api/game/create-flag', {
              token,
              body: { room: 'W9N8', name: 'moving', x: 12, y: 10, color: 2, secondaryColor: 2 },
            }),
            { status: 200, message: 'flags limit exceeded' },
          );
          assert.deepEqual(await server.kernel.exportSnapshot(), committed);
          assert.equal(server.kernel.state.world.flags['old-room']?.data, 'moving~1~1~10~10');
        } finally {
          await api.close();
          await server.close();
        }
        const store = await StateStore.open(world.config());
        try {
          assert.deepEqual(store.load(), committed);
        } finally {
          await store.close();
        }
      }));

    void it('releases a Nest-managed world on shutdown and on a failed kernel start', () =>
      withWorld(backend.create, async (world) => {
        const config = world.config();
        const app = await persistenceContext(config);
        const kernel = await ServerKernel.create(config, {}, app.get(StateStore));
        await kernel.step();
        const committed = await kernel.exportSnapshot();
        // OpenScreepsModule closes the kernel in onModuleDestroy, before TypeORM's shutdown.
        await kernel.close();
        await app.close();

        const failed = await persistenceContext(config);
        const dataSource = failed.get(DataSource);
        await assert.rejects(
          ServerKernel.create(config, { state: committed }, failed.get(StateStore)),
          /Cannot replace an existing database/,
        );
        assert.equal(dataSource.isInitialized, false);
        await failed.close();

        const store = await StateStore.open(config);
        try {
          assert.equal(store.revision, 2);
          assert.equal(store.serialized, JSON.stringify(committed));
        } finally {
          await store.close();
        }
      }));

    void it('refuses malformed stored worlds without keeping them locked', () =>
      withWorld(backend.create, async (world) => {
        await (await ServerKernel.create(world.config())).close();
        await world.execute('UPDATE server_snapshot SET schema_version = 2');
        await assert.rejects(StateStore.open(world.config()), /Unsupported database schema/);
        await assert.rejects(persistenceContext(world.config()), /Unsupported database schema/);
        await world.execute('UPDATE server_snapshot SET schema_version = 1');
        await (await ServerKernel.create(world.config())).close();
        await world.execute(`UPDATE server_snapshot SET state = '{"version":1}'`);
        await assert.rejects(
          ServerKernel.create(world.config()),
          /Unsupported or invalid server snapshot/,
        );
        await assert.rejects(
          persistenceContext(world.config()),
          /Unsupported or invalid server snapshot/,
        );
      }));
  });
}

void describe('SQLite worlds of the previous store', () => {
  void it('are adopted with their revision', () =>
    withWorld(sqliteWorld, async (world) => {
      const draft = await ServerKernel.create(
        createConfig({ database: ':memory:', worldSize: 2, paused: true }),
      );
      const state = await draft.exportSnapshot();
      await draft.close();
      const legacy = new Database(world.config().database);
      try {
        legacy.exec(`
          PRAGMA journal_mode = WAL;
          CREATE TABLE IF NOT EXISTS server_snapshot (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            schema_version INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            state TEXT NOT NULL
          );
        `);
        legacy
          .prepare(
            'INSERT INTO server_snapshot(id, schema_version, revision, state) VALUES (1, 1, 41, ?)',
          )
          .run(JSON.stringify(state));
      } finally {
        legacy.close();
      }

      const kernel = await ServerKernel.create(world.config());
      try {
        assert.equal(JSON.stringify(kernel.state), JSON.stringify(state));
        await kernel.step();
      } finally {
        await kernel.close();
      }
      const store = await StateStore.open(world.config());
      try {
        assert.equal(store.revision, 42);
        assert.equal(store.load()?.world.gameTime, state.world.gameTime + 1);
      } finally {
        await store.close();
      }
    }));
});

void describe('PostgreSQL worlds', { skip: postgresUrl === undefined }, () => {
  void it('are never overwritten after another writer changed them', () =>
    withWorld(postgresWorld, async (world) => {
      const kernel = await ServerKernel.create(world.config());
      const time = kernel.state.world.gameTime;
      try {
        await world.execute('UPDATE server_snapshot SET revision = revision + 1');
        await assert.rejects(kernel.step(), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Durable commit failed/);
          assert.ok(error.cause instanceof Error);
          assert.match(error.cause.message, /changed by another writer/);
          return true;
        });
      } finally {
        await kernel.close();
      }
      const store = await StateStore.open(world.config());
      try {
        assert.equal(store.revision, 2);
        assert.equal(store.load()?.world.gameTime, time);
      } finally {
        await store.close();
      }
    }));

  void it('are initialized once by the CLI, with the token file kept local', () =>
    withWorld(postgresWorld, async (world) => {
      const config = world.config();
      const environment: NodeJS.ProcessEnv = {
        SCREEPS_DATABASE_URL: config.databaseUrl,
        SCREEPS_INITIAL_PASSWORD: 'correct horse battery',
      };
      const init = ['init', '--database', config.database, '--world-size', '3'];
      await main([...init, '--username', 'alice'], environment);
      assert.ok(existsSync(adminTokenPath(config.database)));
      assert.ok(!existsSync(config.database), 'no SQLite world is created');
      await assert.rejects(main(init, environment), /already exists/);
      const store = await StateStore.open(config);
      try {
        assert.equal(store.revision, 1);
        const users = Object.values(store.load()?.world.users ?? {});
        assert.ok(users.some((user) => user.username === 'alice'));
      } finally {
        await store.close();
      }
    }));
});

void describe('database configuration', () => {
  void it('selects PostgreSQL by URL without exposing its credentials', () => {
    const url = 'postgresql://world:s3cret@db.example:5433/screeps';
    const config = createConfig(configFromEnvironment({ SCREEPS_DATABASE_URL: url }));
    assert.equal(config.databaseUrl, url);
    assert.equal(databaseLabel(config), 'PostgreSQL db.example:5433/screeps');
    assert.equal(databaseLabel(createConfig({ database: 'world.sqlite' })), 'world.sqlite');
    for (const invalid of ['', 'mysql://world:s3cret@db/screeps', 'not a url s3cret']) {
      assert.throws(
        () => createConfig({ databaseUrl: invalid }),
        (error: unknown) =>
          error instanceof Error &&
          /Invalid databaseUrl/.test(error.message) &&
          !error.message.includes('s3cret'),
      );
    }
  });
});
