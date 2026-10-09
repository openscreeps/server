import { EventEmitter } from 'node:events';
import { BotRuntime, Simulation, type StoredUserIntents } from '@openscreeps/engine';
import type {
  ServerConfig,
  ServerContext,
  ServerEvents,
  ServerState,
  StatisticsSample,
  TickEvent,
} from './contracts.ts';
import { decodeState, StateStore } from './storage.ts';
import { createWorld, runMaintenance } from './world/index.ts';
import { recordLeaderboard } from './api/leaderboard.ts';

export class ServerKernel implements ServerContext, AsyncDisposable {
  readonly config: ServerConfig;
  readonly events = new EventEmitter<ServerEvents>();
  readonly #store: StateStore;
  readonly #now: () => number;
  #state: ServerState;
  #runtime: BotRuntime;
  #simulation: Simulation;
  #queue: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;
  #closing = false;
  #closed = false;
  #started = false;
  #fault: Error | undefined;
  #terrainDirty = false;
  #publications: Array<() => void> | undefined;
  #delivery: Promise<void> | undefined;

  constructor(config: ServerConfig, options: { state?: ServerState; now?: () => number } = {}) {
    this.config = config;
    this.#now = options.now ?? Date.now;
    this.#store = new StateStore(config.database);
    this.events.on('error', (error) => {
      console.error(error);
    });
    try {
      const saved = this.#store.load();
      if (saved && options.state)
        throw new Error('Cannot replace an existing database with initial state');
      const initial = options.state ? structuredClone(options.state) : saved;
      this.#runtime = new BotRuntime(
        initial ? { snapshot: initial.runtime, now: this.#now } : { now: this.#now },
      );
      this.#state = initial ?? {
        version: 1,
        world: createWorld({
          size: config.worldSize,
          seed: config.seed,
          shardName: config.shardName,
        }),
        runtime: this.#runtime.snapshot(),
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
        paused: config.paused,
        tickDuration: config.tickDuration,
      };
      this.#simulation = this.#createSimulation();
      this.#store.save(this.#state);
    } catch (error) {
      this.#store.close();
      throw error;
    }
  }

  get state(): ServerState {
    return this.#state;
  }
  get runtime(): BotRuntime {
    return this.#runtime;
  }
  get healthy(): boolean {
    return !this.#fault && !this.#closing;
  }
  now(): number {
    return this.#now();
  }

  #createSimulation(state = this.#state): Simulation {
    return new Simulation(state.world, {
      stateOwnership: 'shared',
      now: this.#now,
      recordHistory: this.config.historyTicks > 0,
    });
  }

  #enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.#closing || this.#closed) return Promise.reject(new Error('Server is closing'));
    if (this.#fault) return Promise.reject(this.#fault);
    const result = this.#queue.then(() => {
      if (this.#fault) throw this.#fault;
      return operation();
    });
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  read<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.#enqueue(operation);
  }

  mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.#enqueue(async () => {
      const publications: Array<() => void> = [];
      const terrainDirtyBefore = this.#terrainDirty;
      this.#publications = publications;
      let result: T;
      try {
        result = await operation();
      } catch (error) {
        this.#publications = undefined;
        this.#rollback(terrainDirtyBefore);
        throw error;
      }
      try {
        this.#state.runtime = this.#runtime.snapshot();
        this.#store.save(this.#state);
      } catch (error) {
        this.#publications = undefined;
        this.#fault = new Error(
          'Durable commit failed; server stopped to prevent divergent ticks',
          { cause: error },
        );
        this.#cancelTimer();
        this.events.emit('error', this.#fault);
        throw this.#fault;
      }
      this.#publications = undefined;
      for (const publish of publications) {
        try {
          publish();
        } catch (error) {
          this.events.emit('error', error instanceof Error ? error : new Error(String(error)));
        }
      }
      return result;
    });
  }

  #rollback(terrainDirtyBefore: boolean): void {
    const currentRuntime = this.#runtime.snapshot();
    this.#state.runtime = currentRuntime;
    if (JSON.stringify(this.#state) === this.#store.serialized) return;
    const committed = this.#store.load();
    if (!committed) throw new Error('Missing committed server state');
    // Ordinary validation failures never reset player heaps. A failed operation that changed
    // runtime data must restore that data; restoring a runtime intentionally performs a reset.
    if (JSON.stringify(currentRuntime) !== JSON.stringify(committed.runtime)) {
      this.#runtime.dispose();
      this.#runtime = new BotRuntime({ snapshot: committed.runtime, now: this.#now });
    }
    this.#state = committed;
    this.#simulation = this.#createSimulation();
    this.#terrainDirty = terrainDirtyBefore;
  }

  publish(channel: string, data: unknown): void {
    if (!this.#publications) throw new Error('Publish must occur inside a server mutation');
    this.#publications.push(() => {
      this.events.emit('message', channel, data);
    });
  }

  terrainChanged(): void {
    if (!this.#publications) throw new Error('Terrain changes must occur inside a server mutation');
    this.#terrainDirty = true;
    this.#publications.push(() => {
      this.events.emit('terrain');
    });
  }

  async #tick(): Promise<TickEvent> {
    const timestamp = this.#now();
    const maintenance = runMaintenance(this.#state, timestamp);
    for (const failure of maintenance.errors) {
      this.#publications?.push(() => {
        this.events.emit(
          'error',
          new Error(`Maintenance job failed: ${failure.job}`, { cause: failure.error }),
        );
      });
    }
    if (this.#terrainDirty) {
      this.#simulation.refreshTerrain();
      this.#runtime.refreshTerrain();
      this.#terrainDirty = false;
    }
    const runtime = await this.#runtime.runTick(this.#state.world);
    for (const [userId, global] of Object.entries(this.#state.pendingGlobalIntents)) {
      const user: StoredUserIntents = (runtime.intents[userId] ??= { rooms: {} });
      const destination = (user.global ??= {});
      for (const [name, intents] of Object.entries(global)) {
        const key = name as keyof typeof global;
        // Different intent names have different payload types; each source list retains its name.
        const target = destination as Record<string, unknown[]>;
        if (Array.isArray(intents)) {
          const list: unknown[] = intents;
          (target[key] ??= []).push(...list);
        }
      }
    }
    const simulation = this.#simulation.tick(runtime.intents, this.#state.pendingIntents);
    this.#state.pendingIntents = {};
    this.#state.pendingGlobalIntents = {};
    for (const [userId, result] of Object.entries(runtime.users)) {
      const user = this.#state.world.users[userId];
      if (user && Number.isFinite(result.cpu.bucket)) user.cpuAvailable = result.cpu.bucket;
    }
    for (const [room, objects] of Object.entries(simulation.history)) {
      (this.#state.history[room] ??= []).push({ time: simulation.gameTime, objects });
    }
    const cutoff = simulation.gameTime - this.config.historyTicks - this.config.historyChunkSize;
    for (const [room, frames] of Object.entries(this.#state.history)) {
      let expired = 0;
      while (expired < frames.length && (frames[expired]?.time ?? Infinity) < cutoff) expired++;
      if (expired) frames.splice(0, expired);
      if (!frames.length) Reflect.deleteProperty(this.#state.history, room);
    }
    const event: TickEvent = { runtime, simulation, timestamp };
    this.#recordStatistics(event);
    recordLeaderboard(this.#state, simulation.roomStats, timestamp);
    if (timestamp - (this.#state.jobs['server:tokens'] ?? 0) >= 60000) {
      for (const [token, session] of Object.entries(this.#state.tokens)) {
        if (session.expires <= timestamp) Reflect.deleteProperty(this.#state.tokens, token);
      }
      this.#state.jobs['server:tokens'] = timestamp;
    }
    this.#publications?.push(() => {
      this.events.emit('tick', event);
    });
    return event;
  }

  #recordStatistics(event: TickEvent): void {
    const time = Math.floor(event.timestamp / 60000) * 60000;
    let sample = this.#state.statistics.at(-1);
    if (!sample || sample.time !== time) {
      sample = { time, tick: event.simulation.gameTime, ticks: 0, rooms: {}, users: {} };
      this.#state.statistics.push(sample);
    }
    sample.tick = event.simulation.gameTime;
    sample.ticks++;
    for (const [room, users] of Object.entries(event.simulation.roomStats)) {
      const targetRoom = (sample.rooms[room] ??= {});
      for (const [userId, counters] of Object.entries(users)) {
        const targetUser = (targetRoom[userId] ??= {});
        for (const [counter, value] of Object.entries(counters)) {
          targetUser[counter] = (targetUser[counter] ?? 0) + value;
        }
      }
    }
    for (const [userId, result] of Object.entries(event.runtime.users)) {
      const previous = sample.users[userId];
      const user = this.#state.world.users[userId];
      const entry: StatisticsSample['users'][string] = {
        cpu: ((previous?.cpu ?? 0) * (sample.ticks - 1) + result.cpu.used) / sample.ticks,
        memory: result.memorySize,
        bucket: Number.isFinite(result.cpu.bucket) ? result.cpu.bucket : 0,
        gcl: user?.gcl ?? 0,
        power: user?.power ?? 0,
      };
      sample.users[userId] = entry;
    }
    const cutoff = time - 7 * 24 * 60 * 60000;
    let expired = 0;
    while ((this.#state.statistics[expired]?.time ?? Infinity) < cutoff) expired++;
    if (expired) this.#state.statistics.splice(0, expired);
  }

  async exportSnapshot(): Promise<ServerState> {
    return this.read(() => structuredClone(this.#state));
  }

  async importSnapshot(value: unknown): Promise<void> {
    const serialized: unknown = JSON.stringify(value);
    if (typeof serialized !== 'string') throw new Error('Invalid server snapshot');
    const state = decodeState(serialized);
    await this.mutate(() => {
      const simulation = this.#createSimulation(state);
      const runtime = new BotRuntime({ snapshot: state.runtime, now: this.#now });
      this.#runtime.dispose();
      this.#state = state;
      this.#runtime = runtime;
      this.#simulation = simulation;
      this.#terrainDirty = false;
      this.#publications?.push(() => {
        this.events.emit('reset');
      });
      this.#publications?.push(() => {
        this.events.emit('terrain');
      });
    });
    this.#schedule();
  }

  async step(): Promise<TickEvent> {
    const event = await this.mutate(() => this.#tick());
    this.#deliverNotifications();
    return event;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#schedule();
  }

  #cancelTimer(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(delay = this.#state.tickDuration): void {
    this.#cancelTimer();
    if (!this.#started || this.#state.paused || this.#closing || this.#fault) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const started = performance.now();
      void this.mutate(async () => {
        if (!this.#state.paused) await this.#tick();
      }).then(
        () => {
          this.#deliverNotifications();
          this.#schedule(Math.max(1, this.#state.tickDuration - (performance.now() - started)));
        },
        (error: unknown) => {
          this.#fault = error instanceof Error ? error : new Error(String(error));
          this.events.emit('error', this.#fault);
        },
      );
    }, delay);
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.mutate(() => {
      this.#state.paused = paused;
      this.publish('server:paused', paused);
    });
    this.#schedule();
  }

  async setTickDuration(milliseconds: number): Promise<void> {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 3600000) {
      throw new Error('Tick duration must be an integer from 1 to 3600000 ms');
    }
    await this.mutate(() => {
      this.#state.tickDuration = milliseconds;
      this.publish('server:tickRate', milliseconds);
    });
    this.#schedule();
  }

  #deliverNotifications(): void {
    const deliver = this.config.deliverNotifications;
    if (!deliver || this.#delivery || this.#closing) return;
    this.#delivery = this.read(() => this.#state.notificationOutbox[0])
      .then(async (notification) => {
        if (!notification) return;
        await deliver(structuredClone(notification));
        await this.mutate(() => {
          const index = this.#state.notificationOutbox.findIndex(
            (item) => item.id === notification.id,
          );
          if (index >= 0) this.#state.notificationOutbox.splice(index, 1);
        });
      })
      .catch((error: unknown) => {
        this.events.emit('error', error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        this.#delivery = undefined;
      });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#cancelTimer();
    this.#started = false;
    // Let a configured delivery acknowledge its result before rejecting new mutations.
    await this.#delivery;
    this.#closing = true;
    await this.#queue;
    this.#runtime.dispose();
    this.#store.close();
    this.#closed = true;
    this.events.removeAllListeners();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
