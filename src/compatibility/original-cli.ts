/*
 * The original standalone server's administration CLI (backend `lib/cli`): a TCP line protocol in
 * which every line is JavaScript evaluated in a persistent per-connection `vm` context exposing
 * `print`, `help`, the original `storage` and the `map`, `bots`, `strongholds` and `system`
 * methods. Results are written as `< result`; promises print their resolved value or `Error: ...`.
 *
 * This is trusted operator code with full server authority, so it only listens when a CLI port is
 * configured, on loopback unless a host is given, never on an unauthenticated public default.
 * Commands run outside any kernel callback: every storage operation and every method below takes
 * its own serialized kernel read or mutation, as each original storage RPC did, so system control
 * (`system.pauseSimulation()` and friends) never waits on a lock held around the evaluation.
 * World-changing methods run as one atomic mutation each where upstream wrote piecemeal.
 */

import { EventEmitter } from 'node:events';
import { unlink } from 'node:fs/promises';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { inspect } from 'node:util';
import { createContext, runInContext } from 'node:vm';
import {
  closeRoom,
  expandStrongholdInRoom,
  generateRoom,
  loadBotModules,
  openRoom,
  reloadBot,
  removeBot,
  removeRoom,
  spawnBot,
  spawnStronghold,
  strongholdTemplates,
  type GenerateRoomOptions,
  type SpawnBotOptions,
  type SpawnStrongholdOptions,
} from '@openscreeps/game';
import type { ServerContext, ServerState } from '../contracts.ts';
import { writeRoomImageAssets } from '../assets.ts';
import { purgeAccountRecords } from '../api/users.ts';
import type { ServerKernel } from '../services/server-kernel.service.ts';
import { initialServerState } from '../storage.ts';
import {
  createOriginalStorage,
  type OriginalStorage,
  type OriginalUpdateResult,
} from './original-storage.ts';

/** Session output: `isResult` marks a command result, written after the `< ` prompt. */
export type OriginalCliOutput = (data: string, isResult?: boolean) => void;

/** The server the CLI administers: its context plus the kernel's world reset and cron entry. */
export type OriginalCliKernel = ServerContext & Pick<ServerKernel, 'importSnapshot' | 'runCronjob'>;

/** A CLI command with its `help()` page (upstream `utils.withHelp`). */
export type OriginalCliMethod<A extends unknown[], R> = ((...args: A) => R) & { _help: string };

/** Upstream `map`: room generation and availability. */
export interface OriginalCliMap {
  generateRoom: OriginalCliMethod<[roomName: string, opts?: GenerateRoomOptions], Promise<string>>;
  openRoom: OriginalCliMethod<
    [roomName: string, timestamp?: number],
    Promise<OriginalUpdateResult>
  >;
  closeRoom: OriginalCliMethod<[roomName: string], Promise<OriginalUpdateResult>>;
  removeRoom: OriginalCliMethod<[roomName: string], Promise<string>>;
  updateRoomImageAssets: OriginalCliMethod<[roomName: string], Promise<void>>;
  updateTerrainData: OriginalCliMethod<[], Promise<string>>;
  _help: string;
}

/** Upstream `bots`: NPC players running configured bot AI directories. */
export interface OriginalCliBots {
  spawn: OriginalCliMethod<
    [botAiName: string, roomName: string, opts?: SpawnBotOptions],
    Promise<string>
  >;
  reload: OriginalCliMethod<[botAiName: string], Promise<string>>;
  removeUser: OriginalCliMethod<[username: string], Promise<string>>;
  _help: string;
}

/** Upstream `strongholds`: NPC Strongholds. */
export interface OriginalCliStrongholds {
  spawn: OriginalCliMethod<[roomName: string, opts?: SpawnStrongholdOptions], Promise<void>>;
  expand: OriginalCliMethod<[roomName: string], Promise<string>>;
  _help: string;
}

/** Upstream `system`: world reset, messages, simulation control and cron jobs. */
export interface OriginalCliSystem {
  resetAllData: OriginalCliMethod<[], Promise<void>>;
  sendServerMessage: OriginalCliMethod<[message: unknown], Promise<void>>;
  pauseSimulation: OriginalCliMethod<[], Promise<string>>;
  resumeSimulation: OriginalCliMethod<[], Promise<string>>;
  runCronjob: OriginalCliMethod<[jobName: string], Promise<string>>;
  getTickDuration: OriginalCliMethod<[], Promise<number>>;
  setTickDuration: OriginalCliMethod<[minimalDuration: unknown], Promise<string>>;
  _help: string;
}

/** The global object of one CLI session; `cliSandbox` listeners may add their own commands. */
export interface OriginalCliSandbox {
  [name: string]: unknown;
  print: (...values: unknown[]) => void;
  help: (object?: unknown) => string;
  storage: OriginalStorage;
  map: OriginalCliMap;
  bots: OriginalCliBots;
  strongholds: OriginalCliStrongholds;
  system: OriginalCliSystem;
}

/** Events of `config.cli`. */
export interface OriginalCliEvents {
  cliSandbox: [sandbox: OriginalCliSandbox];
}

export interface OriginalCliOptions {
  /** Listen port; defaults to the configured `cliPort`. `0` picks a free port. */
  port?: number;
  /** Listen host; defaults to the configured `cliHost`, else loopback `127.0.0.1`. */
  host?: string;
  /** The mods' `config.cli`; a fresh default configuration when absent. */
  cli?: OriginalCliConfig;
  /** The original storage facade; created for the kernel when absent. */
  storage?: OriginalStorage;
  /** `config.common.bots`: bot AI name to script directory, read when a command runs. */
  bots?: Readonly<Record<string, string>>;
  /** World `system.resetAllData()` restores; defaults to the configured initial world. */
  initialState?: () => ServerState | Promise<ServerState>;
  /** Server version shown by the default greeting (`{build}`). */
  version?: string;
  /** Operator log, `console.log` by default. */
  log?: (line: string) => void;
}

export interface OriginalCliServer extends AsyncDisposable {
  readonly address: AddressInfo;
  /** Stops listening, ends every session and drops CLI subscriptions. Idempotent. */
  close(): Promise<void>;
}

/** What the default `config.cli` members use while the CLI they belong to runs. */
interface CliRuntime {
  readonly storage: OriginalStorage;
  readonly map: OriginalCliMap;
  readonly bots: OriginalCliBots;
  readonly strongholds: OriginalCliStrongholds;
  readonly system: OriginalCliSystem;
  readonly version: string | undefined;
  readonly log: (line: string) => void;
}

const running = new WeakMap<OriginalCliConfig, CliRuntime>();
const DEFAULT_GREETING =
  'Screeps server {build} running on port 21025.\r\nThis CLI interface contains a virtual JavaScript machine which you can use to invoke internal server commands. Any valid JavaScript code is allowed. Type "help()" to learn more about commands.\r\n';

/**
 * Original `config.cli`: mods replace `greeting`, `connectionListener` or `createSandbox` and
 * listen to `cliSandbox`. Create it before loading mods; the defaults bind to the CLI started with
 * it, so mods may also wrap them.
 */
export class OriginalCliConfig extends EventEmitter<OriginalCliEvents> {
  /** Session greeting; `{build} ` becomes `v<version> ` (or nothing). */
  greeting = DEFAULT_GREETING;

  /** Serves one TCP session (the original listener; `this` is the TCP server). */
  connectionListener: (socket: Socket) => void = (socket) => {
    serveConnection(this, socket);
  };

  /** Builds the global object of a session. Deprecated upstream in favor of `cliSandbox`. */
  createSandbox: (output: OriginalCliOutput) => OriginalCliSandbox = (output) =>
    defaultSandbox(this, output);
}

/** Set while `createRunner` builds a sandbox; other callers get the original deprecation note. */
let creatingSandbox = false;

function defaultSandbox(cli: OriginalCliConfig, output: OriginalCliOutput): OriginalCliSandbox {
  const runtime = running.get(cli);
  if (!runtime) throw new Error('The CLI server is not running');
  if (!creatingSandbox) {
    runtime.log(
      'config.cli.createSandbox is deprecated, please use config.cli.onCliSandbox instead',
    );
  }
  const sandbox: OriginalCliSandbox = {
    print(...values: unknown[]) {
      output(values.map((value) => inspect(value)).join(' '));
    },
    help: (object?: unknown) => help(sandbox, object),
    storage: runtime.storage,
    map: runtime.map,
    bots: runtime.bots,
    strongholds: runtime.strongholds,
    system: runtime.system,
  };
  cli.emit('cliSandbox', sandbox);
  return sandbox;
}

const HELP =
  'The supported commands are:\r\n' +
  '    * help() - Print this help text.\r\n' +
  '    * print(value) - Print a value to the console.\r\n' +
  '    * storage - A global database storage object.\r\n' +
  '    * map - Map editing functions.\r\n' +
  '    * bots - Manage NPC bot players and their AI scripts.\r\n' +
  '    * strongholds - Manage NPC Strongholds\r\n' +
  '    * system - System utility functions.\r\n' +
  'Type help(object) to learn more about specific usage of the object.';

function listing(object: unknown): string {
  return typeof object === 'object' && object !== null
    ? Object.keys(object)
        .map((key) => ` - ${key}`)
        .join('\r\n')
    : '';
}

/** Original `help(object)`; storage pages list the live collections and keys. */
function help(sandbox: OriginalCliSandbox, object: unknown): string {
  const { storage } = sandbox;
  if (object === undefined) return HELP;
  if (object === storage) {
    return (
      'This is the main storage object that allows to perform direct operations on the game database. It contains 3 sub-objects:\r\n' +
      '    * db - An object containing all database collections in it. Use it to fetch or modify game objects. The database is based on LokiJS project, so you can learn more about available functionality in its documentation.\n' +
      '    * env - A simple key-value storage with an interface based on Redis syntax.\r\n' +
      '    * pubsub - A Pub/Sub mechanism allowing to publish events across all processes.'
    );
  }
  if (object === storage.db) {
    return (
      `Database collections: \r\n${listing(storage.db)}\r\n` +
      `Available methods: \r\n${listing(storage.db.users)}\r\n` +
      "Example: storage.db.users.findOne({username: 'User1'}).then(print);"
    );
  }
  if (object === storage.env) {
    return (
      `Keys ('storage.env.keys' object): \r\n${listing(storage.env.keys)}\r    \n` +
      'Available methods:\r\n - get\r\n - mget\r\n - set\r\n - setex\r\n - expire\r\n - ttl\r\n - del\r\n - hmset\r\n' +
      'Example: storage.env.get(storage.env.keys.GAMETIME).then(print);'
    );
  }
  if (object === storage.pubsub) {
    return (
      `Keys ('storage.pubsub.keys' object): \r\n${listing(storage.pubsub.keys)}\r    \n` +
      'Available methods:\r\n - publish\r\n - subscribe\r\n' +
      'Example: storage.pubsub.subscribe(storage.pubsub.keys.ROOMS_DONE, (gameTime) => print(gameTime));'
    );
  }
  const page: unknown = Reflect.get(Object(object) as object, '_help');
  const text = String(page);
  return page ? text : 'There is no help page for this object.';
}

/** Original `sandbox.create`: a persistent context evaluating one command per call. */
function createRunner(
  cli: OriginalCliConfig,
  output: OriginalCliOutput,
): (command: string) => void {
  creatingSandbox = true;
  let sandbox: OriginalCliSandbox;
  try {
    sandbox = cli.createSandbox(output);
  } finally {
    creatingSandbox = false;
  }
  const context = createContext(sandbox);
  return (command) => {
    try {
      const result: unknown = runInContext(command, context);
      const then: unknown = result ? Reflect.get(Object(result) as object, 'then') : undefined;
      if (then) {
        Reflect.apply(then as (...args: unknown[]) => unknown, result, [
          (data: unknown) => {
            if (data) output(inspect(data), true);
          },
          (error: unknown) => {
            output(`Error: ${errorText(error)}`, true);
          },
        ]);
      } else {
        output(String(result), true);
      }
    } catch (error) {
      output(String(error), true);
    }
  };
}

/** Upstream `err.stack || err`. */
function errorText(error: unknown): string {
  const stack: unknown =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'stack') : undefined;
  return String(stack || error);
}

/** Original `config.cli.connectionListener`. */
function serveConnection(cli: OriginalCliConfig, socket: Socket): void {
  const runtime = running.get(cli);
  if (!runtime) {
    socket.destroy();
    return;
  }
  const connection = `${String(socket.remoteAddress)}:${String(socket.remotePort)}`;
  runtime.log(`[${connection}] Incoming CLI connection`);
  socket.on('error', () => {
    runtime.log(`[${connection}] CLI connection reset`);
  });
  socket.on('end', () => {
    runtime.log(`[${connection}] CLI connection closed`);
  });
  const write = (text: string): void => {
    // Late results and subscription output of a closed session are dropped.
    if (socket.writable) socket.write(text, 'utf8');
  };
  const run = createRunner(cli, (data, isResult) => {
    if (data === 'undefined') {
      if (isResult) write('< ');
      return;
    }
    write(`${isResult ? '< ' : ''}${data}\r\n`);
  });
  const build = runtime.version === undefined ? '' : `v${runtime.version} `;
  write(`${cli.greeting.replace('{build} ', build)}< \r\n`);
  createInterface({ input: socket, output: socket }).on('line', (line) => {
    run(line);
  });
}

/** Upstream CLI methods reject expected failures with plain strings, not `Error`s. */
function rejection(message: string): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- original wire format
  return Promise.reject(message);
}

/** Game operations throw upstream's string rejections as plain `Error`s; restore the strings. */
function upstream<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof Error && Object.getPrototypeOf(error) === Error.prototype) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- original wire format
      throw error.message;
    }
    throw error;
  }
}

function withHelp<A extends unknown[], R>(
  text: string,
  method: (...args: A) => R,
): OriginalCliMethod<A, R> {
  return Object.assign(method, { _help: text });
}

/** Upstream `utils.generateCliHelp`. */
function generateCliHelp(prefix: string, container: object): string {
  const lines = Object.keys(container).flatMap((name) => {
    const value: unknown = Reflect.get(container, name);
    if (typeof value !== 'function') return [];
    const text: unknown = Reflect.get(value, '_help');
    const description = String(text);
    return [` - ${prefix}${text ? description : name}`];
  });
  return `Available methods:\r\n${lines.join('\r\n')}`;
}

function createMap(kernel: OriginalCliKernel): OriginalCliMap {
  const map: OriginalCliMap = {
    generateRoom: withHelp(
      `generateRoom(roomName, [opts]) - Generate a new room at the specified location. 'opts' is an object with the following optional properties:\r
    * exits - an object with exit coordinates arrays, e.g. {top: [20,21,23], right: [], bottom: [27,28,29,40,41]}, default is random\r
    * terrainType - the type of generated landscape, a number from 1 to 28, default is random\r
    * swampType - the type of generated swamp configuration, a number from 0 to 14, default is random\r
    * sources - the amount of sources in the room, default is random from 1 to 2\r
    * mineral - the type of the mineral deposit in this room or false if no mineral, default is random type\r
    * controller - whether this room should have the controller, default is true\r
    * keeperLairs - whether this room should have source keeper lairs, default is false`,
      async (roomName: string, opts?: GenerateRoomOptions): Promise<string> => {
        if (!/^[WE]\d+[NS]\d+$/.test(roomName)) return rejection('Invalid room name');
        await kernel.mutate(() => {
          upstream(() => {
            generateRoom(kernel.state.world, roomName, opts ?? {});
          });
          kernel.terrainChanged();
        });
        await map.updateRoomImageAssets(roomName);
        await map.updateTerrainData();
        return 'OK';
      },
    ),
    openRoom: withHelp(
      'openRoom(roomName, [timestamp]) - Make a room available for use. Specify a timestamp in the future if you want it to be opened later automatically.',
      (roomName: string, timestamp?: number): Promise<OriginalUpdateResult> =>
        kernel.mutate(() => {
          if (!Object.hasOwn(kernel.state.world.rooms, roomName)) return {};
          upstream(() => {
            openRoom(kernel.state.world, roomName, timestamp || undefined);
          });
          kernel.terrainChanged();
          return { modified: 1 };
        }),
    ),
    closeRoom: withHelp(
      'closeRoom(roomName) - Make a room not available.',
      (roomName: string): Promise<OriginalUpdateResult> =>
        kernel.mutate(() => {
          const { rooms } = kernel.state.world;
          if (!Object.hasOwn(rooms, roomName) || rooms[roomName]?.status !== 'normal') return {};
          upstream(() => {
            closeRoom(kernel.state.world, roomName);
          });
          kernel.terrainChanged();
          return { modified: 1 };
        }),
    ),
    removeRoom: withHelp(
      'removeRoom(roomName) - Delete the room and all room objects from the database.',
      async (roomName: string): Promise<string> => {
        await kernel.mutate(() => {
          upstream(() => {
            removeRoom(kernel.state, roomName);
          });
          kernel.terrainChanged();
        });
        await map.updateTerrainData();
        // The room existed, so its name is a valid room name, never a path.
        const directory = kernel.config.assetDirectory;
        if (directory !== undefined) {
          await unlink(join(directory, 'map', `${roomName}.png`)).catch((error: unknown) => {
            // Images are rendered on demand, so a room never needs a file to exist.
            if (Reflect.get(Object(error) as object, 'code') !== 'ENOENT') throw error;
          });
        }
        return 'OK';
      },
    ),
    updateRoomImageAssets: withHelp(
      'updateRoomImageAssets(roomName) - Update images in assets folder for the specified room.',
      async (roomName: string): Promise<void> => {
        const terrain = await kernel.read(() => ({ ...kernel.state.world.terrain }));
        if (!Object.hasOwn(terrain, roomName)) throw new Error(`Room ${roomName} has no terrain`);
        // `/assets/map` images are rendered from the committed terrain on request; an operator
        // asset directory also gets upstream's files.
        const directory = kernel.config.assetDirectory;
        if (directory !== undefined) await writeRoomImageAssets(directory, terrain, roomName);
      },
    ),
    updateTerrainData: withHelp(
      'updateTerrainData() - Update cached world terrain data.',
      async (): Promise<string> => {
        await kernel.mutate(() => {
          kernel.terrainChanged();
        });
        return 'OK';
      },
    ),
    _help: '',
  };
  map._help = generateCliHelp('map.', map);
  return map;
}

function botDirectory(bots: Readonly<Record<string, string>>, name: string): string {
  const directory = Object.hasOwn(bots, name) ? bots[name] : undefined;
  if (!directory) throw new Error(`Bot AI with the name "${name}" doesn't exist`);
  return directory;
}

/**
 * Upstream `utils.reloadBotUsers`: every player running a configured bot AI gets its current
 * scripts. The original backend also runs this for every configured bot AI at startup.
 */
export async function reloadBotUsers(
  kernel: ServerContext,
  bots: Readonly<Record<string, string>>,
  name: string,
): Promise<string> {
  const found = await kernel.read(() =>
    Object.values(kernel.state.world.users).some((user) => user.bot === name),
  );
  if (!found) return 'No bot players found';
  const modules = loadBotModules(botDirectory(bots, name));
  const usernames = await kernel.mutate(() => reloadBot(kernel, name, modules));
  return usernames.length
    ? `Reloaded scripts for users: ${usernames.join(', ')}`
    : 'No bot players found';
}

function createBots(
  kernel: OriginalCliKernel,
  bots: Readonly<Record<string, string>>,
): OriginalCliBots {
  const methods: OriginalCliBots = {
    spawn: withHelp(
      `spawn(botAiName, roomName, [opts]) - Create a new NPC player with bot AI scripts, and spawn it to the specified room. 'opts' is an object with the following optional properties:\r
    * username - the name of a bot player, default is randomly generated\r
    * cpu - the CPU limit of a bot user, default is 100\r
    * gcl - the Global Control Level of a bot user, default is 1\r
    * x - the X position of the spawn in the room, default is random\r
    * y - the Y position of the spawn in the room, default is random`,
      async (botAiName: string, roomName: string, opts?: SpawnBotOptions): Promise<string> => {
        const modules = loadBotModules(botDirectory(bots, botAiName));
        const { username } = await kernel.mutate(() =>
          upstream(() => spawnBot(kernel, botAiName, modules, roomName, opts ?? {})),
        );
        return `User ${username} with bot AI "${botAiName}" spawned in ${roomName}`;
      },
    ),
    reload: withHelp(
      'reload(botAiName) - Reload scripts for the specified bot AI.',
      (botAiName: string): Promise<string> => reloadBotUsers(kernel, bots, botAiName),
    ),
    removeUser: withHelp(
      'removeUser(username) - Delete the specified bot player and all its game objects.',
      async (username: string): Promise<string> => {
        await kernel.mutate(() => {
          const userId = upstream(() => removeBot(kernel, username));
          purgeAccountRecords(kernel.state, userId);
          kernel.publish('auth:revoked', { user: userId });
        });
        return 'User removed successfully';
      },
    ),
    _help: '',
  };
  methods._help =
    `${generateCliHelp('bots.', methods)}\r\nBot AIs:\r\n` +
    Object.keys(bots)
      .map((name) => ` - ${name} [${String(bots[name])}]`)
      .join('\r\n');
  return methods;
}

function createStrongholds(kernel: OriginalCliKernel): OriginalCliStrongholds {
  const methods: OriginalCliStrongholds = {
    spawn: withHelp(
      `spawn(roomName, [opts]) - Create a new NPC Stronghold, and spawn it to the specified room. 'opts' is an object with the following optional properties:\r
    * templateName - the name of stronghold template to spawn, default is random\r
    * x - the X position of the spawn in the room, default is random\r
    * y - the Y position of the spawn in the room, default is random\r
    * user - id of user which stronghold structures should belong to, default is "2" (Invader)\r
    * deployTime - delay in ticks until the stronghold is deployed`,
      async (roomName: string, opts: SpawnStrongholdOptions = {}): Promise<void> => {
        await kernel.mutate(() => {
          upstream(() => {
            spawnStronghold(kernel.state.world, roomName, opts);
          });
        });
      },
    ),
    expand: withHelp(
      'expand(roomName) - Force an NPC Stronghold to spawn a new lesser Invader Core in a nearby room.',
      async (roomName: string): Promise<string> => {
        await kernel.mutate(() => {
          upstream(() => {
            expandStrongholdInRoom(kernel.state.world, roomName, kernel.now());
          });
        });
        return 'OK';
      },
    ),
    _help: '',
  };
  methods._help =
    `${generateCliHelp('strongholds.', methods)}\r\nStronghold templates:\r\n` +
    strongholdTemplates()
      .map((template) => ` - ${template.name} [${template.description}]`)
      .join('\r\n');
  return methods;
}

function createSystem(
  kernel: OriginalCliKernel,
  resetAllData: () => Promise<void>,
): OriginalCliSystem {
  const methods: OriginalCliSystem = {
    resetAllData: withHelp(
      'resetAllData() - Wipe all world data and reset the database to the default state.',
      resetAllData,
    ),
    sendServerMessage: withHelp(
      'sendServerMessage(message) - Send a text server message to all currently connected players.',
      async (message: unknown): Promise<void> => {
        await kernel.mutate(() => {
          kernel.publish('serverMessage', message);
        });
      },
    ),
    pauseSimulation: withHelp(
      'pauseSimulation() - Stop main simulation loop execution.',
      async (): Promise<string> => {
        await kernel.setPaused(true);
        return 'OK';
      },
    ),
    resumeSimulation: withHelp(
      'resumeSimulation() - Resume main simulation loop execution.',
      async (): Promise<string> => {
        await kernel.setPaused(false);
        return 'OK';
      },
    ),
    runCronjob: withHelp(
      'runCronjob(jobName) - Run a cron job immediately.',
      async (jobName: string): Promise<string> => {
        try {
          await kernel.runCronjob(jobName);
        } catch (error) {
          const missing = `Cronjob "${jobName}" not found`;
          if (error instanceof Error && error.message === missing) return rejection(missing);
          throw error;
        }
        return 'OK';
      },
    ),
    getTickDuration: withHelp(
      'getTickDuration() - Show current minimal tick duration (in milliseconds).',
      (): Promise<number> => kernel.read(() => kernel.state.tickDuration),
    ),
    setTickDuration: withHelp(
      'setTickDuration(minimalDuration) - Set current minimal tick duration (in milliseconds).',
      async (minimalDuration: unknown): Promise<string> => {
        // Upstream `parseInt(minimalDuration)`, radix detection included.
        const value = Number.parseInt(String(minimalDuration));
        if (Number.isNaN(value) || !value) {
          return rejection(
            `Invalid minimal duration ${String(minimalDuration)}, integer expected.`,
          );
        }
        await kernel.setTickDuration(value);
        return 'OK';
      },
    ),
    _help: '',
  };
  methods._help = generateCliHelp('system.', methods);
  return methods;
}

type Subscribe = OriginalStorage['pubsub']['subscribe'];

/** The storage as sessions see it: subscriptions made through the CLI end when it closes. */
function sessionStorage(storage: OriginalStorage, subscriptions: Set<() => void>): OriginalStorage {
  const subscribe = (...args: Parameters<Subscribe>): ReturnType<Subscribe> => {
    const unsubscribe = storage.pubsub.subscribe(...args);
    subscriptions.add(unsubscribe);
    return () => {
      subscriptions.delete(unsubscribe);
      unsubscribe();
    };
  };
  const pubsub = new Proxy(storage.pubsub, {
    get: (target, key): unknown => (key === 'subscribe' ? subscribe : Reflect.get(target, key)),
  });
  return new Proxy(storage, {
    get: (target, key): unknown => (key === 'pubsub' ? pubsub : Reflect.get(target, key)),
  });
}

/**
 * Start the original CLI server. Call outside any kernel callback; commands run as trusted
 * operator JavaScript, so expose the port only to administrators.
 */
export async function startOriginalCli(
  kernel: OriginalCliKernel,
  options: OriginalCliOptions = {},
): Promise<OriginalCliServer> {
  const port = options.port ?? kernel.config.cliPort;
  if (port === undefined) throw new Error('The CLI port is not configured');
  const host = options.host ?? kernel.config.cliHost ?? '127.0.0.1';
  const cli = options.cli ?? new OriginalCliConfig();
  if (running.has(cli)) throw new Error('A CLI server already runs with this configuration');
  const log =
    options.log ??
    ((line: string) => {
      console.log(line);
    });
  const resetAllData = async (): Promise<void> => {
    const state = await (options.initialState?.() ?? initialServerState(kernel.config));
    await kernel.importSnapshot(state);
  };
  const subscriptions = new Set<() => void>();
  const storage = sessionStorage(
    options.storage ?? createOriginalStorage(kernel, { resetAllData }),
    subscriptions,
  );
  const runtime: CliRuntime = {
    storage,
    map: createMap(kernel),
    bots: createBots(kernel, options.bots ?? {}),
    strongholds: createStrongholds(kernel),
    system: createSystem(kernel, resetAllData),
    version: options.version,
    log,
  };

  log('Starting CLI server');
  const server = createServer(cli.connectionListener);
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  running.set(cli, runtime);
  const listening: PromiseWithResolvers<void> = Promise.withResolvers();
  server.once('error', listening.reject);
  server.listen(port, host, () => {
    server.off('error', listening.reject);
    listening.resolve();
  });
  try {
    await listening.promise;
  } catch (error) {
    running.delete(cli);
    throw error;
  }
  server.on('error', (error) => {
    log(`CLI server error: ${errorText(error)}`);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listen address');
  log(`CLI listening on ${host}:${String(address.port)}`);

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    const closed: PromiseWithResolvers<void> = Promise.withResolvers();
    closing = closed.promise;
    if (running.get(cli) === runtime) running.delete(cli);
    for (const unsubscribe of subscriptions) unsubscribe();
    subscriptions.clear();
    server.close((error) => {
      if (error) closed.reject(error);
      else closed.resolve();
    });
    for (const socket of sockets) socket.destroy();
    return closing;
  };
  return { address, close, [Symbol.asyncDispose]: close };
}
