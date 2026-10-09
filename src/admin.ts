/*
 * Authenticated administrative API: `POST /admin` with `{action, ...arguments}` and a bearer
 * administrator token. Every world change runs as one serialized, durably committed kernel
 * mutation; inputs are validated before any mutation starts and never name server-side files.
 */

import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Post,
  Res,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { constants as C, type CodeModules } from '@openscreeps/engine';
import {
  ApiError,
  type ApiContext,
  type ServerContext,
  type ServerState,
  type User,
} from './contracts.ts';
import { SERVER_CONTEXT, secretsEqual, sendError } from './http.ts';
import { ServerKernel } from './kernel.ts';
import { decodeState } from './storage.ts';
import { isRecord } from './api/guards.ts';
import {
  createUser,
  findUserByUsername,
  setUserPassword,
  USERNAME_PATTERN,
  type CreateUserOptions,
} from './api/users.ts';
import {
  closeRoom,
  createNpcTerminal,
  createPortalPair,
  expandStrongholdInRoom,
  generateRoom,
  isMaintenanceJobName,
  jobKey,
  MAINTENANCE_JOBS,
  openRoom,
  reloadBot,
  removeBot,
  removeRoom,
  respawnUser,
  runJob,
  spawnBot,
  spawnStronghold,
  strongholdTemplates,
  type ExitSide,
  type GenerateRoomOptions,
  type PortalOptions,
  type RoomExits,
  type SpawnBotOptions,
  type SpawnStrongholdOptions,
} from './world/index.ts';

type Args = Readonly<Record<string, unknown>>;
type Result = Record<string, unknown>;

const ROOM_NAME = /^[WE]\d{1,3}[NS]\d{1,3}$/;
const BOT_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_CODE_SIZE = 5 * 1024 * 1024;
const MAX_MESSAGE_LENGTH = 4096;
const MAX_TICKS = 1000;
const MAX_CPU = 10000;
const MAX_BUCKET = 10000;
const MAX_TIMESTAMP = 8.64e15;
const MAX_CREDITS = 1e12;
/** Invader and Source Keeper NPC accounts; the `Screeps` system account is matched by name. */
const NPC_USER_IDS: Readonly<Record<string, true>> = { 2: true, 3: true };
const EXIT_SIDES: readonly ExitSide[] = ['top', 'right', 'bottom', 'left'];
const MINERALS: readonly string[] = [
  C.RESOURCE_HYDROGEN,
  C.RESOURCE_OXYGEN,
  C.RESOURCE_UTRIUM,
  C.RESOURCE_LEMERGIUM,
  C.RESOURCE_KEANIUM,
  C.RESOURCE_ZYNTHIUM,
  C.RESOURCE_CATALYST,
];
const DEPOSITS: readonly string[] = [
  C.RESOURCE_SILICON,
  C.RESOURCE_METAL,
  C.RESOURCE_BIOMASS,
  C.RESOURCE_MIST,
];
const ACCOUNT_RESOURCES: readonly string[] = C.INTERSHARD_RESOURCES;

function invalid(message: string): ApiError {
  return new ApiError(message, 400);
}

/** Helper validation failures are plain `Error`s; other error classes are internal faults. */
function domain<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof Error && Object.getPrototypeOf(error) === Error.prototype)
      throw invalid(error.message);
    throw error;
  }
}

/** A JSON object with only whitelisted own fields. */
function fields(value: unknown, allowed: readonly string[], name: string): Args {
  if (!isRecord(value)) throw invalid(`${name} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw invalid(`unknown ${name} field ${JSON.stringify(key.slice(0, 64))}`);
  }
  return value;
}

function field(args: Args, key: string): unknown {
  return Object.hasOwn(args, key) ? args[key] : undefined;
}

function text(args: Args, key: string, max = 256, pattern?: RegExp): string {
  const value = field(args, key);
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > max ||
    (pattern && !pattern.test(value))
  ) {
    throw invalid(`invalid ${key}`);
  }
  return value;
}

function optionalText(args: Args, key: string, max = 256, pattern?: RegExp): string | undefined {
  return field(args, key) === undefined ? undefined : text(args, key, max, pattern);
}

function integer(args: Args, key: string, min: number, max: number): number {
  const value = field(args, key);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(`${key} must be an integer from ${String(min)} to ${String(max)}`);
  }
  return value;
}

function optionalInteger(args: Args, key: string, min: number, max: number): number | undefined {
  return field(args, key) === undefined ? undefined : integer(args, key, min, max);
}

function optionalFinite(args: Args, key: string, min: number, max: number): number | undefined {
  const value = field(args, key);
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw invalid(`${key} must be a number from ${String(min)} to ${String(max)}`);
  }
  return value;
}

function optionalBoolean(args: Args, key: string): boolean | undefined {
  const value = field(args, key);
  if (value === undefined || typeof value === 'boolean') return value;
  throw invalid(`${key} must be a boolean`);
}

function roomName(args: Args, key = 'room'): string {
  return text(args, key, 16, ROOM_NAME);
}

function set<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: Exclude<T[K], undefined> | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

/** Inline bot code: module name to source text or `{binary: base64}`; `main` is required. */
function parseModules(value: unknown): CodeModules {
  if (!isRecord(value)) throw invalid('modules must be an object of module sources');
  const modules: CodeModules = {};
  let size = 0;
  for (const [name, source] of Object.entries(value)) {
    if (!name.length || name.length > 256 || /^[$./\\]/.test(name) || name === '__proto__') {
      throw invalid(`invalid module name ${JSON.stringify(name.slice(0, 64))}`);
    }
    if (typeof source === 'string') {
      modules[name] = source;
      size += name.length + source.length;
    } else {
      const binary = field(fields(source, ['binary'], 'module'), 'binary');
      if (typeof binary !== 'string' || !BASE64.test(binary))
        throw invalid(`invalid binary module ${name}`);
      modules[name] = { binary };
      size += name.length + binary.length;
    }
    if (size > MAX_CODE_SIZE) throw invalid('code length exceeds 5 MB limit');
  }
  if (!Object.hasOwn(modules, 'main')) throw invalid('modules must include main');
  return modules;
}

function parseExits(value: unknown): RoomExits {
  const args = fields(value, EXIT_SIDES, 'exits');
  const exits: RoomExits = {};
  for (const side of EXIT_SIDES) {
    const list = field(args, side);
    if (list === undefined) continue;
    if (
      !Array.isArray(list) ||
      list.length > 48 ||
      !list.every(
        (i): i is number => typeof i === 'number' && Number.isSafeInteger(i) && i >= 1 && i <= 48,
      ) ||
      new Set(list).size !== list.length
    ) {
      throw invalid(`${side} exits must be distinct integers from 1 to 48`);
    }
    exits[side] = list;
  }
  return exits;
}

function generateOptions(value: unknown): GenerateRoomOptions {
  if (value === undefined) return {};
  const args = fields(
    value,
    [
      'exits',
      'terrainType',
      'swampType',
      'sources',
      'mineral',
      'controller',
      'keeperLairs',
      'extractor',
      'bus',
      'depositType',
    ],
    'options',
  );
  const options: GenerateRoomOptions = {};
  const exits = field(args, 'exits');
  if (exits !== undefined) options.exits = parseExits(exits);
  set(options, 'terrainType', optionalInteger(args, 'terrainType', 1, 28));
  set(options, 'swampType', optionalInteger(args, 'swampType', 0, 14));
  set(options, 'sources', optionalInteger(args, 'sources', 0, 10));
  const mineral = field(args, 'mineral');
  if (mineral !== undefined) {
    if (mineral === false || (typeof mineral === 'string' && MINERALS.includes(mineral)))
      options.mineral = mineral;
    else throw invalid(`mineral must be false or one of ${MINERALS.join(', ')}`);
  }
  set(options, 'controller', optionalBoolean(args, 'controller'));
  set(options, 'keeperLairs', optionalBoolean(args, 'keeperLairs'));
  set(options, 'extractor', optionalBoolean(args, 'extractor'));
  set(options, 'bus', optionalBoolean(args, 'bus'));
  const depositType = optionalText(args, 'depositType', 16);
  if (depositType !== undefined && !DEPOSITS.includes(depositType)) {
    throw invalid(`depositType must be one of ${DEPOSITS.join(', ')}`);
  }
  set(options, 'depositType', depositType);
  return options;
}

function portalOptions(value: unknown): PortalOptions {
  if (value === undefined) return {};
  const args = fields(value, ['unstableDate', 'decayTime'], 'options');
  const options: PortalOptions = {};
  set(options, 'unstableDate', optionalInteger(args, 'unstableDate', 0, MAX_TIMESTAMP));
  set(options, 'decayTime', optionalInteger(args, 'decayTime', 0, Number.MAX_SAFE_INTEGER));
  return options;
}

function botOptions(value: unknown): SpawnBotOptions {
  if (value === undefined) return {};
  const args = fields(value, ['username', 'cpu', 'gcl', 'x', 'y'], 'options');
  const options: SpawnBotOptions = {};
  set(options, 'username', optionalText(args, 'username', 64, USERNAME_PATTERN));
  set(options, 'cpu', optionalInteger(args, 'cpu', 1, MAX_CPU));
  set(options, 'gcl', optionalInteger(args, 'gcl', 1, 100));
  set(options, 'x', optionalInteger(args, 'x', 1, 48));
  set(options, 'y', optionalInteger(args, 'y', 1, 48));
  return options;
}

function strongholdOptions(value: unknown): SpawnStrongholdOptions {
  if (value === undefined) return {};
  const args = fields(value, ['templateName', 'x', 'y', 'user', 'deployTime'], 'options');
  const options: SpawnStrongholdOptions = {};
  const templateName = optionalText(args, 'templateName', 64);
  if (
    templateName !== undefined &&
    !strongholdTemplates().some((template) => template.name === templateName)
  ) {
    throw invalid('unknown stronghold template');
  }
  set(options, 'templateName', templateName);
  const x = optionalInteger(args, 'x', 0, 49);
  const y = optionalInteger(args, 'y', 0, 49);
  if ((x === undefined) !== (y === undefined) || (x !== undefined && templateName === undefined)) {
    throw invalid('a stronghold position needs x, y and templateName');
  }
  set(options, 'x', x);
  set(options, 'y', y);
  set(options, 'user', optionalText(args, 'user', 64));
  set(options, 'deployTime', optionalInteger(args, 'deployTime', 1, 1000000));
  return options;
}

function isSystemUser(user: User): boolean {
  return Object.hasOwn(NPC_USER_IDS, user._id) || user.username === C.SYSTEM_USERNAME;
}

type UserSelector = { userId: string } | { username: string };

function userSelector(args: Args): UserSelector {
  const userId = optionalText(args, 'userId', 64);
  const username = optionalText(args, 'username', 64);
  if (userId !== undefined && username === undefined) return { userId };
  if (username !== undefined && userId === undefined) return { username };
  throw invalid('exactly one of userId or username is required');
}

/** A modifiable account; NPC and system accounts are protected. Lock-held. */
function targetUser(state: ServerState, selector: UserSelector): User {
  const user =
    'userId' in selector
      ? Object.hasOwn(state.world.users, selector.userId)
        ? state.world.users[selector.userId]
        : undefined
      : findUserByUsername(state, selector.username);
  if (!user) throw new ApiError('user not found', 404);
  if (isSystemUser(user)) throw new ApiError('system users cannot be modified', 403);
  return user;
}

/** Account fields safe for operators; credentials live in profiles and are never returned. */
function publicUser(user: User): Result {
  const result: Result = {
    _id: user._id,
    cpu: user.cpu ?? 0,
    cpuAvailable: user.cpuAvailable ?? 0,
    gcl: user.gcl ?? 0,
    power: user.power ?? 0,
    credits: (user.money ?? 0) / 1000,
    active: user.active !== 0,
    rooms: user.rooms ?? [],
    resources: user.resources ?? {},
  };
  if (user.username !== undefined) result.username = user.username;
  if (user.bot !== undefined) result.bot = user.bot;
  return result;
}

function dropWhere<T>(collection: Record<string, T>, predicate: (value: T) => boolean): void {
  for (const [key, value] of Object.entries(collection)) {
    if (predicate(value)) Reflect.deleteProperty(collection, key);
  }
}

/** Deletes an account document with every private record keyed to it. Lock-held. */
function purgeUserRecords(state: ServerState, userId: string): void {
  const { world } = state;
  Reflect.deleteProperty(world.users, userId);
  Reflect.deleteProperty(state.profiles, userId);
  dropWhere(state.branches, (branch) => branch.user === userId);
  dropWhere(state.tokens, (token) => token.userId === userId);
  dropWhere(state.messages, (message) => message.user === userId);
  dropWhere(world.userPowerCreeps, (creep) => creep.user === userId);
  dropWhere(world.notifications, (notification) => notification.user === userId);
  dropWhere(world.marketOrders, (order) => order.user === userId);
  dropWhere(world.usersMoney, (entry) => entry.user === userId);
  dropWhere(world.usersResources, (entry) => entry.user === userId);
  for (const scores of Object.values(state.leaderboard)) Reflect.deleteProperty(scores, userId);
  for (const sample of state.statistics) {
    Reflect.deleteProperty(sample.users, userId);
    for (const room of Object.values(sample.rooms)) Reflect.deleteProperty(room, userId);
  }
  state.notificationOutbox = state.notificationOutbox.filter(
    (notification) => notification.userId !== userId,
  );
  Reflect.deleteProperty(state.pendingGlobalIntents, userId);
  state.pendingIntents = Object.fromEntries(
    Object.entries(state.pendingIntents)
      .map(
        ([room, users]) =>
          [
            room,
            Object.fromEntries(Object.entries(users).filter(([id]) => id !== userId)),
          ] as const,
      )
      .filter(([, users]) => Object.keys(users).length > 0),
  );
}

function statusOf(context: ServerContext): Result {
  const { state } = context;
  const users = Object.values(state.world.users);
  const now = context.now();
  return {
    shard: state.world.shardName,
    time: state.world.gameTime,
    paused: state.paused,
    tickDuration: state.tickDuration,
    counts: {
      users: users.length,
      players: users.filter((user) => user.bot === undefined && !isSystemUser(user)).length,
      bots: users.filter((user) => user.bot !== undefined).length,
      rooms: Object.keys(state.world.rooms).length,
      activeRooms: state.world.activeRooms.length,
      roomObjects: Object.keys(state.world.roomObjects).length,
      marketOrders: Object.keys(state.world.marketOrders).length,
      sessions: Object.values(state.tokens).filter((token) => token.expires > now).length,
    },
    maintenance: Object.fromEntries(
      Object.keys(MAINTENANCE_JOBS)
        .filter(isMaintenanceJobName)
        .map((name) => [
          name,
          { interval: MAINTENANCE_JOBS[name].interval, lastRun: state.jobs[jobKey(name)] ?? null },
        ]),
    ),
    notificationOutbox: state.notificationOutbox.length,
  };
}

/** Bearer administrator token only; player session tokens never grant access. Fails closed. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(SERVER_CONTEXT) readonly context: ApiContext) {}

  canActivate(execution: ExecutionContext): boolean {
    const expected = this.context.config.adminToken;
    if (expected === undefined || expected.length < 32) {
      throw new HttpException({ error: 'admin API disabled' }, HttpStatus.FORBIDDEN);
    }
    const http = execution.switchToHttp();
    const authorization = http.getRequest<Request>().get('Authorization');
    if (!authorization?.startsWith('Bearer ')) {
      http.getResponse<Response>().set('WWW-Authenticate', 'Bearer');
      throw new HttpException({ error: 'unauthorized' }, HttpStatus.UNAUTHORIZED);
    }
    if (!secretsEqual(authorization.slice(7), expected)) {
      throw new HttpException({ error: 'forbidden' }, HttpStatus.FORBIDDEN);
    }
    return true;
  }
}

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    @Inject(SERVER_CONTEXT) readonly context: ApiContext,
    @Inject(ServerKernel) readonly kernel: ServerKernel,
  ) {}

  @Get('status')
  async status(@Res() response: Response): Promise<void> {
    await this.#respond(response, () => this.context.read(() => statusOf(this.context)));
  }

  @Post()
  async command(@Body() body: unknown, @Res() response: Response): Promise<void> {
    await this.#respond(response, () => this.#execute(body));
  }

  async #respond(response: Response, operation: () => Promise<Result>): Promise<void> {
    try {
      response.json({ ok: 1, ...(await operation()) });
    } catch (error) {
      // Account helpers use protocol-style ApiErrors (status 200); the admin API reports them as 400.
      sendError(
        error instanceof ApiError && error.status < 400 ? invalid(error.message) : error,
        response,
      );
    }
  }

  /** One serialized, durably committed mutation that reads the current state inside the lock. */
  #mutate<T>(operation: (state: ServerState) => T): Promise<T> {
    return this.context.mutate(() => operation(this.context.state));
  }

  async #execute(body: unknown): Promise<Result> {
    if (!isRecord(body)) throw invalid('request body must be an object');
    const action = field(body, 'action');
    if (typeof action !== 'string') throw invalid('action is required');
    const args = (allowed: readonly string[]): Args =>
      fields(body, ['action', ...allowed], 'request');
    const { context } = this;
    switch (action) {
      case 'status':
        args([]);
        return context.read(() => statusOf(context));
      case 'pause':
      case 'resume': {
        args([]);
        await context.setPaused(action === 'pause');
        return { paused: action === 'pause' };
      }
      case 'tick': {
        const count = optionalInteger(args(['count']), 'count', 1, MAX_TICKS) ?? 1;
        let time = 0;
        for (let i = 0; i < count; i++) time = (await context.step()).simulation.gameTime;
        return { ticks: count, time };
      }
      case 'tick-duration': {
        const milliseconds = integer(args(['milliseconds']), 'milliseconds', 1, 3600000);
        await context.setTickDuration(milliseconds);
        return { tickDuration: milliseconds };
      }
      case 'user-create': {
        const input = args([
          'username',
          'password',
          'email',
          'steamId',
          'cpu',
          'gcl',
          'cpuAvailable',
        ]);
        const options: CreateUserOptions = { username: text(input, 'username', 64) };
        set(options, 'password', optionalText(input, 'password', 1024));
        set(options, 'email', optionalText(input, 'email', 254));
        set(options, 'steamId', optionalText(input, 'steamId', 20));
        set(options, 'cpu', optionalInteger(input, 'cpu', 0, MAX_CPU));
        set(options, 'gcl', optionalInteger(input, 'gcl', 0, Number.MAX_SAFE_INTEGER));
        set(options, 'cpuAvailable', optionalInteger(input, 'cpuAvailable', 0, MAX_BUCKET));
        return this.#mutate(() => ({ user: publicUser(createUser(context, options)) }));
      }
      case 'user-update': {
        const input = args([
          'userId',
          'username',
          'password',
          'cpu',
          'gcl',
          'power',
          'credits',
          'active',
          'resources',
        ]);
        const selector = userSelector(input);
        const password = optionalText(input, 'password', 1024);
        const cpu = optionalInteger(input, 'cpu', 0, MAX_CPU);
        const gcl = optionalInteger(input, 'gcl', 0, Number.MAX_SAFE_INTEGER);
        const power = optionalInteger(input, 'power', 0, Number.MAX_SAFE_INTEGER);
        const credits = optionalFinite(input, 'credits', 0, MAX_CREDITS);
        const active = optionalBoolean(input, 'active');
        const resourceInput = field(input, 'resources');
        const resources =
          resourceInput === undefined
            ? undefined
            : fields(resourceInput, ACCOUNT_RESOURCES, 'resources');
        const amounts =
          resources === undefined
            ? []
            : Object.keys(resources).map(
                (name) => [name, integer(resources, name, 0, Number.MAX_SAFE_INTEGER)] as const,
              );
        if (
          [password, cpu, gcl, power, credits, active, resources].every(
            (value) => value === undefined,
          )
        ) {
          throw invalid('no changes requested');
        }
        return this.#mutate((state) => {
          const user = targetUser(state, selector);
          if (password !== undefined) setUserPassword(context, user._id, password);
          if (cpu !== undefined) user.cpu = cpu;
          if (gcl !== undefined) user.gcl = gcl;
          if (power !== undefined) user.power = power;
          if (credits !== undefined) user.money = Math.round(credits * 1000);
          if (active !== undefined) user.active = active ? 10000 : 0;
          if (amounts.length) {
            const owned = (user.resources ??= {});
            for (const [name, amount] of amounts) {
              if (amount) owned[name] = amount;
              else Reflect.deleteProperty(owned, name);
            }
          }
          return { user: publicUser(user) };
        });
      }
      case 'user-remove': {
        const selector = userSelector(args(['userId', 'username']));
        return this.#mutate((state) => {
          const user = targetUser(state, selector);
          const result: Result = { userId: user._id };
          if (user.username !== undefined) result.username = user.username;
          respawnUser(state, user._id);
          purgeUserRecords(state, user._id);
          context.runtime.removeUser(user._id);
          context.publish('auth:revoked', { user: user._id });
          return result;
        });
      }
      case 'room-generate': {
        const input = args(['room', 'options']);
        const room = roomName(input);
        const options = generateOptions(field(input, 'options'));
        return this.#mutate((state) => {
          domain(() => {
            generateRoom(state.world, room, options);
          });
          context.terrainChanged();
          return { room };
        });
      }
      case 'room-open': {
        const input = args(['room', 'openTime']);
        const room = roomName(input);
        const openTime = optionalInteger(input, 'openTime', 0, MAX_TIMESTAMP);
        return this.#mutate((state) => {
          domain(() => {
            openRoom(state.world, room, openTime);
          });
          context.terrainChanged();
          return { room };
        });
      }
      case 'room-close':
      case 'room-remove': {
        const room = roomName(args(['room']));
        return this.#mutate((state) => {
          domain(() => {
            (action === 'room-close' ? closeRoom : removeRoom)(state.world, room);
          });
          context.terrainChanged();
          return { room };
        });
      }
      case 'portal-create': {
        const input = args(['from', 'to', 'options']);
        const from = roomName(input, 'from');
        const to = roomName(input, 'to');
        const options = portalOptions(field(input, 'options'));
        return this.#mutate((state) => {
          domain(() => {
            createPortalPair(state.world, from, to, options);
          });
          return { from, to };
        });
      }
      case 'terminal-create': {
        const room = roomName(args(['room']));
        return this.#mutate((state) => {
          if (!Object.hasOwn(state.world.rooms, room)) throw new ApiError('room not found', 404);
          const terminal = domain(() => createNpcTerminal(state.world, room));
          return { terminal: { _id: terminal._id, room, x: terminal.x, y: terminal.y } };
        });
      }
      case 'bot-add': {
        const input = args(['name', 'modules', 'room', 'options']);
        const name = text(input, 'name', 64, BOT_NAME);
        const modules = parseModules(field(input, 'modules'));
        const room = roomName(input);
        const options = botOptions(field(input, 'options'));
        return this.#mutate(() => domain(() => spawnBot(context, name, modules, room, options)));
      }
      case 'bot-reload': {
        const input = args(['name', 'modules']);
        const name = text(input, 'name', 64, BOT_NAME);
        const modules = parseModules(field(input, 'modules'));
        return this.#mutate(() => {
          const usernames = reloadBot(context, name, modules);
          if (!usernames.length) throw new ApiError(`no players run bot ${name}`, 404);
          return { usernames };
        });
      }
      case 'bot-remove': {
        const username = text(args(['username']), 'username', 64);
        return this.#mutate((state) => {
          const user = targetUser(state, { username });
          domain(() => {
            removeBot(context, username);
          });
          purgeUserRecords(state, user._id);
          return { userId: user._id, username };
        });
      }
      case 'stronghold-spawn': {
        const input = args(['room', 'options']);
        const room = roomName(input);
        const options = strongholdOptions(field(input, 'options'));
        return this.#mutate((state) => {
          if (options.user !== undefined && !Object.hasOwn(state.world.users, options.user)) {
            throw new ApiError('stronghold owner not found', 404);
          }
          domain(() => {
            spawnStronghold(state.world, room, options);
          });
          return { room };
        });
      }
      case 'stronghold-expand': {
        const room = roomName(args(['room']));
        return this.#mutate((state) => {
          domain(() => {
            expandStrongholdInRoom(state.world, room, context.now());
          });
          return { room };
        });
      }
      case 'stronghold-templates':
        args([]);
        return { templates: strongholdTemplates() };
      case 'maintenance': {
        const name = text(args(['name']), 'name', 64);
        if (!isMaintenanceJobName(name)) {
          throw invalid(
            `maintenance name must be one of ${Object.keys(MAINTENANCE_JOBS).join(', ')}`,
          );
        }
        return this.#mutate((state) => {
          runJob(state, name, context.now());
          return { job: name };
        });
      }
      case 'notifications':
        args([]);
        return context.read(() => ({
          notifications: structuredClone(context.state.notificationOutbox),
        }));
      case 'server-message': {
        const message = text(args(['message']), 'message', MAX_MESSAGE_LENGTH);
        return this.#mutate(() => {
          context.publish('serverMessage', message);
          return {};
        });
      }
      case 'snapshot-export':
        args([]);
        return { snapshot: await this.kernel.exportSnapshot() };
      case 'snapshot-import': {
        const snapshot = field(args(['snapshot']), 'snapshot');
        if (!isRecord(snapshot)) throw invalid('snapshot must be an object');
        domain(() => decodeState(JSON.stringify(snapshot)));
        await this.kernel.importSnapshot(snapshot);
        return {};
      }
      default:
        throw invalid(`unknown action ${JSON.stringify(action.slice(0, 64))}`);
    }
  }
}
