import { EventEmitter } from 'node:events';
import { Injectable } from '@nestjs/common';
import type { BotRuntime } from '@openscreeps/game';
import {
  createGameState,
  GameSession,
  type MaintenanceHooks,
  type NotificationRecipient,
} from '@openscreeps/game';
import type {
  ServerConfig,
  ServerContext,
  ServerEvents,
  ServerState,
  TickEvent,
} from '../contracts.ts';
import { decodeState } from '../storage.ts';
import { StateStore } from './state-store.service.ts';

export interface ServerKernelOptions {
  /** Initial world for an empty database; rejected when the database already holds a world. */
  state?: ServerState;
  now?: () => number;
}

/** Maintenance reads notification addresses and preferences from private account profiles. */
export function maintenanceHooks(state: () => ServerState): MaintenanceHooks {
  return {
    notificationRecipient: (userId) => {
      const profile = state().profiles[userId];
      if (!profile) return undefined;
      const recipient: NotificationRecipient = {};
      if (profile.email !== undefined) recipient.email = profile.email;
      if (profile.notifyPrefs !== undefined) recipient.preferences = profile.notifyPrefs;
      return recipient;
    },
  };
}

/**
 * The server's single world: a `GameSession` whose every change runs as one serialized mutation,
 * durably committed before its events are published, and ticked by a persisted-rate timer.
 */
@Injectable()
export class ServerKernel implements ServerContext, AsyncDisposable {
  readonly config: ServerConfig;
  readonly events = new EventEmitter<ServerEvents>();
  readonly #store: StateStore;
  readonly #session: GameSession<ServerState>;
  #queue: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;
  #closing = false;
  #closure: Promise<void> | undefined;
  #started = false;
  #fault: Error | undefined;
  #publications: Array<() => void> | undefined;
  #delivery: Promise<void> | undefined;

  private constructor(config: ServerConfig, store: StateStore, session: GameSession<ServerState>) {
    this.config = config;
    this.#store = store;
    this.#session = session;
    this.events.on('error', (error) => {
      console.error(error);
    });
  }

  /**
   * Loads the committed world, or creates and commits a new one. Without `store` the kernel opens
   * one from `config`. The kernel takes over the store either way: `close()` closes it, and a failed
   * create aborts it, also destroying a borrowed data source that nothing else would release.
   */
  static async create(
    config: ServerConfig,
    options: ServerKernelOptions = {},
    store?: StateStore,
  ): Promise<ServerKernel> {
    const opened = store ?? (await StateStore.open(config));
    let session: GameSession<ServerState> | undefined;
    try {
      const saved = opened.load();
      if (saved && options.state)
        throw new Error('Cannot replace an existing database with initial state');
      const state: ServerState = (options.state ? structuredClone(options.state) : saved) ?? {
        ...createGameState({
          size: config.worldSize,
          seed: config.seed,
          shardName: config.shardName,
        }),
        profiles: {},
        tokens: {},
        messages: {},
        notificationOutbox: [],
        paused: config.paused,
        tickDuration: config.tickDuration,
      };
      const created: GameSession<ServerState> = new GameSession({
        state,
        now: options.now ?? Date.now,
        historyTicks: config.historyTicks,
        historyChunkSize: config.historyChunkSize,
        hooks: maintenanceHooks(() => created.state),
      });
      session = created;
      const kernel = new ServerKernel(config, opened, created);
      await opened.save(state);
      return kernel;
    } catch (error) {
      session?.dispose();
      try {
        await opened.abort();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'Server failed to start and to release its world',
          { cause: cleanup },
        );
      }
      throw error;
    }
  }

  get state(): ServerState {
    return this.#session.state;
  }
  get runtime(): BotRuntime {
    return this.#session.runtime;
  }
  get healthy(): boolean {
    return !this.#fault && !this.#closing;
  }
  now(): number {
    return this.#session.now();
  }

  #enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.#closing) return Promise.reject(new Error('Server is closing'));
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
      const terrainDirtyBefore = this.#session.terrainDirty;
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
        this.#session.syncRuntime();
        await this.#store.save(this.state);
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
    this.#session.syncRuntime();
    if (JSON.stringify(this.state) === this.#store.serialized) return;
    const committed = this.#store.load();
    if (!committed) throw new Error('Missing committed server state');
    // Ordinary validation failures never reset player heaps. A failed operation that changed
    // runtime data must restore that data; restoring a runtime intentionally performs a reset.
    this.#session.adopt(committed, { runtime: 'preserve', terrainDirty: terrainDirtyBefore });
  }

  publish(channel: string, data: unknown): void {
    if (!this.#publications) throw new Error('Publish must occur inside a server mutation');
    this.#publications.push(() => {
      this.events.emit('message', channel, data);
    });
  }

  terrainChanged(): void {
    if (!this.#publications) throw new Error('Terrain changes must occur inside a server mutation');
    this.#session.terrainChanged();
    this.#publications.push(() => {
      this.events.emit('terrain');
    });
  }

  async #tick(): Promise<TickEvent> {
    const event = await this.#session.tick();
    const { state } = this;
    for (const failure of event.maintenance.errors) {
      this.#publications?.push(() => {
        this.events.emit(
          'error',
          new Error(`Maintenance job failed: ${failure.job}`, { cause: failure.error }),
        );
      });
    }
    state.notificationOutbox.push(...event.maintenance.notifications);
    if (event.timestamp - (state.jobs['server:tokens'] ?? 0) >= 60000) {
      for (const [token, session] of Object.entries(state.tokens)) {
        if (session.expires <= event.timestamp) Reflect.deleteProperty(state.tokens, token);
      }
      state.jobs['server:tokens'] = event.timestamp;
    }
    this.#publications?.push(() => {
      this.events.emit('tick', event);
    });
    return event;
  }

  async exportSnapshot(): Promise<ServerState> {
    return this.read(() => structuredClone(this.state));
  }

  async importSnapshot(value: unknown): Promise<void> {
    const serialized: unknown = JSON.stringify(value);
    if (typeof serialized !== 'string') throw new Error('Invalid server snapshot');
    const state = decodeState(serialized);
    await this.mutate(() => {
      this.#session.adopt(state);
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

  #schedule(delay = this.state.tickDuration): void {
    this.#cancelTimer();
    if (!this.#started || this.state.paused || this.#closing || this.#fault) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const started = performance.now();
      void this.mutate(async () => {
        if (!this.state.paused) await this.#tick();
      }).then(
        () => {
          this.#deliverNotifications();
          this.#schedule(Math.max(1, this.state.tickDuration - (performance.now() - started)));
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
      this.state.paused = paused;
      this.publish('server:paused', paused);
    });
    this.#schedule();
  }

  async setTickDuration(milliseconds: number): Promise<void> {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 3600000) {
      throw new Error('Tick duration must be an integer from 1 to 3600000 ms');
    }
    await this.mutate(() => {
      this.state.tickDuration = milliseconds;
      this.publish('server:tickRate', milliseconds);
    });
    this.#schedule();
  }

  #deliverNotifications(): void {
    const deliver = this.config.deliverNotifications;
    if (!deliver || this.#delivery || this.#closing) return;
    this.#delivery = this.read(() => this.state.notificationOutbox[0])
      .then(async (notification) => {
        if (!notification) return;
        await deliver(structuredClone(notification));
        await this.mutate(() => {
          const index = this.state.notificationOutbox.findIndex(
            (item) => item.id === notification.id,
          );
          if (index >= 0) this.state.notificationOutbox.splice(index, 1);
        });
      })
      .catch((error: unknown) => {
        this.events.emit('error', error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        this.#delivery = undefined;
      });
  }

  /** Drains queued work, then closes the store (ending the writer lease). Idempotent. */
  close(): Promise<void> {
    this.#closure ??= this.#shutdown();
    return this.#closure;
  }

  async #shutdown(): Promise<void> {
    this.#cancelTimer();
    this.#started = false;
    // Let a configured delivery acknowledge its result before rejecting new mutations.
    await this.#delivery;
    this.#closing = true;
    await this.#queue;
    this.#session.dispose();
    try {
      await this.#store.close();
    } finally {
      this.events.removeAllListeners();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
