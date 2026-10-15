import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Router, type Router as ExpressRouter } from 'express';
import {
  createConstants,
  isRecord,
  MAINTENANCE_JOBS,
  runJob,
  strongholds,
  utils,
  type BotRuntimeOptions,
  type Constants,
  type CustomObjectPrototypeConfig,
  type JsonObject,
  type NotificationBatch,
  type SimulationHooks,
} from '@openscreeps/game';
import type { ServerConfig, ServerContext, TickEvent } from '../contracts.ts';
import type { OperationResult } from '../api/operations.ts';
import { historyTicks } from '../realtime/diff.ts';
import { OriginalModuleLoader } from './commonjs.ts';
import { OriginalCliConfig } from './original-cli.ts';
import { createOriginalStorage, type OriginalStorage } from './original-storage.ts';
import type { Cronjobs } from '../services/server-kernel.service.ts';
import { originalBuiltinSocketModules, type BuiltinSocketModule } from './original-sockets.ts';

export interface OriginalSocketConnection {
  readonly readyState: number;
  write(message: string): unknown;
  close(): unknown;
  _writeEvent(channel: string, data: unknown): void;
  _writeEventRaw(message: string): void;
  subscribeBuiltin(module: BuiltinSocketModule, channel: string): Promise<void>;
  unsubscribeBuiltin(channel: string): void;
}
export interface OriginalSocketModule {
  onSubscribe(
    channel: string,
    user: JsonObject | null,
    connection: OriginalSocketConnection,
  ): unknown;
  onUnsubscribe?(
    channel: string,
    user: JsonObject | null,
    connection: OriginalSocketConnection,
  ): unknown;
}
export type OriginalSocketFactory = (
  listen: (pattern: RegExp, listener: (data: unknown, match: RegExpExecArray) => void) => void,
  emit: (channel: string, data: unknown) => void,
) => OriginalSocketModule;

export class OriginalBackendConfig extends EventEmitter {
  welcomeText: string;
  readonly router: ExpressRouter = Router();
  customObjectTypes: Record<string, unknown> = {};
  customIntentTypes: NonNullable<BotRuntimeOptions['customIntentTypes']> = {};
  renderer: { resources: Record<string, string>; metadata: Record<string, unknown> } = {
    resources: {},
    metadata: {},
  };
  socketModules: Record<string, OriginalSocketFactory> = originalBuiltinSocketModules();
  historyChunkSize: number;
  socketUpdateThrottle: number;
  onGetRoomHistory?: (
    room: string,
    base: number,
    callback: (error: unknown, data?: OperationResult<'platformRoomHistory'>) => void,
  ) => void;

  constructor(config: ServerConfig) {
    super();
    this.welcomeText = config.welcomeText;
    this.historyChunkSize = config.historyChunkSize;
    this.socketUpdateThrottle = config.socketUpdateThrottle;
  }
}

export class OriginalEngineConfig extends EventEmitter {
  mainLoopMinDuration: number;
  mainLoopResetInterval = 5000;
  cpuMaxPerTick = 500;
  cpuBucketSize = 10000;
  historyChunkSize: number;
  customIntentTypes: NonNullable<BotRuntimeOptions['customIntentTypes']> = {};
  readonly customObjectPrototypes: CustomObjectPrototypeConfig[] = [];
  readonly driver: {
    getAllUsers: () => PromiseLike<Array<JsonObject & { _id: string }>>;
    [name: string]: unknown;
  };
  mainLoopCustomStage: () => unknown = () => undefined;
  getNextTickDelay?: (usedTime: number) => number;

  constructor(config: ServerConfig, driver: OriginalEngineConfig['driver']) {
    super();
    this.mainLoopMinDuration = config.tickDuration;
    this.historyChunkSize = config.historyChunkSize;
    this.driver = driver;
  }

  registerCustomObjectPrototype(
    objectType: string,
    name: string,
    opts: CustomObjectPrototypeConfig['opts'] = {},
  ): void {
    if (!objectType) throw new Error('No object type provided!');
    if (!name) throw new Error('No prototype name provided!');
    this.customObjectPrototypes.push({ objectType, name, opts });
  }
}

type OriginalCronjob = [
  interval: number,
  run: (context: { utils: Record<string, unknown> }) => unknown,
  lastRun?: number,
];

/** One world's original config/common singletons; never shared across embedded servers. */
export class OriginalMods {
  readonly backend: OriginalBackendConfig;
  readonly engine: OriginalEngineConfig;
  readonly cli = new OriginalCliConfig();
  readonly common: {
    constants: Constants;
    strongholds: typeof strongholds;
    system: typeof utils;
    bots: Record<string, string>;
    dbCollections: string[];
    storage?: OriginalStorage;
  };
  readonly cronjobs: Record<string, OriginalCronjob> = {};
  readonly storage: OriginalStorage;
  readonly #config: ServerConfig;
  readonly #processType: 'server' | 'runner' | 'processor';
  #context: ServerContext | undefined;

  constructor(
    config: ServerConfig,
    processType: 'server' | 'runner' | 'processor' = 'server',
    storage?: OriginalStorage,
    resetAllData?: () => Promise<void>,
  ) {
    this.#config = config;
    this.#processType = processType;
    this.backend = new OriginalBackendConfig(config);
    this.common = {
      constants: createConstants(),
      strongholds,
      system: utils,
      bots: {},
      dbCollections: [
        'leaderboard.power',
        'leaderboard.seasons',
        'leaderboard.world',
        'users.intents',
        'market.orders',
        'market.stats',
        'rooms',
        'rooms.objects',
        'rooms.flags',
        'rooms.intents',
        'rooms.terrain',
        'transactions',
        'users',
        'users.code',
        'users.console',
        'users.messages',
        'users.money',
        'users.notifications',
        'users.resources',
        'users.power_creeps',
      ],
    };
    const lazy = new Proxy({} as ServerContext, {
      get: (_target, property: string | symbol): unknown => {
        const context = this.context;
        const value: unknown = Reflect.get(context, property, context);
        return typeof value === 'function' ? value.bind(context) : value;
      },
    });
    this.storage =
      storage ??
      createOriginalStorage(lazy, {
        collections: this.common.dbCollections,
        ...(resetAllData === undefined ? {} : { resetAllData }),
      });
    this.common.storage = this.storage;
    const driver: OriginalEngineConfig['driver'] = {
      getAllUsers: () =>
        this.#collection('users')
          .find({ $and: [{ active: { $ne: 0 } }, { cpu: { $gt: 0 } }] })
          .then((users) =>
            users
              .filter((user): user is JsonObject & { _id: string } => typeof user._id === 'string')
              .sort((a, b) => Number(b.lastUsedDirtyTime ?? 0) - Number(a.lastUsedDirtyTime ?? 0)),
          ),
      constants: this.common.constants,
      strongholds: this.common.strongholds,
      system: this.common.system,
      getGameTime: () => this.storage.env.get(this.storage.env.keys.GAMETIME).then(Number),
      activateRoom: (room: string) =>
        this.storage.env.sadd(this.storage.env.keys.ACTIVE_ROOMS, room),
      getRoomInfo: (room: string) => this.#collection('rooms').findOne({ _id: room }),
      getRoomIntents: (room: string) => this.#collection('rooms.intents').findOne({ room }),
      getRoomFlags: (room: string) => this.#collection('rooms.flags').find({ room }),
      getAllTerrainData: () => this.#collection('rooms.terrain').find(),
      getWorldSize: () => utils.calcWorldSize(Object.values(this.context.state.world.rooms)),
      bufferFromBase64: (text: string) => Buffer.from(text, 'base64'),
    };
    this.engine = new OriginalEngineConfig(config, driver);
    driver.config = this.engine;
    driver.customObjectPrototypes = this.engine.customObjectPrototypes;
    for (const [name, job] of Object.entries(MAINTENANCE_JOBS)) {
      this.cronjobs[name] = [
        job.interval,
        () => {
          const context = this.context;
          const notifications = runJob(context.state, name, context.now(), {
            notificationRecipient: (userId) => {
              const profile = context.state.profiles[userId];
              return profile
                ? {
                    ...(profile.email === undefined ? {} : { email: profile.email }),
                    ...(profile.notifyPrefs === undefined
                      ? {}
                      : { preferences: profile.notifyPrefs }),
                  }
                : undefined;
            },
          });
          context.state.notificationOutbox.push(...notifications);
        },
      ];
    }
    this.load();
  }

  load(): void {
    const config = this.#config;
    const driver = this.engine.driver;
    const modConfig =
      this.#processType === 'server' ? this : { common: this.common, engine: this.engine };
    if (config.modFile) {
      const filename = resolve(config.modFile);
      const manifest: unknown = JSON.parse(readFileSync(filename, 'utf8'));
      if (!isRecord(manifest) || (manifest.mods !== undefined && !Array.isArray(manifest.mods))) {
        throw new Error(`Invalid original mod manifest: ${filename}`);
      }
      const moduleCommon = {
        ...utils,
        configManager: {
          config: modConfig,
          load: () => {
            this.load();
          },
        },
        storage: this.storage,
        getGametime: driver.getGameTime,
        getRoomNameFromXY: utils.getRoomNameFromXY,
      };
      const loader = new OriginalModuleLoader({
        '@screeps/common': moduleCommon,
        '@screeps/driver': driver,
      });
      for (const entry of (manifest.mods ?? []) as unknown[]) {
        if (typeof entry !== 'string') throw new Error(`Invalid mod path in ${filename}`);
        const modPath = resolve(dirname(filename), entry);
        const mod = loader.load(modPath);
        if (typeof mod !== 'function') throw new Error(`Mod must export a function: ${modPath}`);
        const result: unknown = (mod as (config: typeof modConfig) => unknown)(modConfig);
        if (result && typeof Reflect.get(Object(result), 'then') === 'function') {
          throw new Error(`Original mods initialize synchronously: ${modPath}`);
        }
      }
      if (manifest.bots !== undefined) {
        if (!isRecord(manifest.bots)) throw new Error(`Invalid bots in ${filename}`);
        for (const [name, path] of Object.entries(manifest.bots)) {
          if (typeof path !== 'string') throw new Error(`Invalid bot path: ${name}`);
          Object.defineProperty(this.common.bots, name, {
            value: resolve(dirname(filename), path),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
    }
    config.welcomeText = this.backend.welcomeText;
    config.historyChunkSize = this.backend.historyChunkSize;
    config.socketUpdateThrottle = this.backend.socketUpdateThrottle;
    config.tickDuration = this.engine.mainLoopMinDuration;
  }

  get context(): ServerContext {
    if (!this.#context)
      throw new Error('Original storage is unavailable until the world is initialized');
    return this.#context;
  }

  async bind(context: ServerContext): Promise<void> {
    if (this.#context) throw new Error('Original mods are already bound to a world');
    this.#context = context;
    await this.storage._connect();
    context.events.on('tick', this.#onTick);
    this.engine.emit('init', 'main');
  }

  get runtimeOptions(): BotRuntimeOptions {
    return {
      cpuMaxPerTick: this.engine.cpuMaxPerTick,
      cpuBucketSize: this.engine.cpuBucketSize,
      hardTimeoutMs: Math.max(5000, this.engine.mainLoopResetInterval),
      customObjectPrototypes: this.engine.customObjectPrototypes,
      customIntentTypes: this.engine.customIntentTypes,
      getAllUsers: async () => (await this.engine.driver.getAllUsers()).map((user) => user._id),
      playerSandbox: (sandbox, userId) => {
        this.engine.emit('playerSandbox', sandbox, userId);
      },
    };
  }

  get simulationHooks(): SimulationHooks {
    return {
      processObject: (object, scope) => {
        this.engine.emit(
          'processObject',
          object,
          scope.roomObjects,
          scope.roomTerrain,
          scope.gameTime,
          scope.roomInfo,
          scope.bulk,
          scope.bulkUsers,
        );
      },
      preProcessObjectIntents: (object, userId, intents, scope) => {
        this.engine.emit(
          'preProcessObjectIntents',
          object,
          userId,
          intents,
          scope.roomObjects,
          scope.roomTerrain,
          scope.gameTime,
          scope.roomInfo,
          scope.bulk,
          scope.bulkUsers,
        );
      },
      processObjectIntents: (object, userId, intents, scope) => {
        this.engine.emit(
          'processObjectIntents',
          object,
          userId,
          intents,
          scope.roomObjects,
          scope.roomTerrain,
          scope.gameTime,
          scope.roomInfo,
          scope.bulk,
          scope.bulkUsers,
        );
      },
      postProcessObject: (object, scope, mapView) => {
        this.engine.emit(
          'postProcessObject',
          object,
          scope.roomObjects,
          scope.roomTerrain,
          scope.gameTime,
          scope.roomInfo,
          scope.bulk,
          scope.bulkUsers,
          scope.eventLog,
          mapView,
        );
      },
      processRoom: (scope) => {
        this.engine.emit(
          'processRoom',
          scope.roomName,
          scope.roomInfo,
          scope.roomObjects,
          scope.roomTerrain,
          scope.gameTime,
          scope.bulk,
          scope.bulkUsers,
          scope.eventLog,
        );
      },
      strongholdDestroyed: (object, scope) => {
        this.engine.emit('strongholdDestroyed', object, scope);
      },
    };
  }

  #collection(name: string) {
    const collection = this.storage.db[name];
    if (!collection) throw new Error(`Original collection ${name} is not available`);
    return collection;
  }

  /** Getters preserve late additions, deletions and interval changes made by trusted mods. */
  cronjobRegistry(): Cronjobs {
    return new Proxy(
      {},
      {
        ownKeys: () => Object.keys(this.cronjobs),
        getOwnPropertyDescriptor: (_target, name) =>
          Object.hasOwn(this.cronjobs, name) ? { configurable: true, enumerable: true } : undefined,
        get: (_target, name: string | symbol): unknown => {
          if (typeof name !== 'string' || !Object.hasOwn(this.cronjobs, name)) return undefined;
          const entry = this.cronjobs[name];
          if (!entry) return undefined;
          return {
            interval: entry[0],
            run: async (now: number) => {
              entry[2] = now;
              await entry[1]({ utils });
            },
          };
        },
      },
    );
  }

  async deliverNotifications(notification: NotificationBatch): Promise<void> {
    const user = await this.#collection('users').findOne({ _id: notification.userId });
    if (!user) return;
    const messages = notification.notifications;
    for (const listener of this.backend.listeners('sendUserNotifications')) {
      await Reflect.apply(listener, this.backend, [user, messages]);
    }
    await this.#config.deliverNotifications?.(notification);
  }

  readonly #onTick = (event: TickEvent): void => {
    if (!this.engine.listenerCount('saveRoomHistory')) return;
    const size = this.engine.historyChunkSize;
    const time = event.simulation.gameTime;
    if (time % size !== size - 1) return;
    const base = time - size + 1;
    for (const [room, frames] of Object.entries(this.context.state.history)) {
      const chunk = frames.filter((frame) => frame.time >= base && frame.time <= time);
      if (chunk[0]?.time !== base) continue;
      this.engine.emit('saveRoomHistory', room, base, {
        timestamp: this.context.now(),
        room,
        base,
        ticks: historyTicks(chunk),
      });
    }
  };

  close(): void {
    this.#context?.events.off('tick', this.#onTick);
    this.backend.removeAllListeners();
    this.engine.removeAllListeners();
    this.cli.removeAllListeners();
  }
}
