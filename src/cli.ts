#!/usr/bin/env node
/*
 * Operator command line: `init` and `start` run on the server host against the world database (a
 * SQLite file, or PostgreSQL with a database URL); every other command is a typed request to the
 * authenticated `POST /admin` API of a running server. Secrets (admin token, passwords, database
 * credentials) are never printed.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { open, readFile, rename, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { loadBotModules, type JsonObject, type JsonValue } from '@openscreeps/game';
import { isRecord } from './api/guards.ts';
import { createUser } from './api/users.ts';
import { configFromEnvironment, createConfig } from './config.ts';
import type { ServerConfig, ServerState } from './contracts.ts';
import { databaseLabel } from './database.ts';
import { ServerKernel } from './services/server-kernel.service.ts';
import { StateStore } from './services/state-store.service.ts';
import { createServer, type RunningServer } from './server.ts';
import { originalConfig } from './compatibility/original-config.ts';

const PROGRAM = 'openscreeps-server';
const MINIMUM_TOKEN_LENGTH = 32;

/** Invalid command-line usage; reported with a pointer to the help text and exit status 2. */
export class UsageError extends Error {}

interface OptionDefinition {
  readonly type: 'string' | 'boolean';
  /** Placeholder shown in help for string options. */
  readonly value?: string;
  readonly help: string;
}
type OptionTable = Readonly<Record<string, OptionDefinition>>;

export interface Invocation {
  readonly positionals: readonly string[];
  readonly values: Readonly<Record<string, unknown>>;
  readonly environment: NodeJS.ProcessEnv;
}

interface CommandBase {
  readonly arguments: string;
  readonly summary: string;
  /** Command-specific options; shared server or connection options are added by kind. */
  readonly options: OptionTable;
  readonly positionals: readonly [minimum: number, maximum: number];
}
interface LocalCommand extends CommandBase {
  readonly kind: 'local';
  run(input: Invocation): Promise<void>;
}
interface RemoteCommand extends CommandBase {
  readonly kind: 'remote';
  /** Admin API request body `{action, ...arguments}`. */
  request(input: Invocation): JsonObject | Promise<JsonObject>;
  /** Consumes a successful `{ok: 1, ...}` response; default prints it as JSON. */
  handle?(result: JsonObject, input: Invocation): Promise<void>;
}
type Command = LocalCommand | RemoteCommand;

const HELP_OPTION: OptionTable = { help: { type: 'boolean', help: 'Show this help' } };

const SERVER_OPTIONS = {
  config: {
    type: 'string',
    value: 'FILE',
    help: 'Original .screepsrc settings; defaults to ./.screepsrc when present',
  },
  mods: { type: 'string', value: 'FILE', help: 'Load original trusted mods.json (MODFILE)' },
  'original-db': {
    type: 'string',
    value: 'FILE',
    help: 'Import original LokiJS db.json only into an empty world (DB_PATH)',
  },
  'cli-host': {
    type: 'string',
    value: 'HOST',
    help: 'Trusted original JavaScript CLI address (CLI_HOST; default 127.0.0.1)',
  },
  'cli-port': {
    type: 'string',
    value: 'PORT',
    help: 'Enable original trusted JavaScript CLI (CLI_PORT)',
  },
  runners: { type: 'string', value: 'N', help: 'Player runner child processes (RUNNERS_CNT)' },
  'runner-threads': {
    type: 'string',
    value: 'N',
    help: 'Concurrent player runs per runner (RUNNER_THREADS)',
  },
  processors: {
    type: 'string',
    value: 'N',
    help: 'Concurrent room processor child processes (PROCESSORS_CNT)',
  },
  'worker-restart-interval': {
    type: 'string',
    value: 'SECONDS',
    help: 'Drain and recycle workers periodically; 0 disables recycling',
  },
  'log-directory': { type: 'string', value: 'DIR', help: 'Worker logs directory' },
  'log-console': { type: 'boolean', help: 'Also print child process output to the terminal' },
  'log-rotate-keep': { type: 'string', value: 'N', help: 'Rotated worker log files to retain' },
  'steam-greenworks': {
    type: 'string',
    value: 'PATH',
    help: 'Opt in to original native Steam encrypted-ticket authentication (STEAM_GREENWORKS)',
  },
  host: { type: 'string', value: 'HOST', help: 'Listen address (GAME_HOST; default 127.0.0.1)' },
  port: {
    type: 'string',
    value: 'PORT',
    help: 'Listen port, 0 picks a free port (GAME_PORT; default 21025)',
  },
  database: {
    type: 'string',
    value: 'FILE',
    help: 'SQLite world; with a database URL only the token file base (SCREEPS_DATABASE; default data/world.sqlite)',
  },
  'database-url': {
    type: 'string',
    value: 'URL',
    help: 'PostgreSQL world postgres://...; replaces the SQLite world (prefer SCREEPS_DATABASE_URL)',
  },
  'world-size': {
    type: 'string',
    value: 'N',
    help: 'Rooms per side of a new world, centred on the W0|E0 and N0|S0 lines like screeps.com: 21 is W10N10..E9S9, 22 W10N10..E10S10 (SCREEPS_WORLD_SIZE; default 21)',
  },
  seed: { type: 'string', value: 'N', help: 'Seed of a new world (SCREEPS_SEED; default 1)' },
  shard: { type: 'string', value: 'NAME', help: 'Shard name (SHARD_NAME; default shard0)' },
  'tick-duration': {
    type: 'string',
    value: 'MS',
    help: 'Minimum milliseconds per tick (SCREEPS_TICK_DURATION; default 1000)',
  },
  'commit-ticks': {
    type: 'string',
    value: 'N',
    help: 'Ticks between writes of the world to the database (SCREEPS_COMMIT_TICKS; default 10)',
  },
  paused: {
    type: 'boolean',
    help: 'Pause ticks; --no-paused resumes (SCREEPS_PAUSED; default false)',
  },
  assets: { type: 'string', value: 'DIR', help: 'Game client asset directory (ASSET_DIR)' },
  'steam-key': {
    type: 'string',
    value: 'KEY',
    help: 'Steam Web API key for Steam sign-in (STEAM_KEY)',
  },
  'server-password': {
    type: 'string',
    value: 'PASSWORD',
    help: 'Password game clients must send (SERVER_PASSWORD)',
  },
  'allow-registration': {
    type: 'boolean',
    help: 'Allow sign-ups through POST /api/register/submit; --no-allow-registration disables them (SCREEPS_ALLOW_REGISTRATION; default true; always off with a server password)',
  },
  'admin-token': {
    type: 'string',
    value: 'TOKEN',
    help: 'Admin API token, 32+ characters; prefer SCREEPS_ADMIN_TOKEN or the token file',
  },
} satisfies OptionTable;

const CONNECTION_OPTIONS: OptionTable = {
  config: SERVER_OPTIONS.config,
  url: {
    type: 'string',
    value: 'URL',
    help: 'Server base URL; default http://HOST:PORT from the options below',
  },
  host: { type: 'string', value: 'HOST', help: 'Server host (GAME_HOST; default 127.0.0.1)' },
  port: { type: 'string', value: 'PORT', help: 'Server port (GAME_PORT; default 21025)' },
  database: {
    type: 'string',
    value: 'FILE',
    help: 'Locates the token file FILE.admin-token (SCREEPS_DATABASE)',
  },
  'admin-token': {
    type: 'string',
    value: 'TOKEN',
    help: 'Admin token; default SCREEPS_ADMIN_TOKEN, then the token file',
  },
};

const INIT_OPTIONS: OptionTable = {
  username: { type: 'string', value: 'NAME', help: 'Also create this local player' },
  password: {
    type: 'string',
    value: 'PASSWORD',
    help: "The player's password; prefer SCREEPS_INITIAL_PASSWORD",
  },
};

const OPTIONS_JSON: OptionDefinition = {
  type: 'string',
  value: 'JSON',
  help: 'Options object; named options override its fields',
};

const USER_ID_OPTION: OptionDefinition = {
  type: 'boolean',
  help: 'USER is a user id instead of a username',
};

/** Parses text that must hold a JSON object. JSON.parse yields only JSON values. */
export function parseJsonObject(text: string, label: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UsageError(`${label} is not valid JSON`);
  }
  if (!isRecord(value)) throw new UsageError(`${label} must be a JSON object`);
  return value as JsonObject;
}

/** Drops absent fields so optional DTO properties are omitted rather than `undefined`. */
function compact(entries: Readonly<Record<string, JsonValue | undefined>>): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function stringOption(input: Invocation, name: string): string | undefined {
  const value = input.values[name];
  return typeof value === 'string' ? value : undefined;
}

function booleanOption(input: Invocation, name: string): boolean | undefined {
  const value = input.values[name];
  return typeof value === 'boolean' ? value : undefined;
}

function parseInteger(text: string, label: string): number {
  if (!/^-?\d+$/.test(text)) throw new UsageError(`${label} must be an integer`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new UsageError(`${label} is out of range`);
  return value;
}

function integerOption(input: Invocation, name: string): number | undefined {
  const text = stringOption(input, name);
  return text === undefined ? undefined : parseInteger(text, `--${name}`);
}

function numberOption(input: Invocation, name: string): number | undefined {
  const text = stringOption(input, name);
  if (text === undefined) return undefined;
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new UsageError(`--${name} must be a number`);
  return Number(text);
}

function jsonOption(input: Invocation, name: string): JsonObject | undefined {
  const text = stringOption(input, name);
  return text === undefined ? undefined : parseJsonObject(text, `--${name}`);
}

function positional(input: Invocation, index: number): string {
  const value = input.positionals[index];
  if (value === undefined) throw new UsageError('Missing argument');
  return value;
}

/** USER names a player by username, or by user id with `--id`. */
function userTarget(input: Invocation): JsonObject {
  const user = positional(input, 0);
  return booleanOption(input, 'id') === true ? { userId: user } : { username: user };
}

/** `--options JSON` overlaid with the named options given; absent when neither was given. */
function mergedOptions(
  input: Invocation,
  named: Readonly<Record<string, JsonValue | undefined>>,
): JsonObject | undefined {
  const options = { ...jsonOption(input, 'options'), ...compact(named) };
  return Object.keys(options).length > 0 ? options : undefined;
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function adminTokenPath(database: string): string {
  return `${resolve(database)}.admin-token`;
}

/** Reads a token file written by `init`; `undefined` when it does not exist. */
function readAdminTokenFile(file: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  const token = text.trim();
  if (token.length < MINIMUM_TOKEN_LENGTH) {
    throw new Error(
      `Admin token file ${file} must contain at least ${String(MINIMUM_TOKEN_LENGTH)} characters`,
    );
  }
  return token;
}

/** Creates a fresh owner-only token file; `false` when one already exists (never overwritten). */
function createAdminTokenFile(file: string): boolean {
  // A PostgreSQL world creates no SQLite file, so its directory may not exist yet.
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(file, `${randomBytes(32).toString('base64url')}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false;
    throw error;
  }
}

/** Configuration from the environment overlaid with explicit server options. */
function serverOverrides(input: Invocation): Partial<ServerConfig> {
  const overrides: Partial<ServerConfig> = {};
  for (const [option, key] of Object.entries({
    mods: 'modFile',
    'original-db': 'originalDatabase',
    'cli-host': 'cliHost',
    'log-directory': 'logDirectory',
    'steam-greenworks': 'steamGreenworks',
  } as const)) {
    const value = stringOption(input, option);
    if (value !== undefined) overrides[key] = value;
  }
  for (const [option, key] of Object.entries({
    'cli-port': 'cliPort',
    runners: 'runnerCount',
    'runner-threads': 'runnerThreads',
    processors: 'processorCount',
    'worker-restart-interval': 'workerRestartInterval',
    'log-rotate-keep': 'logRotateKeep',
    'commit-ticks': 'commitTicks',
  } as const)) {
    const value = integerOption(input, option);
    if (value !== undefined) overrides[key] = value;
  }
  const logConsole = booleanOption(input, 'log-console');
  if (logConsole !== undefined) overrides.logConsole = logConsole;
  const host = stringOption(input, 'host');
  if (host !== undefined) overrides.host = host;
  const port = integerOption(input, 'port');
  if (port !== undefined) overrides.port = port;
  const database = stringOption(input, 'database');
  if (database !== undefined) overrides.database = resolve(database);
  const databaseUrl = stringOption(input, 'database-url');
  if (databaseUrl !== undefined) overrides.databaseUrl = databaseUrl;
  const worldSize = integerOption(input, 'world-size');
  if (worldSize !== undefined) overrides.worldSize = worldSize;
  const seed = integerOption(input, 'seed');
  if (seed !== undefined) overrides.seed = seed;
  const shard = stringOption(input, 'shard');
  if (shard !== undefined) overrides.shardName = shard;
  const tickDuration = integerOption(input, 'tick-duration');
  if (tickDuration !== undefined) overrides.tickDuration = tickDuration;
  const paused = booleanOption(input, 'paused');
  if (paused !== undefined) overrides.paused = paused;
  const assets = stringOption(input, 'assets');
  if (assets !== undefined) overrides.assetDirectory = assets;
  const steamKey = stringOption(input, 'steam-key');
  if (steamKey !== undefined) overrides.steamKey = steamKey;
  const serverPassword = stringOption(input, 'server-password');
  if (serverPassword !== undefined) overrides.serverPassword = serverPassword;
  const allowRegistration = booleanOption(input, 'allow-registration');
  if (allowRegistration !== undefined) overrides.allowRegistration = allowRegistration;
  const adminToken = stringOption(input, 'admin-token');
  if (adminToken !== undefined) overrides.adminToken = adminToken;
  return overrides;
}

function serverConfig(input: Invocation, overrides: Partial<ServerConfig>): ServerConfig {
  const file =
    stringOption(input, 'config') ?? (existsSync('.screepsrc') ? '.screepsrc' : undefined);
  const config = createConfig({
    ...(file === undefined ? {} : originalConfig(file)),
    ...configFromEnvironment(input.environment),
    ...overrides,
  });
  config.database = resolve(config.database);
  return config;
}

function worldSummary(state: ServerState): string {
  const world = state.world;
  return [
    `tick ${String(world.gameTime)}`,
    `${String(Object.keys(world.rooms).length)} rooms`,
    `${String(Object.keys(world.users).length)} users`,
    `${String(Object.keys(world.roomObjects).length)} room objects`,
    state.paused ? 'paused' : `${String(state.tickDuration)} ms/tick`,
  ].join(', ');
}

async function removeDatabaseFiles(database: string): Promise<void> {
  await Promise.all(
    ['', '-wal', '-shm', '-journal'].map((suffix) => rm(`${database}${suffix}`, { force: true })),
  );
}

async function initialize(input: Invocation): Promise<void> {
  const config = serverConfig(input, serverOverrides(input));
  const username = stringOption(input, 'username');
  const explicitPassword = stringOption(input, 'password');
  if (explicitPassword !== undefined && username === undefined) {
    throw new UsageError('--password requires --username');
  }
  const password = explicitPassword ?? input.environment.SCREEPS_INITIAL_PASSWORD;
  if (username !== undefined && password === undefined) {
    throw new UsageError('--username requires SCREEPS_INITIAL_PASSWORD or --password');
  }
  const database = databaseLabel(config);
  const sqlite = config.databaseUrl === undefined;
  if (sqlite && existsSync(config.database)) {
    throw new Error(`Database ${database} already exists; init never replaces a world`);
  }
  const tokenFile = adminTokenPath(config.database);
  // Validate a pre-existing token file before creating anything.
  if (config.adminToken === undefined) readAdminTokenFile(tokenFile);

  // Build the world and player in memory, so the database receives one complete first commit.
  const draftConfig: ServerConfig = { ...config, database: ':memory:' };
  delete draftConfig.databaseUrl;
  const draft = await ServerKernel.create(draftConfig);
  let state: ServerState;
  try {
    if (username !== undefined && password !== undefined) {
      await draft.mutate(() => {
        createUser(draft, { username, password });
      });
    }
    state = await draft.exportSnapshot();
  } finally {
    await draft.close();
  }

  let summary: string | undefined;
  try {
    const store = await StateStore.open(config);
    if (store.load() === undefined) {
      const kernel = await ServerKernel.create(config, { state }, store);
      try {
        summary = await kernel.read(() => worldSummary(kernel.state));
      } finally {
        await kernel.close();
      }
    } else {
      await store.close();
    }
  } catch (error) {
    if (sqlite) await removeDatabaseFiles(config.database);
    throw error;
  }
  if (summary === undefined) {
    throw new Error(`Database ${database} already exists; init never replaces a world`);
  }
  print(`Initialized world ${database} (shard ${config.shardName}): ${summary}`);
  if (username !== undefined) print(`Created player "${username}"`);
  if (config.adminToken !== undefined) {
    print('Admin token supplied by SCREEPS_ADMIN_TOKEN or --admin-token; no token file written');
  } else if (createAdminTokenFile(tokenFile)) {
    print(`Created admin token file ${tokenFile} (owner read/write only)`);
  } else {
    print(`Kept existing admin token file ${tokenFile}`);
  }
}

function listenUrl(address: AddressInfo): string {
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return `http://${host}:${String(address.port)}/`;
}

/** Waits for SIGINT/SIGTERM, then closes the server gracefully; a second signal forces exit. */
async function closeOnSignal(server: RunningServer): Promise<void> {
  const { promise: signalled, resolve: receive } = Promise.withResolvers<NodeJS.Signals>();
  let closing = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (closing) {
      process.stderr.write(`${PROGRAM}: received ${signal} again; exiting without cleanup\n`);
      process.exit(1);
    }
    closing = true;
    receive(signal);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    print(`Received ${await signalled}; shutting down`);
    await server.close();
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  print('Server stopped');
}

/**
 * Starts the server for `start`. Explicit `--paused`/`--no-paused`/`--tick-duration` also apply to
 * an existing world, whose persisted scheduler settings otherwise win over configuration.
 */
export async function startServer(input: Invocation): Promise<RunningServer> {
  const overrides = serverOverrides(input);
  const config = serverConfig(input, overrides);
  const tokenFile = adminTokenPath(config.database);
  const adminToken = config.adminToken ?? readAdminTokenFile(tokenFile);
  const server = await createServer(adminToken === undefined ? config : { ...config, adminToken });
  try {
    if (overrides.paused !== undefined) await server.kernel.setPaused(overrides.paused);
    if (overrides.tickDuration !== undefined) {
      await server.kernel.setTickDuration(overrides.tickDuration);
    }
    const summary = await server.kernel.read(() => worldSummary(server.kernel.state));
    print(`OpenScreeps server listening on ${listenUrl(server.address)}`);
    print(`World ${databaseLabel(config)} (shard ${config.shardName}): ${summary}`);
    print(
      adminToken === undefined
        ? `Admin API disabled: set SCREEPS_ADMIN_TOKEN or run init to create ${tokenFile}`
        : 'Admin API enabled at /admin',
    );
  } catch (error) {
    await server.close();
    throw error;
  }
  return server;
}

function adminEndpoint(input: Invocation, config: ServerConfig): URL {
  let base = stringOption(input, 'url');
  if (base === undefined) {
    if (config.port === 0)
      throw new UsageError('Port 0 has no fixed address; pass --url or --port');
    const host =
      config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host;
    base = `http://${host.includes(':') ? `[${host}]` : host}:${String(config.port)}`;
  }
  let endpoint: URL;
  try {
    endpoint = new URL(`${base.replace(/\/+$/, '')}/admin`);
  } catch {
    throw new UsageError('--url is not a valid URL');
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new UsageError('--url must use http or https');
  }
  return endpoint;
}

function resolveAdminToken(config: ServerConfig): string {
  if (config.adminToken !== undefined) return config.adminToken;
  const file = adminTokenPath(config.database);
  const token = readAdminTokenFile(file);
  if (token === undefined) {
    throw new Error(
      `No admin token: set SCREEPS_ADMIN_TOKEN, pass --admin-token, or run init to create ${file}`,
    );
  }
  return token;
}

function errorDetail(body: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  for (const value of [body.error, body.message]) {
    if (typeof value === 'string') parts.push(value);
    else if (Array.isArray(value)) {
      parts.push(value.filter((item): item is string => typeof item === 'string').join('; '));
    }
  }
  const unique = [...new Set(parts.filter((part) => part.length > 0))];
  return unique.length > 0 ? unique.join(': ') : undefined;
}

/** Sends one admin action and returns the `{ok: 1, ...}` response; throws on any failure. */
export async function postAdmin(
  endpoint: URL,
  token: string,
  body: JsonObject,
): Promise<JsonObject> {
  const action = typeof body.action === 'string' ? body.action : 'request';
  const target = `${endpoint.origin}${endpoint.pathname}`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    throw new Error(
      `Cannot reach ${target}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause: error },
    );
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const status = `HTTP ${String(response.status)}`;
  if (!isRecord(parsed)) {
    throw new Error(`Admin ${action} failed (${status}): response is not a JSON object`);
  }
  const detail = errorDetail(parsed);
  if (!response.ok || parsed.error !== undefined) {
    throw new Error(`Admin ${action} failed (${status}): ${detail ?? response.statusText}`);
  }
  if (parsed.ok !== 1) throw new Error(`Admin ${action} failed (${status}): unexpected response`);
  return parsed as JsonObject;
}

async function runRemote(command: RemoteCommand, input: Invocation): Promise<void> {
  const overrides: Partial<ServerConfig> = {};
  const host = stringOption(input, 'host');
  if (host !== undefined) overrides.host = host;
  const port = integerOption(input, 'port');
  if (port !== undefined) overrides.port = port;
  const database = stringOption(input, 'database');
  if (database !== undefined) overrides.database = database;
  const adminToken = stringOption(input, 'admin-token');
  if (adminToken !== undefined) overrides.adminToken = adminToken;
  const config = serverConfig(input, overrides);
  const endpoint = adminEndpoint(input, config);
  const body = await command.request(input);
  const result = await postAdmin(endpoint, resolveAdminToken(config), body);
  if (command.handle) {
    await command.handle(result, input);
    return;
  }
  const output = Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'ok'));
  print(Object.keys(output).length > 0 ? JSON.stringify(output, null, 2) : 'OK');
}

/** Writes owner-only `file`, failing if it exists unless `force` (then atomically replaced). */
async function writeSnapshotFile(file: string, text: string, force: boolean): Promise<void> {
  const target = force ? `${file}.${randomBytes(6).toString('hex')}.tmp` : file;
  const handle = await open(target, 'wx', 0o600);
  let written = false;
  try {
    await handle.writeFile(text);
    await handle.sync();
    written = true;
  } finally {
    await handle.close();
    if (!written) await rm(target, { force: true });
  }
  if (force) {
    try {
      await rename(target, file);
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
  }
}

/** Reads bot code locally; the server never receives a file path. */
function bundleModules(input: Invocation): JsonObject {
  const directory = stringOption(input, 'dir');
  if (directory === undefined) throw new UsageError('--dir is required');
  const modules: JsonObject = {};
  for (const [name, source] of Object.entries(loadBotModules(resolve(directory)))) {
    modules[name] = typeof source === 'string' ? source : { binary: source.binary };
  }
  return modules;
}

function remote(
  args: string,
  summary: string,
  positionals: readonly [number, number],
  request: RemoteCommand['request'],
  options: OptionTable = {},
  handle?: RemoteCommand['handle'],
): RemoteCommand {
  return handle === undefined
    ? { kind: 'remote', arguments: args, summary, options, positionals, request }
    : { kind: 'remote', arguments: args, summary, options, positionals, request, handle };
}

const COMMANDS = new Map<string, Command>([
  [
    'init',
    {
      kind: 'local',
      arguments: '',
      summary: 'Create the world database and admin token file (no HTTP, no ticks)',
      options: INIT_OPTIONS,
      positionals: [0, 0],
      run: initialize,
    },
  ],
  [
    'migrate-original',
    {
      kind: 'local',
      arguments: 'FILE',
      summary: 'Import an original LokiJS world into a new database without changing the source',
      options: {},
      positionals: [1, 1],
      run: async (input) => {
        await initialize({
          ...input,
          positionals: [],
          values: { ...input.values, 'original-db': positional(input, 0) },
        });
      },
    },
  ],
  [
    'start',
    {
      kind: 'local',
      arguments: '',
      summary: 'Run the game server until SIGINT/SIGTERM, then close it gracefully',
      options: {},
      positionals: [0, 0],
      run: async (input) => {
        await closeOnSignal(await startServer(input));
      },
    },
  ],
  [
    'status',
    remote('', 'Time, scheduler, counts, maintenance and outbox state', [0, 0], () => ({
      action: 'status',
    })),
  ],
  ['pause', remote('', 'Pause the tick scheduler', [0, 0], () => ({ action: 'pause' }))],
  ['resume', remote('', 'Resume the tick scheduler', [0, 0], () => ({ action: 'resume' }))],
  [
    'tick',
    remote('[COUNT]', 'Run COUNT ticks now, 1-1000 (default 1)', [0, 1], (input) =>
      compact({
        action: 'tick',
        count:
          input.positionals[0] === undefined
            ? undefined
            : parseInteger(input.positionals[0], 'COUNT'),
      }),
    ),
  ],
  [
    'tick-duration',
    remote('MS', 'Set the minimum milliseconds per tick', [1, 1], (input) => ({
      action: 'tick-duration',
      milliseconds: parseInteger(positional(input, 0), 'MS'),
    })),
  ],
  [
    'user create',
    remote(
      '',
      'Create a player',
      [0, 0],
      (input) =>
        compact({
          action: 'user-create',
          username: stringOption(input, 'username'),
          password: stringOption(input, 'password'),
          email: stringOption(input, 'email'),
          steamId: stringOption(input, 'steam-id'),
          cpu: integerOption(input, 'cpu'),
          gcl: integerOption(input, 'gcl'),
          cpuAvailable: integerOption(input, 'cpu-available'),
        }),
      {
        username: { type: 'string', value: 'NAME', help: 'Player name' },
        password: { type: 'string', value: 'PASSWORD', help: 'Local sign-in password' },
        email: { type: 'string', value: 'EMAIL', help: 'E-mail address' },
        'steam-id': { type: 'string', value: 'ID', help: 'Steam account id' },
        cpu: { type: 'string', value: 'N', help: 'CPU limit (default 100)' },
        gcl: { type: 'string', value: 'POINTS', help: 'GCL points (default 0)' },
        'cpu-available': { type: 'string', value: 'N', help: 'CPU bucket (default 0)' },
      },
    ),
  ],
  [
    'user update',
    remote(
      'USER',
      'Change a player',
      [1, 1],
      (input) => {
        const fields = compact({
          password: stringOption(input, 'password'),
          cpu: integerOption(input, 'cpu'),
          gcl: integerOption(input, 'gcl'),
          power: integerOption(input, 'power'),
          credits: numberOption(input, 'credits'),
          active: booleanOption(input, 'active'),
          resources: jsonOption(input, 'resources'),
        });
        if (Object.keys(fields).length === 0) throw new UsageError('user update needs a change');
        return { action: 'user-update', ...userTarget(input), ...fields };
      },
      {
        id: USER_ID_OPTION,
        password: { type: 'string', value: 'PASSWORD', help: 'New password; signs the player out' },
        cpu: { type: 'string', value: 'N', help: 'CPU limit' },
        gcl: { type: 'string', value: 'POINTS', help: 'GCL points' },
        power: { type: 'string', value: 'POINTS', help: 'Power points' },
        credits: { type: 'string', value: 'AMOUNT', help: 'Market credits' },
        active: { type: 'boolean', help: 'Activate the account; --no-active deactivates it' },
        resources: {
          type: 'string',
          value: 'JSON',
          help: 'Account resources token/cpuUnlock/pixel/accessKey, 0 deletes; e.g. {"pixel":5}',
        },
      },
    ),
  ],
  [
    'user remove',
    remote(
      'USER',
      'Delete a player with its objects, code and records',
      [1, 1],
      (input) => ({ action: 'user-remove', ...userTarget(input) }),
      { id: USER_ID_OPTION },
    ),
  ],
  [
    'room generate',
    remote(
      'ROOM',
      'Generate (or regenerate) a room',
      [1, 1],
      (input) => {
        const mineral = stringOption(input, 'mineral');
        return compact({
          action: 'room-generate',
          room: positional(input, 0),
          options: mergedOptions(input, {
            exits: jsonOption(input, 'exits'),
            terrainType: integerOption(input, 'terrain-type'),
            swampType: integerOption(input, 'swamp-type'),
            sources: integerOption(input, 'sources'),
            mineral: mineral === 'none' ? false : mineral,
            controller: booleanOption(input, 'controller'),
            keeperLairs: booleanOption(input, 'keeper-lairs'),
            extractor: booleanOption(input, 'extractor'),
            bus: booleanOption(input, 'bus'),
            depositType: stringOption(input, 'deposit-type'),
          }),
        });
      },
      {
        options: OPTIONS_JSON,
        exits: { type: 'string', value: 'JSON', help: 'Exits per side, e.g. {"top":[20,21]}' },
        'terrain-type': { type: 'string', value: 'N', help: 'Landscape type 1-28' },
        'swamp-type': { type: 'string', value: 'N', help: 'Swamp type 0-14' },
        sources: { type: 'string', value: 'N', help: 'Number of sources' },
        mineral: { type: 'string', value: 'TYPE', help: 'Mineral type, or none' },
        controller: { type: 'boolean', help: 'With a controller; --no-controller omits it' },
        'keeper-lairs': { type: 'boolean', help: 'Source keeper lairs' },
        extractor: { type: 'boolean', help: 'Neutral extractor on the mineral' },
        bus: { type: 'boolean', help: 'Highway room' },
        'deposit-type': { type: 'string', value: 'TYPE', help: 'Highway deposit type' },
      },
    ),
  ],
  [
    'room open',
    remote(
      'ROOM',
      'Open a room to players',
      [1, 1],
      (input) =>
        compact({
          action: 'room-open',
          room: positional(input, 0),
          openTime: integerOption(input, 'open-time'),
        }),
      { 'open-time': { type: 'string', value: 'MS', help: 'Opening timestamp (default now)' } },
    ),
  ],
  [
    'room close',
    remote('ROOM', 'Close a room to players', [1, 1], (input) => ({
      action: 'room-close',
      room: positional(input, 0),
    })),
  ],
  [
    'room remove',
    remote('ROOM', 'Delete a room and its objects', [1, 1], (input) => ({
      action: 'room-remove',
      room: positional(input, 0),
    })),
  ],
  [
    'portal create',
    remote(
      'FROM TO',
      'Create a two-way portal pair between two rooms',
      [2, 2],
      (input) =>
        compact({
          action: 'portal-create',
          from: positional(input, 0),
          to: positional(input, 1),
          options: mergedOptions(input, {
            unstableDate: integerOption(input, 'unstable-date'),
            decayTime: integerOption(input, 'decay-time'),
          }),
        }),
      {
        options: OPTIONS_JSON,
        'unstable-date': { type: 'string', value: 'MS', help: 'Timestamp when portals decay' },
        'decay-time': { type: 'string', value: 'TICK', help: 'Game tick when portals vanish' },
      },
    ),
  ],
  [
    'terminal create',
    remote('ROOM', 'Create an NPC terminal in a highway room', [1, 1], (input) => ({
      action: 'terminal-create',
      room: positional(input, 0),
    })),
  ],
  [
    'bot add',
    remote(
      'NAME ROOM',
      'Spawn an NPC player running the bot code read locally from --dir',
      [2, 2],
      (input) =>
        compact({
          action: 'bot-add',
          name: positional(input, 0),
          modules: bundleModules(input),
          room: positional(input, 1),
          options: mergedOptions(input, {
            username: stringOption(input, 'username'),
            cpu: integerOption(input, 'cpu'),
            gcl: integerOption(input, 'gcl'),
            x: integerOption(input, 'x'),
            y: integerOption(input, 'y'),
          }),
        }),
      {
        dir: { type: 'string', value: 'DIR', help: 'Local bot directory with main.js (required)' },
        options: OPTIONS_JSON,
        username: { type: 'string', value: 'NAME', help: 'Bot player name (default random)' },
        cpu: { type: 'string', value: 'N', help: 'CPU limit (default 100)' },
        gcl: { type: 'string', value: 'LEVEL', help: 'Global control level (default 1)' },
        x: { type: 'string', value: 'X', help: 'Spawn x (default random)' },
        y: { type: 'string', value: 'Y', help: 'Spawn y (default random)' },
      },
    ),
  ],
  [
    'bot reload',
    remote(
      'NAME',
      'Replace the code of every bot player of NAME from --dir',
      [1, 1],
      (input) => ({
        action: 'bot-reload',
        name: positional(input, 0),
        modules: bundleModules(input),
      }),
      {
        dir: { type: 'string', value: 'DIR', help: 'Local bot directory with main.js (required)' },
      },
    ),
  ],
  [
    'bot remove',
    remote('USERNAME', 'Delete a bot player', [1, 1], (input) => ({
      action: 'bot-remove',
      username: positional(input, 0),
    })),
  ],
  [
    'stronghold spawn',
    remote(
      'ROOM',
      'Spawn an NPC stronghold',
      [1, 1],
      (input) =>
        compact({
          action: 'stronghold-spawn',
          room: positional(input, 0),
          options: mergedOptions(input, {
            templateName: stringOption(input, 'template'),
            x: integerOption(input, 'x'),
            y: integerOption(input, 'y'),
            user: stringOption(input, 'user'),
            deployTime: integerOption(input, 'deploy-time'),
          }),
        }),
      {
        options: OPTIONS_JSON,
        template: { type: 'string', value: 'NAME', help: 'Template (see stronghold templates)' },
        x: { type: 'string', value: 'X', help: 'Core x, with --template' },
        y: { type: 'string', value: 'Y', help: 'Core y, with --template' },
        user: { type: 'string', value: 'USER_ID', help: 'Owner (default 2, Invader)' },
        'deploy-time': { type: 'string', value: 'TICKS', help: 'Ticks until deployment' },
      },
    ),
  ],
  [
    'stronghold expand',
    remote('ROOM', 'Expand the stronghold in a room', [1, 1], (input) => ({
      action: 'stronghold-expand',
      room: positional(input, 0),
    })),
  ],
  [
    'stronghold templates',
    remote('', 'List stronghold templates', [0, 0], () => ({ action: 'stronghold-templates' })),
  ],
  [
    'maintenance',
    remote('NAME', 'Run a maintenance job now', [1, 1], (input) => ({
      action: 'maintenance',
      name: positional(input, 0),
    })),
  ],
  [
    'notifications',
    remote('', 'Show the retained notification outbox', [0, 0], () => ({
      action: 'notifications',
    })),
  ],
  [
    'message',
    remote(
      'TEXT...',
      'Broadcast a server message to connected clients',
      [1, Infinity],
      (input) => ({
        action: 'server-message',
        message: input.positionals.join(' '),
      }),
    ),
  ],
  [
    'snapshot export',
    remote(
      'FILE',
      'Write a durable world snapshot to a new local FILE',
      [1, 1],
      (input) => {
        const file = resolve(positional(input, 0));
        if (booleanOption(input, 'force') !== true && existsSync(file)) {
          throw new Error(`${file} already exists; pass --force to replace it`);
        }
        return { action: 'snapshot-export' };
      },
      { force: { type: 'boolean', help: 'Replace an existing FILE' } },
      async (result, input) => {
        const snapshot = result.snapshot;
        if (!isRecord(snapshot)) throw new Error('Server response holds no snapshot');
        const file = resolve(positional(input, 0));
        await writeSnapshotFile(
          file,
          `${JSON.stringify(snapshot)}\n`,
          booleanOption(input, 'force') === true,
        );
        const world = snapshot.world;
        const tick =
          isRecord(world) && typeof world.gameTime === 'number'
            ? ` at tick ${String(world.gameTime)}`
            : '';
        print(`Wrote snapshot${tick} to ${file}`);
      },
    ),
  ],
  [
    'snapshot import',
    remote('FILE', 'Replace the running world with a snapshot FILE', [1, 1], async (input) => {
      const file = resolve(positional(input, 0));
      return {
        action: 'snapshot-import',
        snapshot: parseJsonObject(await readFile(file, 'utf8'), file),
      };
    }),
  ],
  [
    'admin',
    remote(
      'ACTION',
      'Send any admin API action with --json arguments',
      [1, 1],
      (input) => {
        const action = positional(input, 0);
        if (!/^[a-z][a-z0-9-]*$/.test(action)) throw new UsageError(`Invalid action "${action}"`);
        const args = jsonOption(input, 'json') ?? {};
        if (Object.hasOwn(args, 'action')) throw new UsageError('--json must not contain "action"');
        return { ...args, action };
      },
      { json: { type: 'string', value: 'JSON', help: 'Action arguments object' } },
    ),
  ],
]);

const GROUPS = new Set([...COMMANDS.keys()].flatMap((name) => name.split(' ').slice(0, -1)));

function optionLines(table: OptionTable): string[] {
  return Object.entries(table).map(([name, option]) => {
    const flag = `--${name}${option.value === undefined ? '' : ` ${option.value}`}`;
    return `      ${flag.padEnd(28)} ${option.help}`;
  });
}

function commandLines(kind: Command['kind']): string[] {
  const lines: string[] = [];
  for (const [name, command] of COMMANDS) {
    if (command.kind !== kind) continue;
    const usage = command.arguments ? `${name} ${command.arguments}` : name;
    lines.push(`  ${usage.padEnd(32)} ${command.summary}`, ...optionLines(command.options));
  }
  return lines;
}

export function helpText(): string {
  return [
    `Usage: ${PROGRAM} <command> [arguments] [options]`,
    '',
    'Server commands (on the server host):',
    ...commandLines('local'),
    '',
    'Server options (init, start); environment variables in parentheses:',
    ...optionLines(SERVER_OPTIONS),
    '',
    'Admin commands (POST <url>/admin with Authorization: Bearer <admin token>):',
    ...commandLines('remote'),
    '',
    'Connection options (all admin commands):',
    ...optionLines(CONNECTION_OPTIONS),
    '',
    `init stores a random admin token in DATABASE.admin-token (mode 0600) unless`,
    `SCREEPS_ADMIN_TOKEN is set; start and admin commands read SCREEPS_ADMIN_TOKEN, else that file.`,
    `--help shows this text. Pass arguments starting with "-" as --option=VALUE or after "--".`,
    '',
  ].join('\n');
}

/** Resolves the command named by the leading words of `args` and parses its remaining arguments. */
export function parseInvocation(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): { command: Command; name: string; input: Invocation; help: boolean } | undefined {
  const [first, second] = args;
  if (first === undefined || first === 'help' || first === '--help' || first === '-h') {
    return undefined;
  }
  if (first.startsWith('-')) {
    throw new UsageError(`Put the command first: ${PROGRAM} <command> [arguments] [options]`);
  }
  let name = first;
  if (GROUPS.has(first)) {
    if (second === undefined || second.startsWith('-')) {
      throw new UsageError(`"${first}" needs a subcommand`);
    }
    name = `${first} ${second}`;
  }
  const command = COMMANDS.get(name);
  if (command === undefined) throw new UsageError(`Unknown command "${name}"`);
  const table: OptionTable = {
    ...(command.kind === 'local' ? SERVER_OPTIONS : CONNECTION_OPTIONS),
    ...command.options,
    ...HELP_OPTION,
  };
  const options: ParseArgsOptionsConfig = {};
  for (const [option, definition] of Object.entries(table)) {
    options[option] =
      option === 'help' ? { type: 'boolean', short: 'h' } : { type: definition.type };
  }
  let parsed: { values: Readonly<Record<string, unknown>>; positionals: string[] };
  try {
    parsed = parseArgs({
      args: args.slice(name.split(' ').length),
      options,
      allowPositionals: true,
      allowNegative: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const help = parsed.values.help === true;
  const [minimum, maximum] = command.positionals;
  const count = parsed.positionals.length;
  if (!help && (count < minimum || count > maximum)) {
    const usage = command.arguments ? `${name} ${command.arguments}` : name;
    throw new UsageError(`Usage: ${PROGRAM} ${usage}`);
  }
  return {
    command,
    name,
    input: { positionals: parsed.positionals, values: parsed.values, environment },
    help,
  };
}

/** Builds the admin API request body of a remote command without sending it. */
export async function adminRequestBody(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<JsonObject> {
  const invocation = parseInvocation(args, environment);
  if (invocation?.command.kind !== 'remote') throw new UsageError('Not an admin command');
  return invocation.command.request(invocation.input);
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const invocation = parseInvocation(args, environment);
  if (invocation === undefined || invocation.help) {
    process.stdout.write(helpText());
    return;
  }
  const { command, input } = invocation;
  if (command.kind === 'local') await command.run(input);
  else await runRemote(command, input);
}

function reportFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${PROGRAM}: ${message}\n`);
  if (error instanceof UsageError) {
    process.stderr.write(`Run "${PROGRAM} help" for usage.\n`);
    process.exitCode = 2;
  } else {
    process.exitCode = 1;
  }
}

function isEntrypoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return pathToFileURL(realpathSync(script)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntrypoint()) main().catch(reportFailure);
