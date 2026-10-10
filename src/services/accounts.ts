/*
 * Account operations: authentication, registration and player data (ports of backend
 * api/auth.js, api/register.js and api/user.js, plus local password sign-in).
 *
 * Portions derived from screeps/backend-local, Copyright (c) 2016, Artem Chivchalov
 * <contact@screeps.com>, used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { Inject, Injectable } from '@nestjs/common';
import { gzipSync } from 'node:zlib';
import {
  cloneBranch,
  deleteBranch,
  findBranch,
  findUserByUsername,
  getUserWorldStatus,
  isUsernameAvailable,
  listBranches,
  normalizeModules,
  ownValue,
  respawnUser,
  saveCode,
  setActiveBranch,
  type CloneBranchOptions,
  type JsonObject,
  type User,
} from '@openscreeps/game';
import {
  ApiError,
  RawResponse,
  requireUser,
  type ApiContext,
  type ApiRequest,
  type ServerContext,
  type ServerState,
} from '../contracts.ts';
import { verifyPassword, verifySteamTicket } from '../api/auth.ts';
import { EMPTY_BADGE_SVG, getBadgeSvg, parseSubmittedBadge, readBadge } from '../api/badge.ts';
import { publicUsers } from '../api/gameplay-support.ts';
import { isRecord } from '../api/guards.ts';
import type { Schemas } from '../generated/api/index.ts';
import {
  createUser,
  EMAIL_PATTERN,
  findUserIdByEmail,
  findUserIdBySteamId,
  setUserPassword,
} from '../api/users.ts';
import { SERVER_CONTEXT } from '../api/transport.ts';

const MAX_CODE_SIZE = 5 * 1024 * 1024;
const MAX_MEMORY_SIZE = 1024 * 1024;
const MAX_SEGMENT_SIZE = 100 * 1024;
const MAX_CONSOLE_SIZE = 1024;
const MAX_BRANCH_NAME = 30;
const MONEY_PAGE_SIZE = 20;
const DEFAULT_START_ROOM = 'W5N5';
/** Statistics windows: interval (minutes per point) -> number of points (backend `overview`). */
const STAT_INTERVALS: Record<number, number> = { 8: 8, 180: 8, 1440: 7 };

type NotifyPrefs = Schemas['UserNotifyPrefs'];
type NotifyInterval = NonNullable<NotifyPrefs['interval']>;
type NotifyErrorsInterval = NonNullable<NotifyPrefs['errorsInterval']>;
const NOTIFY_INTERVALS: readonly NotifyInterval[] = [5, 10, 30, 60, 180, 360, 720, 1440, 4320];
const NOTIFY_ERROR_INTERVALS: readonly NotifyErrorsInterval[] = [
  0, 5, 10, 30, 60, 180, 360, 720, 1440, 4320, 100000,
];

type MoneyLogDoc = ServerState['world']['usersMoney'][string];
type MoneyHistoryEntry = Schemas['UserMoneyHistoryEntry'];
type MoneyHistoryMarketInfo = Schemas['UserMoneyHistoryMarketInfo'];
type MoneyHistoryOrder = NonNullable<MoneyHistoryMarketInfo['order']>;

// --- memory -----------------------------------------------------------------------------------

function parseMemoryPath(path: string): string[] {
  const parts = path.split('.');
  // `__proto__` would address the prototype chain instead of stored data.
  if (parts.some((part) => part === '' || part === '__proto__')) {
    throw new ApiError('Incorrect memory path');
  }
  return parts;
}

/** Hidden console expression applying a `POST /api/user/memory` edit inside the player's VM. */
function memoryExpression(parts: string[] | undefined, json: string | undefined): string {
  const value = json ?? 'undefined';
  if (!parts) {
    return (
      `(function(value) { for (var key in Memory) { delete Memory[key]; } ` +
      `if (value !== null && typeof value === 'object') Object.assign(Memory, value); })(${value});`
    );
  }
  // Intermediate objects are created for assignments; a primitive on the path is an error.
  return (
    `(function(path, value) { var target = Memory; ` +
    `for (var i = 0; i < path.length - 1; i++) { ` +
    `if (target[path[i]] === undefined) { if (value === undefined) return; target[path[i]] = {}; } ` +
    `target = target[path[i]]; ` +
    `if (target === null || typeof target !== 'object') throw new Error('Memory path ' + path.slice(0, i + 1).join('.') + ' is not an object'); } ` +
    `if (value === undefined) delete target[path[path.length - 1]]; else target[path[path.length - 1]] = value; ` +
    `})(${JSON.stringify(parts)}, ${value});`
  );
}

// --- statistics -------------------------------------------------------------------------------

interface StatWindow {
  /** Point index (`Math.ceil(ms / period)`) of each window point, oldest first. */
  endTimes: number[];
  /** Window point of every statistics sample inside the window. */
  samples: Array<{ point: number; sample: ServerState['statistics'][number] }>;
}

function statWindow(context: ServerContext, interval: number): StatWindow {
  const count = STAT_INTERVALS[interval];
  if (count === undefined) throw new ApiError('invalid params');
  const period = interval * 60 * 1000;
  const endTime = Math.ceil(context.now() / period);
  const endTimes = Array.from({ length: count }, (_, index) => endTime - count + 1 + index);
  const first = endTimes[0] ?? endTime;
  const samples: StatWindow['samples'] = [];
  for (const sample of context.state.statistics) {
    const point = Math.ceil((sample.time + 60_000) / period);
    if (point >= first && point <= endTime) samples.push({ point, sample });
  }
  return { endTimes, samples };
}

// --- notification preferences -----------------------------------------------------------------

function isNotifyInterval(value: unknown): value is NotifyInterval {
  return NOTIFY_INTERVALS.some((interval) => interval === value);
}

function isNotifyErrorsInterval(value: unknown): value is NotifyErrorsInterval {
  return NOTIFY_ERROR_INTERVALS.some((interval) => interval === value);
}

/** Stored preferences (written only by `POST /api/user/notify-prefs`) narrowed to the contract. */
function readNotifyPrefs(prefs: JsonObject | undefined): NotifyPrefs | undefined {
  if (!prefs) return undefined;
  const { disabled, disabledOnMessages, sendOnline, interval, errorsInterval } = prefs;
  const result: NotifyPrefs = {};
  if (typeof disabled === 'boolean') result.disabled = disabled;
  if (typeof disabledOnMessages === 'boolean') result.disabledOnMessages = disabledOnMessages;
  if (typeof sendOnline === 'boolean') result.sendOnline = sendOnline;
  if (isNotifyInterval(interval)) result.interval = interval;
  if (isNotifyErrorsInterval(errorsInterval)) result.errorsInterval = errorsInterval;
  return result;
}

// --- credit ledger ----------------------------------------------------------------------------

/** Ledger entry types of the contract; the engine's market processing writes only these. */
function isMoneyHistoryDoc(
  entry: MoneyLogDoc,
): entry is MoneyLogDoc & { type: MoneyHistoryEntry['type'] } {
  return entry.type === 'market.buy' || entry.type === 'market.sell' || entry.type === 'market.fee';
}

/** `market.order` of fee entries: the engine stores the order intent (or refund details) as-is. */
function isMoneyHistoryOrder(value: unknown): value is MoneyHistoryOrder {
  if (!isRecord(value)) return false;
  const { type, resourceType, price, totalAmount, roomName } = value;
  return (
    (type === undefined || type === 'buy' || type === 'sell') &&
    (resourceType === undefined || typeof resourceType === 'string') &&
    (price === undefined || typeof price === 'number') &&
    (totalAmount === undefined || typeof totalAmount === 'number') &&
    (roomName === undefined || typeof roomName === 'string')
  );
}

/** Preserve ledger details; reject an invalid imported order rather than silently hiding it. */
function isMoneyHistoryMarket(
  market: MoneyLogDoc['market'],
): market is MoneyLogDoc['market'] & MoneyHistoryMarketInfo {
  return market.order === undefined || isMoneyHistoryOrder(market.order);
}

// --- profile views ----------------------------------------------------------------------------

function publicUser(context: ServerContext, user: User): Schemas['UserPublicProfile'] {
  const result: Schemas['UserPublicProfile'] = { _id: user._id };
  if (user.username !== undefined) result.username = user.username;
  const badge = readBadge(user.badge);
  if (badge) result.badge = badge;
  if (user.gcl !== undefined) result.gcl = user.gcl;
  if (user.power !== undefined) result.power = user.power;
  const steam = context.state.profiles[user._id]?.steam;
  if (steam && !steam.steamProfileLinkHidden) result.steam = { id: steam.id };
  return result;
}

function controllerRooms(state: ServerState, userId: string): string[] {
  return Object.values(state.world.roomObjects)
    .filter((object) => object.type === 'controller' && object.user === userId)
    .sort((a, b) => (b.level ?? 0) - (a.level ?? 0))
    .map((object) => object.room);
}

@Injectable()
export class AccountsService {
  constructor(@Inject(SERVER_CONTEXT) readonly context: ApiContext) {}

  me(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const profile = this.context.state.profiles[user._id];
    const steam: Schemas['AuthSteamAccount'] = {};
    if (profile?.steam) {
      steam.id = profile.steam.id;
      if (profile.steam.displayName !== undefined) steam.displayName = profile.steam.displayName;
      if (profile.steam.ownership !== undefined) steam.ownership = profile.steam.ownership;
      if (profile.steam.steamProfileLinkHidden !== undefined) {
        steam.steamProfileLinkHidden = profile.steam.steamProfileLinkHidden;
      }
    }
    return {
      _id: user._id,
      email: profile?.email,
      emailDirty: profile?.emailDirty,
      username: user.username,
      cpu: user.cpu,
      badge: readBadge(user.badge),
      password: profile?.passwordHash !== undefined,
      lastRespawnDate: user.lastRespawnDate,
      notifyPrefs: readNotifyPrefs(profile?.notifyPrefs),
      gcl: user.gcl,
      lastChargeTime: profile?.lastChargeTime,
      blocked: user.blocked,
      customBadge: profile?.customBadge,
      power: user.power,
      money: (user.money ?? 0) / 1000,
      steam,
      powerExperimentations: user.powerExperimentations ?? 0,
      powerExperimentationTime: user.powerExperimentationTime ?? 0,
    };
  }

  /** screeps.com `GET /api/user/name`: the signed-in player's username only. */
  name(request: ApiRequest) {
    const user = requireUser(request, this.context);
    // Steam sign-in creates the account before the player chooses a name.
    if (user.username === undefined) throw new ApiError('username not set');
    return { username: user.username };
  }

  signin(request: ApiRequest) {
    const { email: login, password } = request.body;
    if (typeof login !== 'string' || typeof password !== 'string' || login === '') {
      throw new ApiError('unauthorized', 401);
    }
    const { state } = this.context;
    const userId = login.includes('@')
      ? findUserIdByEmail(state, login)
      : findUserByUsername(state, login)?._id;
    const hash = userId === undefined ? undefined : state.profiles[userId]?.passwordHash;
    if (!verifyPassword(password, hash) || userId === undefined) {
      throw new ApiError('unauthorized', 401);
    }
    return { token: this.context.auth.issue(userId) };
  }

  async steamTicket(request: ApiRequest) {
    if (request.body.useNativeAuth) {
      throw new ApiError('authentication method is not supported');
    }
    const { ticket } = request.body;
    if (typeof ticket !== 'string') throw new ApiError('could not authenticate');
    // External verification runs before acquiring the world lock.
    const steamId = await verifySteamTicket(ticket, this.context.config.steamKey);
    return this.context.mutate(() => {
      const userId =
        findUserIdBySteamId(this.context.state, steamId) ??
        createUser(this.context, { steamId })._id;
      return { token: this.context.auth.issue(userId), steamid: steamId };
    });
  }

  checkEmail(request: ApiRequest) {
    const email = request.query.get('email');
    if (!email) throw new ApiError('invalid email');
    if (findUserIdByEmail(this.context.state, email) !== undefined) throw new ApiError('exists');
    return {};
  }

  checkUsername(request: ApiRequest) {
    const username = request.query.get('username');
    if (!username) throw new ApiError('invalid username');
    if (findUserByUsername(this.context.state, username) !== undefined) {
      throw new ApiError('exists');
    }
    return {};
  }

  setUsername(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const { username, email } = request.body;
    let normalizedEmail: string | undefined;
    if (email !== undefined && email !== null && email !== '') {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ApiError('invalid email');
      }
      normalizedEmail = email.toLowerCase();
    }
    if (user.username !== undefined) throw new ApiError('username already set');
    if (typeof username !== 'string' || !isUsernameAvailable(this.context.state, username)) {
      throw new ApiError('invalid username');
    }
    const profile = this.context.state.profiles[user._id];
    if (normalizedEmail !== undefined) {
      const owner = findUserIdByEmail(this.context.state, normalizedEmail);
      if (owner !== undefined && owner !== user._id) throw new ApiError('email already exists');
    }
    user.username = username;
    user.usernameLower = username.toLowerCase();
    if (normalizedEmail !== undefined && profile) profile.email = normalizedEmail;
    return {};
  }

  // --- /api/user: world ---------------------------------------------------------------------
  worldStartRoom(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const rooms = controllerRooms(this.context.state, user._id);
    const owned = rooms[Math.floor(Math.random() * rooms.length)];
    if (owned !== undefined) return { room: [owned] };
    const { rooms: worldRooms } = this.context.state.world;
    if (worldRooms[DEFAULT_START_ROOM]) return { room: [DEFAULT_START_ROOM] };
    const fallback = Object.keys(worldRooms)
      .filter((name) => worldRooms[name]?.status === 'normal')
      .sort()[0];
    return { room: [fallback ?? DEFAULT_START_ROOM] };
  }

  worldStatus(request: ApiRequest) {
    const user = requireUser(request, this.context);
    return { status: getUserWorldStatus(this.context.state.world, user._id) };
  }

  respawnProhibitedRooms(request: ApiRequest) {
    requireUser(request, this.context);
    return { rooms: [] };
  }

  respawn(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const status = getUserWorldStatus(this.context.state.world, user._id);
    if (status !== 'normal' && status !== 'lost') throw new ApiError('invalid status');
    respawnUser(this.context.state, user._id);
    user.lastRespawnDate = this.context.now();
    return {};
  }

  rooms(request: ApiRequest) {
    const id = request.query.get('id') ?? '';
    return { rooms: controllerRooms(this.context.state, id) };
  }

  // --- /api/user: code branches -------------------------------------------------------------
  branches(request: ApiRequest) {
    const user = requireUser(request, this.context);
    return { list: structuredClone(listBranches(this.context, user._id)) };
  }

  saveCode(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const { body } = request;
    if (body.modules !== undefined && JSON.stringify(body.modules).length > MAX_CODE_SIZE) {
      throw new ApiError('code length exceeds 5 MB limit');
    }
    const modules = normalizeModules(body.modules);
    const selector =
      typeof body.branch === 'string' && body.branch !== '' ? body.branch : '$activeWorld';
    const branch = saveCode(this.context, user._id, modules, selector);
    const hash = body._hash;
    const event: JsonObject = { id: branch._id };
    if (typeof hash === 'string' || typeof hash === 'number') event.hash = hash;
    this.context.publish(`user:${user._id}/code`, event);
    return { timestamp: this.context.now() };
  }

  code(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const branch = findBranch(
      this.context.state,
      user._id,
      request.query.get('branch') || '$activeWorld',
    );
    if (!branch) throw new ApiError('no code');
    return { branch: branch.branch, modules: structuredClone(branch.modules) };
  }

  setActiveBranch(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const { activeName, branch: name } = request.body;
    if (activeName !== 'activeWorld' && activeName !== 'activeSim') {
      throw new ApiError('invalid params');
    }
    const target = setActiveBranch(this.context, user._id, activeName, name);
    this.context.publish(`user:${user._id}/set-active-branch`, {
      activeName,
      branch: target.branch,
    });
    return {};
  }

  cloneBranch(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const { branch: source, newName, defaultModules } = request.body;
    if (
      source !== undefined &&
      source !== null &&
      source !== '' &&
      (typeof source !== 'string' || source.length > MAX_BRANCH_NAME)
    ) {
      throw new ApiError('invalid branch name');
    }
    if (
      typeof newName !== 'string' ||
      newName === '' ||
      newName.length > MAX_BRANCH_NAME ||
      newName.startsWith('$')
    ) {
      throw new ApiError('invalid branch name');
    }
    const options: CloneBranchOptions = { newName, defaultModules };
    if (typeof source === 'string') options.source = source;
    const target = cloneBranch(this.context, user._id, options);
    if (target.timestamp === undefined) throw new Error('Cloned branch has no timestamp');
    this.context.publish(`user:${user._id}/code`, { id: target._id });
    // `cloneBranch` stamps every created or overwritten branch with the current time.
    return { timestamp: target.timestamp };
  }

  deleteBranch(request: ApiRequest) {
    const user = requireUser(request, this.context);
    deleteBranch(this.context.state, user._id, request.body.branch);
    return { timestamp: this.context.now() };
  }

  // --- /api/user: memory and console --------------------------------------------------------
  memory(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const path = request.query.get('path');
    let current: unknown;
    try {
      current = JSON.parse(this.context.runtime.getMemory(user._id) || '{}');
      if (path) {
        for (const part of parseMemoryPath(path)) {
          if (current === null || current === undefined)
            throw new ApiError('Incorrect memory path');
          const container = new Object(current);
          current = Object.hasOwn(container, part) ? Reflect.get(container, part) : undefined;
        }
      }
    } catch {
      return { data: 'Incorrect memory path' };
    }
    if (current === undefined) return {};
    return { data: 'gz:' + gzipSync(JSON.stringify(current)).toString('base64') };
  }

  setMemory(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const { path, value } = request.body;
    const json = value === undefined ? undefined : JSON.stringify(value);
    if (json !== undefined && json.length > MAX_MEMORY_SIZE) {
      throw new ApiError('memory size is too large');
    }
    let parts: string[] | undefined;
    if (path !== undefined && path !== null && path !== '') {
      if (typeof path !== 'string') throw new ApiError('Incorrect memory path');
      parts = parseMemoryPath(path);
    }
    this.context.runtime.enqueueConsoleCommand(user._id, memoryExpression(parts, json), true);
    return {};
  }

  memorySegment(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const id = Number.parseInt(request.query.get('segment') ?? '', 10);
    if (Number.isNaN(id) || id < 0 || id > 99) throw new ApiError('invalid segment ID');
    return { data: this.context.runtime.getSegment(user._id, id) ?? null };
  }

  setMemorySegment(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const { segment, data } = request.body;
    const id = Number.parseInt(String(segment), 10);
    if (Number.isNaN(id) || id < 0 || id > 99) throw new ApiError('invalid segment ID');
    if (typeof data !== 'string' && typeof data !== 'number' && typeof data !== 'boolean') {
      throw new ApiError('invalid params');
    }
    const text = String(data);
    if (text.length > MAX_SEGMENT_SIZE) throw new ApiError('length limit exceeded');
    this.context.runtime.setSegment(user._id, id, text);
    return {};
  }

  console(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const { expression } = request.body;
    if (typeof expression !== 'string') throw new ApiError('invalid params');
    if (JSON.stringify(expression).length > MAX_CONSOLE_SIZE) {
      throw new ApiError('expression size is too large');
    }
    this.context.runtime.enqueueConsoleCommand(user._id, expression);
    return {};
  }

  // --- /api/user: profile -------------------------------------------------------------------
  find(request: ApiRequest) {
    const username = request.query.get('username');
    const id = request.query.get('id');
    const user = id
      ? ownValue(this.context.state.world.users, id)
      : username
        ? findUserByUsername(this.context.state, username)
        : undefined;
    if (!user) throw new ApiError('user not found');
    return { user: publicUser(this.context, user) };
  }

  badge(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const badge = parseSubmittedBadge(
      request.body.badge,
      this.context.state.profiles[user._id]?.customBadge,
    );
    if (!badge) throw new ApiError('invalid params');
    user.badge = badge;
    return {};
  }

  badgeSvg(request: ApiRequest) {
    const username = request.query.get('username');
    const user = username ? findUserByUsername(this.context.state, username) : undefined;
    if (!user) return new RawResponse('Not Found', 'text/plain; charset=utf-8', 404);
    const badge = readBadge(user.badge);
    const svg = badge ? getBadgeSvg(badge, request.query.get('border') === '1') : EMPTY_BADGE_SVG;
    return new RawResponse(svg, 'image/svg+xml; charset=utf-8');
  }

  notifyPrefs(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const profile = this.context.state.profiles[user._id];
    if (!profile) throw new ApiError('unauthorized', 401);
    const prefs = (profile.notifyPrefs ??= {});
    const { body } = request;
    if (body.disabled !== undefined) prefs.disabled = Boolean(body.disabled);
    if (body.disabledOnMessages !== undefined) {
      prefs.disabledOnMessages = Boolean(body.disabledOnMessages);
    }
    if (body.sendOnline !== undefined) prefs.sendOnline = Boolean(body.sendOnline);
    const interval = Number(body.interval);
    if (isNotifyInterval(interval)) prefs.interval = interval;
    const errorsInterval = Number(body.errorsInterval);
    if (isNotifyErrorsInterval(errorsInterval)) prefs.errorsInterval = errorsInterval;
    return {};
  }

  email(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const { email } = request.body;
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ApiError('invalid email');
    }
    const normalized = email.toLowerCase();
    if (findUserIdByEmail(this.context.state, normalized) !== undefined) {
      throw new ApiError('email already exists');
    }
    const profile = this.context.state.profiles[user._id];
    if (!profile) throw new ApiError('unauthorized', 401);
    profile.email = normalized;
    return {};
  }

  setSteamVisible(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const steam = this.context.state.profiles[user._id]?.steam;
    if (steam) steam.steamProfileLinkHidden = !request.body.visible;
    return {};
  }

  tutorialDone(request: ApiRequest) {
    requireUser(request, this.context);
    return {};
  }

  /**
   * Official account page password change (`{oldPassword, password}`). An account without a
   * local password (Steam sign-up) sets its first one with the form's empty `oldPassword`.
   * Every session of the account is revoked, including the token refreshed for this request.
   */
  setPassword(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const { oldPassword, password } = request.body;
    if (typeof oldPassword !== 'string' || typeof password !== 'string') {
      throw new ApiError('invalid params');
    }
    const hash = this.context.state.profiles[user._id]?.passwordHash;
    const verified = hash === undefined ? oldPassword === '' : verifyPassword(oldPassword, hash);
    if (!verified) throw new ApiError('invalid password');
    setUserPassword(this.context, user._id, password);
    return {};
  }

  moneyHistory(request: ApiRequest): {
    page: number;
    list: MoneyHistoryEntry[];
    hasMore: boolean;
  } {
    const user = requireUser(request, this.context);
    const page = Math.max(0, Number.parseInt(request.query.get('page') ?? '', 10) || 0);
    const entries = Object.values(this.context.state.world.usersMoney)
      .filter((entry) => entry.user === user._id)
      .sort((a, b) => b.date - a.date || b.tick - a.tick);
    const start = page * MONEY_PAGE_SIZE;
    return {
      page,
      list: entries.slice(start, start + MONEY_PAGE_SIZE).map((entry) => {
        if (!isMoneyHistoryDoc(entry) || !isMoneyHistoryMarket(entry.market)) {
          throw new Error('Invalid credit ledger projection');
        }
        return {
          ...entry,
          // Upstream's storage RPC serializes the processor's Date to an ISO string.
          date: new Date(entry.date).toISOString(),
          market: entry.market,
        };
      }),
      hasMore: entries.length > start + MONEY_PAGE_SIZE,
    };
  }

  /**
   * Counterparties of one market deal of the caller's credit ledger (official market history
   * `getDetails`): the `market.buy`/`market.sell` entries recorded at `tick` between `roomName`
   * and `targetRoomName`, with public profiles. Balances of other players are never returned,
   * and a deal the caller took no part in resolves to no entries.
   */
  moneyHistoryDetails(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const tick = Number.parseInt(request.query.get('tick') ?? '', 10);
    if (Number.isNaN(tick)) throw new ApiError('invalid params');
    const roomName = request.query.get('roomName') ?? undefined;
    const targetRoomName = request.query.get('targetRoomName') ?? undefined;
    const deal = Object.values(this.context.state.world.usersMoney).filter(
      (entry) =>
        entry.tick === tick &&
        (entry.type === 'market.buy' || entry.type === 'market.sell') &&
        entry.market.roomName === roomName &&
        entry.market.targetRoomName === targetRoomName,
    );
    if (!deal.some((entry) => entry.user === user._id)) return { orders: [], users: {} };
    const { world } = this.context.state;
    return {
      orders: deal.map((entry) => ({ user: entry.user, type: entry.type })),
      users: structuredClone(publicUsers(world, new Set(deal.map((entry) => entry.user)))),
    };
  }

  // --- /api/user: statistics ----------------------------------------------------------------
  stats(request: ApiRequest) {
    const interval = Number.parseInt(request.query.get('interval') ?? '', 10);
    if (STAT_INTERVALS[interval] === undefined) throw new ApiError('invalid params');
    const id = request.query.get('id') ?? request.userId;
    if (id === undefined || !ownValue(this.context.state.world.users, id)) {
      throw new ApiError('user not found');
    }
    const stats: Record<string, number> = {};
    for (const { sample } of statWindow(this.context, interval).samples) {
      for (const users of Object.values(sample.rooms)) {
        for (const [name, value] of Object.entries(users[id] ?? {})) {
          stats[name] = (stats[name] ?? 0) + value;
        }
      }
    }
    return { stats };
  }

  overview(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const interval = Number.parseInt(request.query.get('interval') ?? '', 10) || 8;
    const statName = request.query.get('statName') || 'energyHarvested';
    const window = statWindow(this.context, interval);
    const rooms = controllerRooms(this.context.state, user._id);
    const values: Record<string, Record<number, number>> = {};
    const totals: Record<string, number> = {};
    const gametimes: Record<number, number> = {};
    for (const { point, sample } of window.samples) {
      gametimes[point] = Math.max(gametimes[point] ?? 0, sample.tick);
      for (const [room, users] of Object.entries(sample.rooms)) {
        const own = users[user._id];
        if (!own) continue;
        for (const [name, value] of Object.entries(own)) {
          totals[name] = (totals[name] ?? 0) + value;
        }
        const value = own[statName];
        if (value !== undefined) {
          const points = (values[room] ??= {});
          points[point] = (points[point] ?? 0) + value;
        }
      }
    }
    let statsMax = 0;
    const stats: Record<string, Array<{ value: number; endTime: number }>> = {};
    for (const room of rooms) {
      stats[room] = window.endTimes.map((endTime) => {
        const value = values[room]?.[endTime] ?? 0;
        statsMax = Math.max(statsMax, value);
        return { value, endTime };
      });
    }
    return {
      rooms,
      stats,
      statsMax,
      totals,
      gametimes: window.endTimes.map((endTime) => gametimes[endTime] ?? null),
    };
  }
}
