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
    allowRegistration: true,
    welcomeText: '<h4>OpenScreeps</h4><p>A standalone Screeps world.</p>',
    historyChunkSize: 20,
    historyTicks: 1000,
    commitTicks: 10,
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
    ['commitTicks', 1, 100000],
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
  for (const [key, minimum, maximum] of [
    ['cliPort', 0, 65535],
    ['runnerCount', 1, 256],
    ['runnerThreads', 1, 256],
    ['processorCount', 1, 256],
    ['workerRestartInterval', 0, 365 * 24 * 60 * 60],
    ['logRotateKeep', 0, 1000],
  ] as const) {
    const value = config[key];
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    ) {
      throw new Error(
        `Invalid ${key}: expected an integer from ${String(minimum)} to ${String(maximum)}`,
      );
    }
  }
  if (config.cliPort !== undefined) config.cliHost ??= '127.0.0.1';
  if (!config.host || !config.database || !/^[A-Za-z0-9_-]{1,64}$/.test(config.shardName)) {
    throw new Error('Invalid host, database, or shard name');
  }
  if (config.databaseUrl !== undefined) {
    const protocol = URL.parse(config.databaseUrl)?.protocol;
    // Never echo the URL: it usually carries the database password.
    if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
      throw new Error('Invalid databaseUrl: expected a postgres:// or postgresql:// URL');
    }
  }
  if (config.adminToken !== undefined && config.adminToken.length < 32) {
    throw new Error('The admin token must contain at least 32 characters');
  }
  if (config.assetDirectory !== undefined) config.assetDirectory = resolve(config.assetDirectory);
  for (const key of ['modFile', 'originalDatabase', 'logDirectory', 'steamGreenworks'] as const) {
    if (config[key] !== undefined) config[key] = resolve(config[key]);
  }
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
      | 'databaseUrl'
      | 'shardName'
      | 'serverPassword'
      | 'adminToken'
      | 'steamKey'
      | 'assetDirectory'
      | 'steamGreenworks'
      | 'modFile'
      | 'originalDatabase'
      | 'cliHost'
      | 'logDirectory'
    >
  > = {
    GAME_HOST: 'host',
    SCREEPS_DATABASE: 'database',
    SCREEPS_DATABASE_URL: 'databaseUrl',
    SHARD_NAME: 'shardName',
    SERVER_PASSWORD: 'serverPassword',
    SCREEPS_ADMIN_TOKEN: 'adminToken',
    STEAM_KEY: 'steamKey',
    ASSET_DIR: 'assetDirectory',
    STEAM_GREENWORKS: 'steamGreenworks',
    MODFILE: 'modFile',
    DB_PATH: 'originalDatabase',
    CLI_HOST: 'cliHost',
    SCREEPS_LOG_DIRECTORY: 'logDirectory',
  };
  for (const [name, key] of Object.entries(text)) {
    const value = environment[name];
    if (value !== undefined) config[key] = value;
  }
  const numbers: Record<
    string,
    keyof Pick<
      ServerConfig,
      | 'port'
      | 'tickDuration'
      | 'worldSize'
      | 'seed'
      | 'historyTicks'
      | 'commitTicks'
      | 'cliPort'
      | 'runnerCount'
      | 'runnerThreads'
      | 'processorCount'
      | 'workerRestartInterval'
      | 'logRotateKeep'
    >
  > = {
    GAME_PORT: 'port',
    SCREEPS_TICK_DURATION: 'tickDuration',
    SCREEPS_WORLD_SIZE: 'worldSize',
    SCREEPS_SEED: 'seed',
    SCREEPS_HISTORY_TICKS: 'historyTicks',
    SCREEPS_COMMIT_TICKS: 'commitTicks',
    CLI_PORT: 'cliPort',
    RUNNERS_CNT: 'runnerCount',
    RUNNER_THREADS: 'runnerThreads',
    PROCESSORS_CNT: 'processorCount',
    SCREEPS_WORKER_RESTART_INTERVAL: 'workerRestartInterval',
    SCREEPS_LOG_ROTATE_KEEP: 'logRotateKeep',
  };
  for (const [name, key] of Object.entries(numbers)) {
    const value = environment[name];
    if (value !== undefined) config[key] = Number(value);
  }
  for (const [name, key] of Object.entries({
    SCREEPS_PAUSED: 'paused',
    SCREEPS_ALLOW_REGISTRATION: 'allowRegistration',
  } as const)) {
    const value = environment[name];
    if (value === undefined) continue;
    if (!['true', 'false', '1', '0'].includes(value)) {
      throw new Error(`${name} must be true, false, 1, or 0`);
    }
    config[key] = ['true', '1'].includes(value);
  }
  return config;
}
