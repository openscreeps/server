import { createRequire } from 'node:module';
import {
  isRecord,
  type WorkerHost,
  type WorkerHostCall,
  type WorkerSetup,
} from '@openscreeps/game';
import { createConfig } from '../config.ts';
import { OriginalMods } from './original-mods.ts';
import type { OriginalPromise, OriginalStorage } from './original-storage.ts';

const require = createRequire(import.meta.url);
const q = require('q') as { resolve<T>(value: T | PromiseLike<T>): OriginalPromise<T> };
const COLLECTION_METHODS = [
  'find',
  'findOne',
  'by',
  'count',
  'clear',
  'ensureIndex',
  'removeWhere',
  'insert',
  'update',
  'bulk',
  'findEx',
];
const ENV_METHODS = [
  'get',
  'mget',
  'set',
  'setex',
  'expire',
  'ttl',
  'del',
  'hmget',
  'hmset',
  'hget',
  'hset',
  'sadd',
  'smembers',
];
const QUEUE_METHODS = ['fetch', 'add', 'addMulti', 'markDone', 'whenAllDone', 'reset'];

/** Dispatch only the original storage API, never arbitrary worker-selected host methods. */
export function callOriginalStorage(storage: OriginalStorage, call: WorkerHostCall): unknown {
  if (call.method === 'storage.describe') {
    return {
      collections: Object.keys(storage.db),
      envKeys: storage.env.keys,
      pubsubKeys: storage.pubsub.keys,
    };
  }
  const request = call.args[0];
  if (
    call.method !== 'storage.invoke' ||
    !isRecord(request) ||
    typeof request.method !== 'string' ||
    !Array.isArray(request.args)
  ) {
    throw new Error('Invalid original storage call');
  }
  let target: unknown;
  let methods: readonly string[];
  switch (request.section) {
    case 'db':
      if (
        typeof request.collection !== 'string' ||
        !Object.hasOwn(storage.db, request.collection)
      ) {
        throw new Error('Unknown original storage collection');
      }
      target = storage.db[request.collection];
      methods = COLLECTION_METHODS;
      break;
    case 'env':
      target = storage.env;
      methods = ENV_METHODS;
      break;
    case 'queue':
      target = storage.queue;
      methods = QUEUE_METHODS;
      break;
    case 'pubsub':
      target = storage.pubsub;
      methods = ['publish'];
      break;
    case 'storage':
      target = storage;
      methods = ['resetAllData'];
      break;
    default:
      throw new Error('Unknown original storage section');
  }
  if (!methods.includes(request.method) || !isRecord(target))
    throw new Error('Unknown original storage method');
  const method: unknown = Reflect.get(target, request.method);
  if (typeof method !== 'function') throw new Error('Unavailable original storage method');
  return Reflect.apply(method, target, request.args) as unknown;
}

/** Trusted worker mods use the same canonical storage via asynchronous IPC, never a shadow world. */
export default async function setup(
  data: unknown,
  kind: 'runner' | 'processor',
  host: WorkerHost,
): Promise<WorkerSetup> {
  if (!isRecord(data)) throw new Error('Invalid original worker configuration');
  const description = await host.call('storage.describe');
  if (
    !isRecord(description) ||
    !Array.isArray(description.collections) ||
    !isRecord(description.envKeys) ||
    !isRecord(description.pubsubKeys)
  ) {
    throw new Error('Original storage host returned an invalid description');
  }
  const remote = (
    section: string,
    collection: string | undefined,
    method: string,
    args: unknown[],
  ) => q.resolve(host.call('storage.invoke', { section, collection, method, args }));
  const db: Record<string, Record<string, (...args: unknown[]) => OriginalPromise<unknown>>> = {};
  for (const collection of description.collections as unknown[]) {
    if (typeof collection !== 'string') throw new Error('Invalid original collection name');
    const methods: Record<string, (...args: unknown[]) => OriginalPromise<unknown>> = {};
    for (const method of COLLECTION_METHODS) {
      methods[method] = (...args) => remote('db', collection, method, args);
    }
    Object.defineProperty(db, collection, { value: methods, enumerable: true, configurable: true });
  }
  const env: Record<string, unknown> = { keys: description.envKeys };
  for (const method of ENV_METHODS)
    env[method] = (...args: unknown[]) => remote('env', undefined, method, args);
  const queue: Record<string, unknown> = {};
  for (const method of QUEUE_METHODS)
    queue[method] = (...args: unknown[]) => remote('queue', undefined, method, args);
  const storage = {
    db,
    env,
    queue,
    pubsub: {
      keys: description.pubsubKeys,
      publish: (channel: string, payload: unknown) =>
        remote('pubsub', undefined, 'publish', [channel, payload]),
      subscribe(channel: string, callback: (this: { channel: string }, data: unknown) => void) {
        return host.on('original-pubsub', (event: unknown) => {
          if (!isRecord(event) || typeof event.channel !== 'string') return;
          if (channel === '*' || channel === event.channel)
            callback.call({ channel: event.channel }, event.data);
        });
      },
    },
    _connected: true,
    _connect: () => q.resolve(undefined),
    resetAllData: () => remote('storage', undefined, 'resetAllData', []),
  } as unknown as OriginalStorage;
  const config = createConfig(data);
  const mods = new OriginalMods(config, kind, storage);
  mods.engine.emit('init', kind);
  return {
    ...(kind === 'runner' ? { playerSandbox: mods.runtimeOptions.playerSandbox } : {}),
    ...(kind === 'processor' ? { hooks: mods.simulationHooks } : {}),
  };
}
