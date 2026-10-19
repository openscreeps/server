/*
 * Socket protocol 14 sessions and subscriptions (backend `socket/server.js`, `rooms.js`,
 * `user.js`, `map.js`, `system.js`).
 *
 * Everything sent is the outcome of successful operations: tick results arrive through
 * `events.tick` after the tick succeeded, other slices' `context.publish` messages after their
 * mutation succeeded, and every state read (room snapshots, diffs, memory, map views) runs inside
 * `context.read`, which is serialized with ticks and mutations.
 */

import type { JsonObject } from '@openscreeps/game';
import { isRecord } from '../api/guards.ts';
import type { ApiContext, TickEvent } from '../contracts.ts';
import { canSubscribe, parseChannel, type ChannelSpec } from './channels.ts';
import { jsonObjects, RoomObjectsMirror } from './diff.ts';
import { encodeFrame, eventMessage, htmlEncode } from './encode.ts';
import {
  OriginalSocketBridge,
  type BuiltinSocketModule,
} from '../compatibility/original-sockets.ts';

export const PROTOCOL = 14;
/** Rooms one user is sent at a time across all connections (backend `rooms.js` `USER_LIMIT`). */
const USER_ROOM_LIMIT = 2;
/** Memory paths evaluated per user and update (backend `user.js`). */
const MEMORY_PATHS_PER_USER = 50;
/** Commands a connection may have waiting; a client that floods faster is disconnected. */
const MAX_QUEUED_COMMANDS = 256;
/** Compressed writes in flight above which a connection skips room and map updates. */
const BACKLOG_LIMIT = 8;
const WORLD_ROOM = /^(W|E)\d+(N|S)\d+$/;
const CPU_LIMIT_ERROR = /CPU limit reached/;
/** Built-in NPC players whose console the driver never publishes (`roomBuiltinUsers`). */
const BUILTIN_USERS: Readonly<Record<string, { _id: string; username: string }>> = {
  '2': { _id: '2', username: 'Invader' },
  '3': { _id: '3', username: 'Source Keeper' },
};

/** The transport of one client connection. */
export interface RealtimeSocket {
  write(message: string): unknown;
  close(): unknown;
}

/** Callbacks the transport invokes for one connection. */
export interface RealtimeConnection {
  receive(message: string): void;
  disconnect(): void;
}

class Session {
  userId: string | undefined;
  /** The persistent API token the session authenticated with; its deletion closes the session. */
  apiTokenId: string | undefined;
  /** The user an `auth` command is rotating a token for; a revocation of that user clears it. */
  authenticating: string | undefined;
  /** The API token an `auth` command checks; its deletion clears {@link authenticating}. */
  authenticatingApiToken: string | undefined;
  gzip = false;
  closed = false;
  /** Every subscribed channel name, rooms included. */
  readonly channels = new Set<string>();
  readonly rooms = new Map<string, RoomSubscription>();
  #queuedCommands = 0;
  #commands: Promise<void> = Promise.resolve();
  #writes: Promise<void> = Promise.resolve();
  #pendingWrites = 0;

  constructor(
    readonly socket: RealtimeSocket,
    readonly report: (error: unknown) => void,
  ) {}

  /**
   * Writes are queueing up behind compression; room and map updates wait (their next diff
   * covers everything skipped) instead of piling up.
   */
  get backlogged(): boolean {
    return this.#pendingWrites > BACKLOG_LIMIT;
  }

  /** A protocol line the backend writes uncompressed (`time`, `protocol`, `auth ...`). */
  writeLine(line: string): void {
    this.#write(line, false);
  }

  send(message: string): void {
    this.#write(message, this.gzip);
  }

  /** Writes leave in call order, also when some of them are compressed asynchronously. */
  #write(message: string, gzip: boolean): void {
    if (this.closed) return;
    if (!gzip && this.#pendingWrites === 0) {
      this.socket.write(message);
      return;
    }
    this.#pendingWrites++;
    this.#writes = this.#writes
      .then(async () => {
        const frame = await encodeFrame(message, gzip);
        if (!this.closed) this.socket.write(frame);
      })
      .catch(this.report)
      .finally(() => {
        this.#pendingWrites--;
      });
  }

  /** Commands run one at a time in arrival order; `false` when too many are waiting. */
  enqueue(command: () => Promise<void>): boolean {
    if (this.#queuedCommands >= MAX_QUEUED_COMMANDS) return false;
    this.#queuedCommands++;
    this.#commands = this.#commands
      .then(command)
      .catch(this.report)
      .finally(() => {
        this.#queuedCommands--;
      });
    return true;
  }
}

interface RoomSubscription {
  readonly session: Session;
  readonly room: string;
  readonly userId: string;
  /** The room objects this client holds. */
  readonly mirror: RoomObjectsMirror;
  /** Users whose name and badge this client already received. */
  readonly knownUsers: Set<string>;
  /** The full room (with the built-in users) was sent. */
  started: boolean;
}

interface ChannelSubscribers {
  readonly spec: ChannelSpec;
  readonly sessions: Set<Session>;
}

/** Backend `user.js` memory watch: `""+Memory.a.b`, or `Incorrect memory path` when unreachable. */
function memoryPathValue(memory: unknown, path: string): string {
  let pointer = memory;
  try {
    for (const part of path.split('.')) {
      if (pointer === null || pointer === undefined) throw new TypeError(`Cannot read ${part}`);
      const container = Object(pointer) as object;
      pointer = Object.hasOwn(container, part) ? Reflect.get(container, part) : undefined;
    }
    return String(pointer);
  } catch {
    return 'Incorrect memory path';
  }
}

export class RealtimeHub {
  readonly #context: ApiContext;
  readonly #original: OriginalSocketBridge | undefined;
  readonly #sessions = new Set<Session>();
  /** Room subscriptions in subscription order (upstream's per-room subscriber lists). */
  readonly #rooms = new Set<RoomSubscription>();
  /** Room subscriptions counted per user by the latest update (upstream `usersLimit`). */
  #roomsPerUser = new Map<string, number>();
  /** Uniform `[0, 1)` source of the per-update room order (upstream `_.shuffle`). */
  readonly #random: () => number;
  readonly #channels = new Map<string, ChannelSubscribers>();
  /** Visuals of the latest committed tick (driver `ROOM_VISUAL` keys of `gameTime - 1`). */
  #visuals: { time: number; users: Record<string, Record<string, string>> } | undefined;
  /** Latest CPU report per user since the previous update (backend throttles user CPU channels). */
  readonly #pendingCpu = new Map<string, { cpu: number | 'error'; memory: number }>();
  #flushTimer: NodeJS.Timeout | undefined;
  #flushing = false;
  #flushRequested = false;
  #lastFlush = -Infinity;
  #closed = false;

  constructor(context: ApiContext, random: () => number = Math.random) {
    this.#context = context;
    this.#random = random;
    this.#original = context.mods ? new OriginalSocketBridge(context, context.mods) : undefined;
    context.events.on('tick', this.#onTick);
    context.events.on('message', this.#onMessage);
    context.events.on('reset', this.#onReset);
  }

  /** Starts a session (greeting `time` and `protocol`); `undefined` once the hub is closed. */
  connect(socket: RealtimeSocket): RealtimeConnection | undefined {
    if (this.#closed) return undefined;
    const session = new Session(socket, (error) => {
      this.#report(error);
    });
    this.#sessions.add(session);
    session.writeLine(`time ${String(this.#context.now())}`);
    session.writeLine(`protocol ${String(PROTOCOL)}`);
    return {
      receive: (message) => {
        if (session.closed) return;
        if (!session.enqueue(() => this.#handle(session, message))) {
          this.#disconnect(session);
          socket.close();
        }
      },
      disconnect: () => {
        this.#disconnect(session);
      },
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
    this.#context.events.off('tick', this.#onTick);
    this.#context.events.off('message', this.#onMessage);
    this.#context.events.off('reset', this.#onReset);
    this.#closeSessions();
    this.#original?.close();
  }

  #closeSessions(): void {
    for (const session of [...this.#sessions]) {
      this.#disconnect(session);
      session.socket.close();
    }
    this.#visuals = undefined;
    this.#pendingCpu.clear();
    this.#roomsPerUser = new Map();
  }

  #report(error: unknown): void {
    if (this.#closed || this.#context.events.listenerCount('error') === 0) return;
    this.#context.events.emit('error', error instanceof Error ? error : new Error(String(error)));
  }

  /** A queued state read; failures are reported, never thrown at the caller. */
  async #read(operation: () => void): Promise<void> {
    try {
      await this.#context.read(() => {
        if (!this.#closed) operation();
      });
    } catch (error) {
      this.#report(error);
    }
  }

  async #handle(session: Session, message: string): Promise<void> {
    if (session.closed) return;
    if (message.startsWith('subscribe ')) {
      await this.#subscribe(session, message.slice('subscribe '.length));
    } else if (message.startsWith('unsubscribe ')) {
      this.#unsubscribe(session, message.slice('unsubscribe '.length));
      this.#original?.unsubscribe(session, message.slice('unsubscribe '.length));
    } else if (message.startsWith('auth ')) {
      await this.#authenticate(session, message.slice('auth '.length));
    } else if (message === 'gzip on') {
      session.gzip = true;
    } else if (message === 'gzip off') {
      session.gzip = false;
    }
  }

  /*
   * Authentication. The token is checked under a read first so failed attempts never commit;
   * a valid session token is rotated (and the user marked online) in a mutation. A persistent
   * API token is never rotated: `auth ok` returns it unchanged. Any failure, or success as
   * another user, drops every subscription that needed the previous identity. A revocation of
   * the user or of the API token committed while the attempt is in flight fails the attempt.
   */

  async #authenticate(session: Session, token: string): Promise<void> {
    const context = this.#context;
    let userId: string | undefined;
    let apiTokenId: string | undefined;
    let issued: string | undefined;
    try {
      [userId, apiTokenId] = await context.read(() => [
        context.auth.check(token),
        context.auth.apiTokenId(token),
      ]);
      const candidate = userId;
      if (candidate !== undefined) {
        session.authenticating = candidate;
        session.authenticatingApiToken = apiTokenId;
        issued = await context.mutate(() => {
          if (context.auth.check(token) !== candidate) return undefined;
          const profile = context.state.profiles[candidate];
          if (profile) profile.lastOnline = context.now();
          return apiTokenId === undefined ? context.auth.issue(candidate) : token;
        });
        if (session.authenticating !== candidate) issued = undefined;
      }
    } catch (error) {
      this.#report(error);
      issued = undefined;
    } finally {
      session.authenticating = undefined;
      session.authenticatingApiToken = undefined;
    }
    if (session.closed) return;
    if (userId === undefined || issued === undefined) {
      this.#dropAuthenticated(session);
      session.userId = undefined;
      session.apiTokenId = undefined;
      session.writeLine('auth failed');
      return;
    }
    if (session.userId !== userId) this.#dropAuthenticated(session);
    session.userId = userId;
    session.apiTokenId = apiTokenId;
    session.writeLine(`auth ok ${issued}`);
  }

  #dropAuthenticated(session: Session): void {
    this.#original?.disconnect(session);
    for (const channel of [...session.channels]) {
      if (channel !== 'server-message') this.#unsubscribe(session, channel);
    }
  }

  /*
   * Subscriptions.
   */

  async #subscribe(session: Session, channel: string, module?: BuiltinSocketModule): Promise<void> {
    if (this.#original && module === undefined) {
      await this.#original.subscribe(
        session,
        channel,
        (kind, name) => this.#subscribe(session, name, kind),
        (name) => {
          this.#unsubscribe(session, name);
        },
      );
      return;
    }
    const spec = parseChannel(channel);
    if (!spec || !canSubscribe(spec, session.userId) || session.channels.has(channel)) return;
    if (module !== undefined) {
      const owner: BuiltinSocketModule =
        spec.kind === 'server-message'
          ? 'system'
          : spec.kind === 'room'
            ? 'rooms'
            : spec.kind === 'roomMap'
              ? 'map'
              : 'user';
      if (module !== owner) return;
    }
    session.channels.add(channel);
    if (spec.kind === 'server-message' || spec.kind === 'user') {
      this.#listen(session, channel, spec);
      return;
    }
    // Every other channel requires the identity `canSubscribe` just checked.
    const { userId } = session;
    if (userId === undefined) return;
    await this.#read(() => {
      if (session.closed || !session.channels.has(channel)) return;
      const { state, runtime } = this.#context;
      const world = state.world;
      switch (spec.kind) {
        case 'room':
          this.#subscribeRoom(session, userId, spec.room);
          return;
        case 'roomMap':
          this.#listen(session, channel, spec);
          session.send(eventMessage(channel, world.mapViews[spec.room] ?? {}));
          return;
        case 'mapVisual':
          this.#listen(session, channel, spec);
          session.send(eventMessage(channel, this.#visual(userId, 'map', world.gameTime) ?? null));
          return;
        case 'cpu': {
          this.#listen(session, channel, spec);
          const memory = runtime.getMemory(userId);
          if (memory) session.send(eventMessage(channel, { cpu: 0, memory: memory.length }));
          return;
        }
        case 'resources': {
          this.#listen(session, channel, spec);
          const user = world.users[userId];
          if (user)
            session.send(
              eventMessage(channel, { ...user.resources, credits: (user.money ?? 0) / 1000 }),
            );
          return;
        }
        case 'memory': {
          this.#listen(session, channel, spec);
          if (!this.#memoryPaths(userId).includes(spec.path)) return;
          const raw = runtime.getMemory(userId);
          if (!raw) return;
          let memory: unknown;
          try {
            memory = JSON.parse(raw);
          } catch {
            return;
          }
          session.send(eventMessage(channel, memoryPathValue(memory, spec.path)));
          return;
        }
      }
    });
  }

  #listen(session: Session, channel: string, spec: ChannelSpec): void {
    let subscribers = this.#channels.get(channel);
    if (!subscribers) {
      subscribers = { spec, sessions: new Set() };
      this.#channels.set(channel, subscribers);
    }
    subscribers.sessions.add(session);
  }

  #unsubscribe(session: Session, channel: string): void {
    if (!session.channels.delete(channel)) return;
    const spec = parseChannel(channel);
    if (spec?.kind === 'room') {
      const subscription = session.rooms.get(spec.room);
      if (subscription) {
        session.rooms.delete(spec.room);
        this.#rooms.delete(subscription);
      }
      return;
    }
    const subscribers = this.#channels.get(channel);
    if (!subscribers) return;
    subscribers.sessions.delete(session);
    if (!subscribers.sessions.size) this.#channels.delete(channel);
  }

  #disconnect(session: Session): void {
    if (session.closed) return;
    this.#original?.disconnect(session);
    for (const channel of [...session.channels]) this.#unsubscribe(session, channel);
    session.closed = true;
    this.#sessions.delete(session);
  }

  /** Memory paths of a user that updates evaluate (the first ones subscribed). */
  #memoryPaths(userId: string): string[] {
    const paths: string[] = [];
    for (const { spec } of this.#channels.values()) {
      if (spec.kind === 'memory' && spec.userId === userId) {
        paths.push(spec.path);
        if (paths.length === MEMORY_PATHS_PER_USER) break;
      }
    }
    return paths;
  }

  /*
   * Rooms (backend `rooms.js`). Each subscription mirrors the client's objects, so every update
   * is an exact diff from what that client holds, however many ticks it skipped.
   */

  /**
   * Within a read: register and send the full room. Like upstream, a user whose subscriptions
   * exceeded the limit at the latest update waits for an update to select it instead.
   */
  #subscribeRoom(session: Session, userId: string, room: string): void {
    // Unknown rooms are silently ignored like upstream (`invalid room`).
    if (!this.#context.state.world.rooms[room]) return;
    const subscription: RoomSubscription = {
      session,
      room,
      userId,
      mirror: new RoomObjectsMirror(),
      knownUsers: new Set(Object.keys(BUILTIN_USERS)),
      started: false,
    };
    session.rooms.set(room, subscription);
    this.#rooms.add(subscription);
    if ((this.#roomsPerUser.get(userId) ?? 0) > USER_ROOM_LIMIT) {
      session.send(eventMessage(`err@room:${room}`, 'subscribe limit reached'));
      return;
    }
    this.#sendRoom(subscription, this.#roomObjects(new Set([room])).get(room));
  }

  /**
   * Within a read: the `room:` event bringing the client to the room's current state. The first
   * one is the full room with the built-in users; later ones carry users not yet sent.
   */
  #sendRoom(
    subscription: RoomSubscription,
    objects: ReadonlyMap<string, JsonObject> = new Map(),
  ): void {
    const { room, userId, session } = subscription;
    const world = this.#context.state.world;
    const update: Record<string, unknown> = {
      objects: subscription.mirror.update(objects),
      flags: Object.values(world.flags).find(
        (flags) => flags.room === room && flags.user === userId,
      )?.data,
      gameTime: world.gameTime,
      visual: this.#roomVisual(userId, room, world.gameTime),
    };
    const users = this.#newUsers(subscription, objects);
    if (!subscription.started) Object.assign(users, BUILTIN_USERS);
    if (Object.keys(users).length) update.users = users;
    if (!subscription.started || WORLD_ROOM.test(room)) update.info = { mode: 'world' };
    subscription.started = true;
    session.send(eventMessage(`room:${room}`, update));
  }

  /** JSON objects of the given rooms keyed by id, from one pass over the world. */
  #roomObjects(rooms: ReadonlySet<string>): Map<string, Map<string, JsonObject>> {
    const grouped = new Map<string, Array<[string, unknown]>>();
    if (!rooms.size) return new Map();
    for (const object of Object.values(this.#context.state.world.roomObjects)) {
      if (!rooms.has(object.room)) continue;
      let list = grouped.get(object.room);
      if (!list) {
        list = [];
        grouped.set(object.room, list);
      }
      list.push([object._id, object]);
    }
    const result = new Map<string, Map<string, JsonObject>>();
    for (const [room, list] of grouped) result.set(room, jsonObjects(list));
    return result;
  }

  /** Name and badge of users referenced by the objects that this client does not know yet. */
  #newUsers(
    subscription: RoomSubscription,
    objects: ReadonlyMap<string, JsonObject>,
  ): Record<string, unknown> {
    const { users } = this.#context.state.world;
    const result: Record<string, unknown> = {};
    for (const object of objects.values()) {
      const { user, reservation, sign } = object;
      for (const id of [
        user,
        isRecord(reservation) ? reservation.user : undefined,
        isRecord(sign) ? sign.user : undefined,
      ]) {
        if (typeof id !== 'string' || subscription.knownUsers.has(id)) continue;
        subscription.knownUsers.add(id);
        const doc = users[id];
        if (doc) result[id] = { _id: doc._id, username: doc.username, badge: doc.badge };
      }
    }
    return result;
  }

  #visual(userId: string, key: string, gameTime: number): string | undefined {
    const visuals = this.#visuals;
    return visuals?.time === gameTime - 1 ? visuals.users[userId]?.[key] : undefined;
  }

  /** Room visual sent with room updates: the user's global visual then the room's. */
  #roomVisual(userId: string, room: string, gameTime: number): string {
    return (
      (this.#visual(userId, '', gameTime) ?? '') + (this.#visual(userId, room, gameTime) ?? '')
    );
  }

  /*
   * Events.
   */

  readonly #onTick = (event: TickEvent): void => {
    if (this.#closed) return;
    const visuals: Record<string, Record<string, string>> = {};
    for (const [userId, result] of Object.entries(event.runtime.users)) {
      visuals[userId] = result.visual;
      const error = result.console.error;
      this.#pendingCpu.set(userId, {
        cpu: error !== undefined && CPU_LIMIT_ERROR.test(error) ? 'error' : result.cpu.used,
        memory: result.memorySize,
      });
      // Driver `sendConsoleMessages` (every run, which also clears the client's error marker)
      // and `sendConsoleError`; built-in NPC consoles are never published.
      const channel = `user:${userId}/console`;
      if (userId in BUILTIN_USERS || !this.#channels.has(channel)) continue;
      const { log, results } = result.console;
      if (log.length || results.length || error === undefined) {
        this.#emit(channel, {
          messages: {
            log: log.map((item) => (item.escape ? htmlEncode(item.message) : item.message)),
            results,
          },
        });
      }
      if (error) this.#emit(channel, { error });
    }
    this.#visuals = { time: event.simulation.gameTime, users: visuals };
    this.#requestFlush();
  };

  /** `context.publish` messages: upstream pubsub channel names with parsed payloads. */
  readonly #onMessage = (channel: string, data: unknown): void => {
    if (this.#closed) return;
    if (channel === 'serverMessage') {
      this.#emit('server-message', data);
      return;
    }
    if (channel === 'auth:revoked') {
      // The user's tokens were revoked (password change, deletion) by a committed mutation: end
      // their sessions, so a reconnecting client must authenticate again with a valid token.
      // With `apiToken`, only that persistent API token was deleted: end only its sessions.
      if (!isRecord(data) || typeof data.user !== 'string') return;
      const apiToken = typeof data.apiToken === 'string' ? data.apiToken : undefined;
      for (const session of [...this.#sessions]) {
        if (
          session.authenticating === data.user &&
          (apiToken === undefined || session.authenticatingApiToken === apiToken)
        ) {
          session.authenticating = undefined;
        }
        if (session.userId !== data.user) continue;
        if (apiToken !== undefined && session.apiTokenId !== apiToken) continue;
        this.#disconnect(session);
        session.socket.close();
      }
      return;
    }
    const spec = parseChannel(channel);
    if (spec?.kind !== 'user' || !this.#channels.has(channel)) return;
    if (channel !== `user:${spec.userId}/code`) {
      this.#emit(channel, data);
      return;
    }
    // `{id, hash}` of the saved branch; subscribers receive the branch as committed.
    if (!isRecord(data) || typeof data.id !== 'string') return;
    const id = data.id;
    const hash = data.hash;
    void this.#read(() => {
      const branch = this.#context.state.branches[id];
      if (branch?.user !== spec.userId) return;
      this.#emit(channel, {
        branch: branch.branch,
        modules: branch.modules,
        timestamp: branch.timestamp,
        hash,
      });
    });
  };

  /** The world was replaced: identities and cached views may no longer be valid. */
  readonly #onReset = (): void => {
    if (this.#closed) return;
    this.#closeSessions();
  };

  #emit(channel: string, data: unknown): void {
    const subscribers = this.#channels.get(channel);
    if (!subscribers) return;
    const message = eventMessage(channel, data);
    for (const session of subscribers.sessions) session.send(message);
  }

  /*
   * Updates after ticks (backend `roomsDone` listeners), at most once per `socketUpdateThrottle`.
   */

  #requestFlush(): void {
    if (this.#closed || this.#flushTimer !== undefined) return;
    if (this.#flushing) {
      // The running flush may have read the world before this tick: another one follows it.
      this.#flushRequested = true;
      return;
    }
    const delay = Math.max(
      0,
      this.#lastFlush + this.#context.config.socketUpdateThrottle - performance.now(),
    );
    this.#flushTimer = setTimeout(() => {
      void this.#runFlush();
    }, delay);
  }

  async #runFlush(): Promise<void> {
    this.#flushTimer = undefined;
    this.#flushing = true;
    this.#lastFlush = performance.now();
    await this.#read(() => {
      this.#flush();
    });
    this.#flushing = false;
    if (this.#flushRequested) {
      this.#flushRequested = false;
      this.#requestFlush();
    }
  }

  #flush(): void {
    const { state, runtime } = this.#context;
    const world = state.world;
    const { gameTime } = world;

    // Upstream `rooms.js`: rooms in a new random order each update, each room's subscribers in
    // subscription order; a user's subscriptions beyond the limit are skipped with an error.
    const subscriptionsByRoom = new Map<string, RoomSubscription[]>();
    for (const subscription of this.#rooms) {
      const subscriptions = subscriptionsByRoom.get(subscription.room);
      if (subscriptions) subscriptions.push(subscription);
      else subscriptionsByRoom.set(subscription.room, [subscription]);
    }
    // lodash `_.shuffle` (inside-out Fisher-Yates).
    const rooms: RoomSubscription[][] = [];
    for (const subscriptions of subscriptionsByRoom.values()) {
      const swap = Math.floor(this.#random() * (rooms.length + 1));
      rooms.push(rooms[swap] ?? subscriptions);
      rooms[swap] = subscriptions;
    }
    const served: RoomSubscription[] = [];
    const roomsPerUser = new Map<string, number>();
    for (const subscription of rooms.flat()) {
      const count = (roomsPerUser.get(subscription.userId) ?? 0) + 1;
      roomsPerUser.set(subscription.userId, count);
      if (count > USER_ROOM_LIMIT) {
        subscription.session.send(
          eventMessage(`err@room:${subscription.room}`, 'subscribe limit reached'),
        );
        continue;
      }
      // A connection still compressing earlier updates gets the accumulated diff next time.
      if (!subscription.session.backlogged) served.push(subscription);
    }
    this.#roomsPerUser = roomsPerUser;
    const objectsByRoom = this.#roomObjects(new Set(served.map(({ room }) => room)));
    for (const subscription of served)
      this.#sendRoom(subscription, objectsByRoom.get(subscription.room));

    const memoryWatchers = new Map<
      string,
      Array<[path: string, channel: string, sessions: Set<Session>]>
    >();
    for (const [channel, { spec, sessions }] of this.#channels) {
      switch (spec.kind) {
        case 'roomMap': {
          const message = eventMessage(channel, world.mapViews[spec.room] ?? {});
          for (const session of sessions) if (!session.backlogged) session.send(message);
          break;
        }
        case 'mapVisual': {
          const message = eventMessage(channel, this.#visual(spec.userId, 'map', gameTime) ?? null);
          for (const session of sessions) session.send(message);
          break;
        }
        case 'resources': {
          const user = world.users[spec.userId];
          if (!user) break;
          const message = eventMessage(channel, {
            ...user.resources,
            credits: (user.money ?? 0) / 1000,
          });
          for (const session of sessions) session.send(message);
          break;
        }
        case 'cpu': {
          const report = this.#pendingCpu.get(spec.userId);
          if (!report) break;
          const message = eventMessage(channel, report);
          for (const session of sessions) session.send(message);
          break;
        }
        case 'memory': {
          let watchers = memoryWatchers.get(spec.userId);
          if (!watchers) {
            watchers = [];
            memoryWatchers.set(spec.userId, watchers);
          }
          if (watchers.length < MEMORY_PATHS_PER_USER)
            watchers.push([spec.path, channel, sessions]);
          break;
        }
        default:
          break;
      }
    }
    this.#pendingCpu.clear();

    for (const [userId, watchers] of memoryWatchers) {
      const raw = runtime.getMemory(userId);
      if (!raw) continue;
      let memory: unknown;
      try {
        memory = JSON.parse(raw);
      } catch {
        continue;
      }
      for (const [path, channel, sessions] of watchers) {
        const message = eventMessage(channel, memoryPathValue(memory, path));
        for (const session of sessions) session.send(message);
      }
    }
  }
}
