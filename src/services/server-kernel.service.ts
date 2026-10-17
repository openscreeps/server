import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import type {
  BotRuntime,
  GameSessionOptions,
  MaintenanceReport,
  NotificationBatch,
  WorkerHostCall,
} from '@openscreeps/game';
import {
  GameSession,
  jobKey,
  MAINTENANCE_JOBS,
  pruneJobs,
  runJob,
  ProcessorPool,
  RunnerPool,
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
import {
  copyHistory,
  decodeState,
  initialServerState,
  sameHistory,
  snapshotJson,
} from '../storage.ts';
import { StateStore } from './state-store.service.ts';
import { OriginalMods } from '../compatibility/original-mods.ts';
import { importOriginalWorld } from '../compatibility/original-import.ts';
import { callOriginalStorage } from '../compatibility/original-worker.ts';
import { WorkerLogs } from '../compatibility/worker-logs.ts';
import { reloadBotUsers } from '../compatibility/original-cli.ts';

/** Upstream backend `setInterval(cronjobs.run, 1000)`: the wall-clock maintenance period. */
export const MAINTENANCE_INTERVAL = 1000;
/** `state.jobs` key of the last expired-token sweep. */
const TOKEN_SWEEP_KEY = 'server:tokens';
const TOKEN_SWEEP_INTERVAL = 60000;
/** First and longest pause before a failed notification delivery is retried. */
const DELIVERY_RETRY_MIN = 1000;
const DELIVERY_RETRY_MAX = 60000;

/** One wall-clock maintenance job: upstream `config.cronjobs[name] = [interval, run]`. */
export interface Cronjob {
  /** Minimal wall-clock interval between runs, in seconds; the job runs once more time elapsed. */
  readonly interval: number;
  /**
   * Runs inside a serialized kernel mutation and is awaited; the result is ignored. Batches it
   * appends to `state.notificationOutbox` are delivered after the commit. A throw rolls back only
   * this job's changes; its schedule still advances, so it is retried after its interval.
   */
  run(now: number): unknown;
}
/** Job table in run order, keyed by job name; the kernel reads it anew on every pass. */
export type Cronjobs = Record<string, Cronjob>;

/** Game session options a kernel host may set; the kernel owns state, clock, history and cron. */
export type KernelSessionOptions = Omit<
  GameSessionOptions<ServerState>,
  'state' | 'now' | 'historyTicks' | 'historyChunkSize' | 'hooks' | 'maintenance'
>;

export interface ServerKernelOptions {
  /** Initial world for an empty database; rejected when the database already holds a world. */
  state?: ServerState;
  now?: () => number;
  /** Player runtime and simulation options (limits, sandbox hooks, processor hooks or pools). */
  session?: KernelSessionOptions;
  /** Builds the job table once the kernel exists; default `defaultCronjobs`. */
  cronjobs?: (context: ServerContext) => Cronjobs;
  /** Notification sink, called outside the lock; default `config.deliverNotifications`. */
  deliverNotifications?: (notification: NotificationBatch) => Promise<void>;
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

/** The original backend's eleven jobs, in upstream order, queueing their notification batches. */
export function defaultCronjobs(context: ServerContext): Cronjobs {
  const hooks = maintenanceHooks(() => context.state);
  const jobs: Cronjobs = {};
  for (const [name, job] of Object.entries(MAINTENANCE_JOBS)) {
    jobs[name] = {
      interval: job.interval,
      run: (now) => {
        const { state } = context;
        state.notificationOutbox.push(...runJob(state, name, now, hooks));
      },
    };
  }
  return jobs;
}

/** The kernel operation an asynchronous context runs in. */
interface Scope {
  /** Cleared once the operation settles: detached work inheriting the scope never joins it. */
  active: boolean;
  readonly mutable: boolean;
  /** Joined calls in flight; the operation completes only after they settle. */
  readonly joined: Set<Promise<void>>;
}

function emptyReport(): MaintenanceReport {
  return { ran: [], errors: [], notifications: [] };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The server's single world: a `GameSession` whose every change runs as one serialized mutation,
 * durably committed before its events are published. Ticks follow the persisted tick rate;
 * maintenance jobs and notification delivery follow the wall clock, also while paused.
 */
@Injectable()
export class ServerKernel implements ServerContext, AsyncDisposable {
  readonly config: ServerConfig;
  readonly mods: OriginalMods;
  readonly runners: RunnerPool | undefined;
  readonly processors: ProcessorPool | undefined;
  readonly #workerLogs: WorkerLogs;
  readonly events = new EventEmitter<ServerEvents>();
  readonly #store: StateStore;
  readonly #session: GameSession<ServerState>;
  readonly #deliver: ((notification: NotificationBatch) => Promise<void>) | undefined;
  readonly #scope = new AsyncLocalStorage<Scope>();
  #cronjobs: Cronjobs = {};
  #queue: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;
  /** An automatic tick is queued or running; it schedules its successor when it settles. */
  #ticking = false;
  #maintenanceTimer: NodeJS.Timeout | undefined;
  #maintenancePass: Promise<void> | undefined;
  /** `close()` began: no new timers, passes or deliveries; queued work still completes. */
  #stopping = false;
  /** New operations are rejected. */
  #closing = false;
  #closure: Promise<void> | undefined;
  #started = false;
  #fault: Error | undefined;
  #publications: Array<() => void> | undefined;
  #delivery: Promise<void> | undefined;
  #deliveryRetryAt = 0;
  #deliveryRetryDelay = DELIVERY_RETRY_MIN;

  private constructor(
    config: ServerConfig,
    store: StateStore,
    session: GameSession<ServerState>,
    deliver: ((notification: NotificationBatch) => Promise<void>) | undefined,
    mods: OriginalMods,
    runners: RunnerPool | undefined,
    processors: ProcessorPool | undefined,
    workerLogs: WorkerLogs,
  ) {
    this.config = config;
    this.#store = store;
    this.#session = session;
    this.#deliver = deliver;
    this.mods = mods;
    this.runners = runners;
    this.processors = processors;
    this.#workerLogs = workerLogs;
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
    let mods: OriginalMods | undefined;
    let runners: RunnerPool | undefined;
    let processors: ProcessorPool | undefined;
    let workerLogs: WorkerLogs | undefined;
    let kernel: ServerKernel | undefined;
    try {
      const workerConfig = { ...config };
      delete workerConfig.deliverNotifications;
      mods = new OriginalMods(config, 'server', undefined, async () => {
        if (!kernel) throw new Error('World is not initialized');
        await kernel.importSnapshot(initialServerState(config, kernel.mods.common.constants));
      });
      const constants = options.session?.constants ?? mods.common.constants;
      const saved = opened.load();
      if (saved && options.state)
        throw new Error('Cannot replace an existing database with initial state');
      let state = options.state ? structuredClone(options.state) : saved;
      if (!state && config.originalDatabase) {
        const original: unknown = JSON.parse(await readFile(config.originalDatabase, 'utf8'));
        state = importOriginalWorld(original, {
          now: (options.now ?? Date.now)(),
          shardName: config.shardName,
          tickDuration: config.tickDuration,
          onReport: (report) => {
            console.info('Original world imported:', JSON.stringify(report));
          },
        });
      }
      state ??= initialServerState(config, constants);
      workerLogs = new WorkerLogs(config);
      const storage = mods.storage;
      const poolOptions = {
        restartIntervalMs: (config.workerRestartInterval ?? 3600) * 1000,
        setup: {
          module: new URL(
            import.meta.url.endsWith('.ts')
              ? '../compatibility/original-worker.ts'
              : '../compatibility/original-worker.js',
            import.meta.url,
          ).href,
          data: workerConfig,
        },
        onCall: (call: WorkerHostCall) => callOriginalStorage(storage, call),
        onEvent: workerLogs.event,
        output: 'events' as const,
      };
      const runtime = { ...mods.runtimeOptions, ...options.session?.runtime };
      const simulation: NonNullable<KernelSessionOptions['simulation']> = {
        hooks: mods.simulationHooks,
        ...options.session?.simulation,
      };
      if (config.runnerCount !== undefined) {
        if (options.session?.runtime?.playerSandbox) {
          throw new Error('Runner processes require sandbox hooks in the original mod file');
        }
        runners = new RunnerPool({
          ...poolOptions,
          processes: config.runnerCount,
          threads: config.runnerThreads ?? 4,
        });
        delete runtime.playerSandbox;
        runtime.runners = runners;
      }
      if (config.processorCount !== undefined) {
        if (options.session?.simulation?.hooks) {
          throw new Error('Processor processes require hooks in the original mod file');
        }
        processors = new ProcessorPool({ ...poolOptions, processes: config.processorCount });
        delete simulation.hooks;
        simulation.processors = processors;
      }
      session = new GameSession<ServerState>({
        ...options.session,
        runtime,
        simulation,
        constants,
        state,
        now: options.now ?? Date.now,
        historyTicks: config.historyTicks,
        historyChunkSize: config.historyChunkSize,
        maintenance: false,
      });
      const loadedMods = mods;
      const deliver =
        options.deliverNotifications ??
        (mods.backend.listenerCount('sendUserNotifications') || config.deliverNotifications
          ? (batch: NotificationBatch) => loadedMods.deliverNotifications(batch)
          : undefined);
      kernel = new ServerKernel(
        config,
        opened,
        session,
        deliver,
        mods,
        runners,
        processors,
        workerLogs,
      );
      kernel.#cronjobs = options.cronjobs?.(kernel) ?? mods.cronjobRegistry();
      await opened.save(state);
      await mods.bind(kernel);
      const liveKernel = kernel;
      if (runners || processors)
        mods.storage.pubsub.subscribe('*', function (data) {
          const event = { channel: this.channel, data };
          liveKernel.runners?.broadcast('original-pubsub', event);
          liveKernel.processors?.broadcast('original-pubsub', event);
        });
      for (const name of Object.keys(mods.common.bots)) {
        await reloadBotUsers(kernel, mods.common.bots, name);
      }
      return kernel;
    } catch (error) {
      session?.dispose();
      await Promise.all([runners?.close(), processors?.close()]);
      mods?.close();
      workerLogs?.[Symbol.dispose]();
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
    return !this.#fault && !this.#stopping;
  }
  /** The live job table (built-in and mod jobs) that the wall-clock passes run. */
  get cronjobs(): Readonly<Cronjobs> {
    return this.#cronjobs;
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

  /** The operation the caller runs inside, unless it already settled. */
  #activeScope(): Scope | undefined {
    const scope = this.#scope.getStore();
    return scope?.active ? scope : undefined;
  }

  /** Runs a call made inside an active operation as part of it, instead of queueing behind it. */
  #join<T>(scope: Scope, operation: () => T | Promise<T>): Promise<T> {
    const { promise: result, resolve, reject } = Promise.withResolvers<T>();
    try {
      resolve(operation());
    } catch (error) {
      reject(error);
    }
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    scope.joined.add(settled);
    void settled.then(() => scope.joined.delete(settled));
    // A derived promise keeps an unawaited rejection visible to the caller's runtime.
    return result.then((value) => value);
  }

  /** Runs `operation` in `scope`, then waits for the calls it joined (also when it failed). */
  async #within<T>(scope: Scope, operation: () => T | Promise<T>): Promise<T> {
    try {
      return await this.#scope.run(scope, operation);
    } finally {
      while (scope.joined.size) await Promise.all(scope.joined);
      scope.active = false;
    }
  }

  /** Serialized with ticks and mutations; a call inside an active operation joins it. */
  read<T>(operation: () => T | Promise<T>): Promise<T> {
    const scope = this.#activeScope();
    if (scope) return this.#join(scope, operation);
    return this.#enqueue(() =>
      this.#within({ active: true, mutable: false, joined: new Set() }, operation),
    );
  }

  /**
   * Serialized, durably committed, then published; a failure rolls the world back. A call inside an
   * active mutation joins it (committing or rolling back with it); inside a read it is rejected.
   */
  mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    const scope = this.#activeScope();
    if (scope) {
      return scope.mutable
        ? this.#join(scope, operation)
        : Promise.reject(new Error('Cannot mutate the world inside a read'));
    }
    return this.#enqueue(() => this.#commit(operation));
  }

  async #commit<T>(operation: () => T | Promise<T>): Promise<T> {
    const publications: Array<() => void> = [];
    const terrainDirtyBefore = this.#session.terrainDirty;
    this.#publications = publications;
    let result: T;
    try {
      result = await this.#within({ active: true, mutable: true, joined: new Set() }, operation);
    } catch (error) {
      this.#publications = undefined;
      this.#rollback(terrainDirtyBefore);
      this.#reconcileSchedule();
      throw error;
    }
    try {
      this.#session.syncRuntime();
      await this.#store.save(this.state);
    } catch (error) {
      this.#publications = undefined;
      this.#fault = new Error('Durable commit failed; server stopped to prevent divergent ticks', {
        cause: error,
      });
      this.#cancelTimers();
      this.events.emit('error', this.#fault);
      throw this.#fault;
    }
    this.#publications = undefined;
    for (const publish of publications) {
      try {
        publish();
      } catch (error) {
        this.events.emit('error', toError(error));
      }
    }
    this.#reconcileSchedule();
    this.#kickDelivery();
    return result;
  }

  #rollback(terrainDirtyBefore: boolean): void {
    this.#session.syncRuntime();
    if (this.#store.isCommitted(this.state)) return;
    const committed = this.#store.load();
    if (!committed) throw new Error('Missing committed server state');
    // Ordinary validation failures never reset player heaps. A failed operation that changed
    // runtime data must restore that data; restoring a runtime intentionally performs a reset.
    this.#session.adopt(committed, { runtime: 'preserve', terrainDirty: terrainDirtyBefore });
  }

  /** Inside a mutation: returns a function restoring the world and pending publications to now. */
  #savepoint(): () => void {
    this.#session.syncRuntime();
    const serialized = snapshotJson(this.state);
    // Frames are never mutated once recorded: the savepoint keeps the history's frame references.
    const history = copyHistory(this.state.history);
    const terrainDirty = this.#session.terrainDirty;
    const publications = this.#publications;
    const published = publications?.length ?? 0;
    return () => {
      publications?.splice(published);
      this.#session.syncRuntime();
      if (snapshotJson(this.state) === serialized && sameHistory(this.state.history, history)) {
        return;
      }
      const state = decodeState(serialized);
      state.history = copyHistory(history);
      this.#session.adopt(state, { runtime: 'preserve', terrainDirty });
    };
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

  async #tick(maintenance: MaintenanceReport = emptyReport()): Promise<TickEvent> {
    this.mods.engine.emit('mainLoopStage', 'start');
    try {
      const event: TickEvent = { ...(await this.#session.tick()), maintenance };
      this.mods.engine.emit('mainLoopStage', 'custom');
      await this.mods.engine.mainLoopCustomStage();
      this.#publications?.push(() => {
        this.events.emit('tick', event);
      });
      return event;
    } finally {
      this.mods.engine.emit('mainLoopStage', 'finish');
    }
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

  /** One explicit tick, preceded by the due maintenance jobs, committed as one mutation. */
  step(): Promise<TickEvent> {
    return this.mutate(async () => this.#tick(await this.#maintain(this.now())));
  }

  /**
   * Runs the due maintenance jobs now and reports them; the wall-clock timer calls this every
   * second once started. Jobs that are not due are skipped without a commit.
   */
  async maintain(): Promise<MaintenanceReport> {
    if (!(await this.read(() => this.#maintenanceDue(this.now())))) return emptyReport();
    return this.mutate(() => this.#maintain(this.now()));
  }

  /**
   * Upstream `system.runCronjob`: runs one registered job immediately as one mutation, leaving its
   * schedule untouched. Rejects with `Cronjob "<name>" not found` for unknown names.
   */
  async runCronjob(name: string): Promise<void> {
    const job = Object.hasOwn(this.#cronjobs, name) ? this.#cronjobs[name] : undefined;
    if (!job) throw new Error(`Cronjob "${name}" not found`);
    await this.mutate(() => job.run(this.now()));
  }

  /** Whether a job's interval elapsed, or its last run lies ahead of a clock moved backwards. */
  #jobDue(name: string, job: Cronjob, now: number): 'run' | 'reset' | undefined {
    const last = this.state.jobs[jobKey(name)] ?? 0;
    if (last > now) return 'reset';
    return now - last > job.interval * 1000 ? 'run' : undefined;
  }

  #tokenSweepDue(now: number): boolean {
    const last = this.state.jobs[TOKEN_SWEEP_KEY] ?? 0;
    return last > now || now - last >= TOKEN_SWEEP_INTERVAL;
  }

  #maintenanceDue(now: number): boolean {
    const jobs = this.#cronjobs;
    return (
      this.#tokenSweepDue(now) ||
      Object.keys(jobs).some((name) => {
        const job = jobs[name];
        return job !== undefined && this.#jobDue(name, job, now) !== undefined;
      })
    );
  }

  /** Inside a mutation: runs every due job in table order (upstream `cronjobs.run`). */
  async #maintain(now: number): Promise<MaintenanceReport> {
    const report = emptyReport();
    const jobs = this.#cronjobs;
    for (const name of Object.keys(jobs)) {
      const job = jobs[name];
      if (!job) continue;
      const due = this.#jobDue(name, job, now);
      if (!due) continue;
      this.state.jobs[jobKey(name)] = now;
      if (due === 'run') {
        report.ran.push(name);
        await this.#runJob(name, job, now, report);
      }
    }
    if (report.ran.length) pruneJobs(this.state);
    if (this.#tokenSweepDue(now)) {
      const { state } = this;
      for (const [token, session] of Object.entries(state.tokens)) {
        if (session.expires <= now) Reflect.deleteProperty(state.tokens, token);
      }
      state.jobs[TOKEN_SWEEP_KEY] = now;
    }
    return report;
  }

  async #runJob(name: string, job: Cronjob, now: number, report: MaintenanceReport): Promise<void> {
    const outbox = this.state.notificationOutbox;
    const queued = outbox.length;
    const restore = this.#savepoint();
    try {
      await job.run(now);
    } catch (error) {
      restore();
      report.errors.push({ job: name, error });
      this.#publications?.push(() => {
        this.events.emit('error', new Error(`Maintenance job failed: ${name}`, { cause: error }));
      });
      return;
    }
    if (this.state.notificationOutbox === outbox) {
      report.notifications.push(...outbox.slice(queued));
    }
  }

  start(): void {
    if (this.#started || this.#stopping) return;
    this.#started = true;
    this.#schedule();
    this.#scheduleMaintenance();
    // Batches left queued by an earlier run.
    this.#kickDelivery();
  }

  #cancelTimers(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    clearTimeout(this.#maintenanceTimer);
    this.#maintenanceTimer = undefined;
  }

  /** Arms the next automatic tick; an automatic tick in flight arms its successor itself. */
  #schedule(delay = this.state.tickDuration): void {
    if (this.#ticking) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#started || this.state.paused || this.#stopping || this.#fault) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#ticking = true;
      const started = performance.now();
      void this.#scope
        .exit(() =>
          this.mutate(async () => {
            if (!this.state.paused) await this.#tick();
          }),
        )
        .then(() => {
          this.#ticking = false;
          const usedTime = performance.now() - started;
          const delay =
            this.mods.engine.getNextTickDelay?.(usedTime) ?? this.state.tickDuration - usedTime;
          if (!Number.isFinite(delay))
            throw new Error('getNextTickDelay must return a finite number');
          this.#schedule(Math.max(1, delay));
        })
        .catch((error: unknown) => {
          this.#ticking = false;
          if (this.#stopping) return;
          this.#fault ??= toError(error);
          this.#cancelTimers();
          this.events.emit('error', this.#fault);
        });
    }, delay);
  }

  /** After a top-level mutation settles: follow a pause state it committed or rolled back. */
  #reconcileSchedule(): void {
    if (!this.#started || this.#ticking) return;
    if (this.state.paused) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    } else if (!this.#timer) {
      this.#schedule();
    }
  }

  #scheduleMaintenance(delay = MAINTENANCE_INTERVAL): void {
    clearTimeout(this.#maintenanceTimer);
    this.#maintenanceTimer = undefined;
    if (!this.#started || this.#stopping || this.#fault) return;
    this.#maintenanceTimer = setTimeout(() => {
      this.#maintenanceTimer = undefined;
      const started = performance.now();
      this.#maintenancePass = this.#scope
        .exit(() => this.#timedMaintenance())
        .finally(() => {
          this.#maintenancePass = undefined;
          this.#scheduleMaintenance(
            Math.max(1, MAINTENANCE_INTERVAL - (performance.now() - started)),
          );
        });
    }, delay);
  }

  async #timedMaintenance(): Promise<void> {
    try {
      await this.maintain();
    } catch (error) {
      // A failed commit already stopped the kernel and reported its fault.
      if (!this.#fault && !this.#stopping) this.events.emit('error', toError(error));
    }
    // Retries deliveries that failed earlier, once their backoff elapsed.
    this.#kickDelivery();
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.mutate(() => {
      this.state.paused = paused;
      this.publish('server:paused', paused);
    });
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

  /**
   * Delivers queued notification batches now, also during a failure backoff, and resolves once the
   * outbox drained or a delivery failed (reported as an `error` event; the batch stays queued).
   */
  async flushNotifications(): Promise<void> {
    await this.#delivery;
    this.#deliveryRetryAt = 0;
    this.#kickDelivery();
    await this.#delivery;
  }

  /** Starts draining the outbox unless a drain runs, the backoff holds or nothing is queued. */
  #kickDelivery(): void {
    const deliver = this.#deliver;
    if (!deliver || this.#delivery || this.#stopping || this.#fault) return;
    if (!this.state.notificationOutbox.length || this.now() < this.#deliveryRetryAt) return;
    this.#delivery = this.#scope
      .exit(() => this.#drain(deliver))
      .finally(() => {
        this.#delivery = undefined;
        // A batch committed after the drain's last look still gets delivered.
        this.#kickDelivery();
      });
  }

  /** Delivers batches oldest first, outside the lock; each is removed only after it succeeded. */
  async #drain(deliver: (notification: NotificationBatch) => Promise<void>): Promise<void> {
    try {
      while (!this.#stopping) {
        const batch = await this.read(() => structuredClone(this.state.notificationOutbox[0]));
        if (!batch) return;
        try {
          await deliver(batch);
        } catch (error) {
          throw new Error(`Notification delivery failed: ${batch.id}`, { cause: error });
        }
        await this.mutate(() => {
          const outbox = this.state.notificationOutbox;
          const index = outbox.findIndex((item) => item.id === batch.id);
          if (index >= 0) outbox.splice(index, 1);
        });
        this.#deliveryRetryDelay = DELIVERY_RETRY_MIN;
      }
    } catch (error) {
      this.#deliveryRetryAt = this.now() + this.#deliveryRetryDelay;
      this.#deliveryRetryDelay = Math.min(this.#deliveryRetryDelay * 2, DELIVERY_RETRY_MAX);
      // A failed commit already stopped the kernel and reported its fault.
      if (!this.#fault) this.events.emit('error', toError(error));
    }
  }

  /**
   * Stops the timers, lets a running maintenance pass commit and a running delivery acknowledge its
   * batch, drains queued work, then closes the store (ending the writer lease). Undelivered batches
   * stay in the persisted outbox. Idempotent.
   */
  close(): Promise<void> {
    this.#closure ??= this.#shutdown();
    return this.#closure;
  }

  async #shutdown(): Promise<void> {
    this.#stopping = true;
    this.#started = false;
    this.#cancelTimers();
    await this.#maintenancePass;
    await this.#delivery;
    this.#closing = true;
    await this.#queue;
    this.#session.dispose();
    await Promise.all([this.runners?.close(), this.processors?.close()]);
    this.mods.close();
    this.#workerLogs[Symbol.dispose]();
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
