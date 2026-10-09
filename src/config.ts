import { resolve } from 'node:path';
import type { ServerConfig } from './contracts.ts';

export function createConfig(options: Partial<ServerConfig> = {}): ServerConfig {
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 21025,
    database: resolve('data/world.sqlite'),
    tickDuration: 1000,
    paused: false,
    worldSize: 21,
    seed: 1,
    shardName: 'shard0',
    welcomeText: '<h4>OpenScreeps</h4><p>A standalone Screeps world.</p>',
    historyChunkSize: 20,
    historyTicks: 1000,
    socketUpdateThrottle: 200,
    tokenLifetimeMs: 60 * 1000,
    ...options,
  };
  for (const [key, minimum, maximum] of [
    ['port', 0, 65535],
    ['tickDuration', 1, 3600000],
    ['worldSize', 1, 256],
    ['seed', 0, 0xffffffff],
    ['historyChunkSize', 1, 1000],
    ['historyTicks', 0, 100000],
    ['socketUpdateThrottle', 0, 60000],
    ['tokenLifetimeMs', 1000, 365 * 24 * 60 * 60 * 1000],
  ] as const) {
    const value = config[key];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(
        `Invalid ${key}: expected an integer from ${String(minimum)} to ${String(maximum)}`,
      );
    }
  }
  if (!config.host || !config.database || !/^[A-Za-z0-9_-]{1,64}$/.test(config.shardName)) {
    throw new Error('Invalid host, database, or shard name');
  }
  if (config.adminToken !== undefined && config.adminToken.length < 32) {
    throw new Error('The admin token must contain at least 32 characters');
  }
  if (config.assetDirectory !== undefined) config.assetDirectory = resolve(config.assetDirectory);
  return config;
}

/** Environment settings intentionally map to the official standalone server's common names. */
export function configFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Partial<ServerConfig> {
  const config: Partial<ServerConfig> = {};
  const text: Record<
    string,
    keyof Pick<
      ServerConfig,
      | 'host'
      | 'database'
      | 'shardName'
      | 'serverPassword'
      | 'adminToken'
      | 'steamKey'
      | 'assetDirectory'
    >
  > = {
    GAME_HOST: 'host',
    SCREEPS_DATABASE: 'database',
    SHARD_NAME: 'shardName',
    SERVER_PASSWORD: 'serverPassword',
    SCREEPS_ADMIN_TOKEN: 'adminToken',
    STEAM_KEY: 'steamKey',
    ASSET_DIR: 'assetDirectory',
  };
  for (const [name, key] of Object.entries(text)) {
    const value = environment[name];
    if (value !== undefined) config[key] = value;
  }
  const numbers: Record<
    string,
    keyof Pick<ServerConfig, 'port' | 'tickDuration' | 'worldSize' | 'seed' | 'historyTicks'>
  > = {
    GAME_PORT: 'port',
    SCREEPS_TICK_DURATION: 'tickDuration',
    SCREEPS_WORLD_SIZE: 'worldSize',
    SCREEPS_SEED: 'seed',
    SCREEPS_HISTORY_TICKS: 'historyTicks',
  };
  for (const [name, key] of Object.entries(numbers)) {
    const value = environment[name];
    if (value !== undefined) config[key] = Number(value);
  }
  if (environment.SCREEPS_PAUSED !== undefined) {
    if (!['true', 'false', '1', '0'].includes(environment.SCREEPS_PAUSED)) {
      throw new Error('SCREEPS_PAUSED must be true, false, 1, or 0');
    }
    config.paused = ['true', '1'].includes(environment.SCREEPS_PAUSED);
  }
  return config;
}
