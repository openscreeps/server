import type { JsonObject } from '@openscreeps/game';
import type { ApiContext } from '../contracts.ts';
import { eventMessage } from '../realtime/encode.ts';
import { parseChannel } from '../realtime/channels.ts';
import type {
  OriginalMods,
  OriginalSocketConnection,
  OriginalSocketFactory,
  OriginalSocketModule,
} from './original-mods.ts';

export type BuiltinSocketModule = 'system' | 'rooms' | 'user' | 'map';

/** Real built-in dispatch remains in RealtimeHub; replacing/deleting a registry entry disables it. */
export function originalBuiltinSocketModules(): Record<string, OriginalSocketFactory> {
  const result: Record<string, OriginalSocketFactory> = {};
  for (const name of ['system', 'rooms', 'user', 'map'] as const) {
    result[name] = () => ({
      async onSubscribe(channel, _user, connection) {
        await connection.subscribeBuiltin(name, channel);
        return false;
      },
      onUnsubscribe(channel, _user, connection) {
        connection.unsubscribeBuiltin(channel);
      },
    });
  }
  return result;
}

export interface OriginalSocketPeer {
  userId: string | undefined;
  closed: boolean;
  send(message: string): void;
  writeLine(message: string): void;
  socket: { write(message: string): unknown; close(): unknown };
}

interface PeerState {
  connection: OriginalSocketConnection;
  channels: Set<string>;
}

/** Original socket factories share an emit bus and regexp-filtered original pubsub. */
export class OriginalSocketBridge {
  readonly #modules: OriginalSocketModule[];
  readonly #peers = new Map<OriginalSocketPeer, PeerState>();
  readonly #unsubscribe: () => void;

  constructor(
    readonly context: ApiContext,
    mods: OriginalMods,
  ) {
    const listeners: Array<{
      pattern: RegExp;
      listener: (data: unknown, match: RegExpExecArray) => void;
    }> = [];
    this.#modules = Object.values(mods.backend.socketModules).map((factory) =>
      factory(
        (pattern, listener) => {
          listeners.push({ pattern, listener });
        },
        (channel, data) => {
          const message = eventMessage(channel, data);
          for (const [peer, state] of this.#peers) {
            if (!peer.closed && state.channels.has(channel)) peer.send(message);
          }
        },
      ),
    );
    const report = (error: unknown): void => {
      context.events.emit('error', error instanceof Error ? error : new Error(String(error)));
    };
    this.#unsubscribe = mods.storage.pubsub.subscribe('*', function (data) {
      for (const { pattern, listener } of listeners) {
        pattern.lastIndex = 0;
        const match = pattern.exec(this.channel);
        if (!match) continue;
        try {
          listener(data, match);
        } catch (error) {
          report(error);
        }
      }
    });
  }

  async subscribe(
    peer: OriginalSocketPeer,
    channel: string,
    subscribeBuiltin: (module: BuiltinSocketModule, channel: string) => Promise<void>,
    unsubscribeBuiltin: (channel: string) => void,
  ): Promise<void> {
    // A trusted mod may add public channels, but may not accidentally weaken the private namespace.
    if (channel.startsWith('user:')) {
      const owner = /^user:([^/]+)\//.exec(channel)?.[1];
      if (!owner || owner !== peer.userId) return;
    }
    const spec = parseChannel(channel);
    if (spec?.kind === 'mapVisual' && spec.userId !== peer.userId) return;
    let state = this.#peers.get(peer);
    if (!state) {
      const connection: OriginalSocketConnection = {
        get readyState() {
          return peer.closed ? 3 : 1;
        },
        write: (message) => {
          peer.writeLine(message);
        },
        close: () => peer.socket.close(),
        _writeEvent: (name, data) => {
          peer.send(eventMessage(name, data));
        },
        _writeEventRaw: (message) => {
          peer.send(message);
        },
        subscribeBuiltin,
        unsubscribeBuiltin,
      };
      state = { connection, channels: new Set() };
      this.#peers.set(peer, state);
    }
    if (state.channels.has(channel)) return;
    const user = await this.#user(peer);
    for (const module of this.#modules) {
      if (await module.onSubscribe(channel, user, state.connection)) state.channels.add(channel);
    }
  }

  async #user(peer: OriginalSocketPeer): Promise<JsonObject | null> {
    return this.context.read(() => {
      const user =
        peer.userId === undefined ? undefined : this.context.state.world.users[peer.userId];
      if (!user) return null;
      return { ...user, ...this.context.state.profiles[user._id] } as unknown as JsonObject;
    });
  }

  unsubscribe(peer: OriginalSocketPeer, channel: string): void {
    const state = this.#peers.get(peer);
    if (!state) return;
    state.channels.delete(channel);
    void this.#user(peer)
      .then(async (user) => {
        for (const module of this.#modules)
          await module.onUnsubscribe?.(channel, user, state.connection);
      })
      .catch((error: unknown) => {
        this.context.events.emit(
          'error',
          error instanceof Error ? error : new Error(String(error)),
        );
      });
  }

  disconnect(peer: OriginalSocketPeer): void {
    const state = this.#peers.get(peer);
    if (!state) return;
    for (const channel of state.channels) this.unsubscribe(peer, channel);
    this.#peers.delete(peer);
  }

  close(): void {
    this.#unsubscribe();
    this.#peers.clear();
  }
}
