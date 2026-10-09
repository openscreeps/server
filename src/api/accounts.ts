/*
 * Account HTTP API: `/api/auth`, `/api/register` and `/api/user` (ports of backend `api/auth.js`,
 * `api/register.js`, `api/user.js` and `api/user-messages.js`, plus local password sign-in).
 *
 * Portions derived from screeps/backend-local, Copyright (c) 2016, Artem Chivchalov
 * <contact@screeps.com>, used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { gzipSync } from 'node:zlib';
import type { CodeModules } from '@openscreeps/engine';
import {
  ApiError,
  newId,
  RawResponse,
  requireUser,
  type ApiRoute,
  type CodeBranch,
  type JsonObject,
  type ServerContext,
  type ServerState,
  type User,
} from '../contracts.ts';
import { getUserWorldStatus, respawnUser } from '../world/index.ts';
import { verifyPassword, verifySteamTicket } from './auth.ts';
import { EMPTY_BADGE_SVG, getBadgeSvg, parseSubmittedBadge, readBadge } from './badge.ts';
import { ownValue } from './gameplay-support.ts';
import { isRecord } from './guards.ts';
import { messageRoutes } from './messages.ts';
import {
  createUser,
  EMAIL_PATTERN,
  findUserByUsername,
  findUserIdByEmail,
  findUserIdBySteamId,
  isUsernameAvailable,
} from './users.ts';

const MAX_CODE_SIZE = 5 * 1024 * 1024;
const MAX_MEMORY_SIZE = 1024 * 1024;
const MAX_SEGMENT_SIZE = 100 * 1024;
const MAX_CONSOLE_SIZE = 1024;
const MAX_BRANCHES = 30;
const MAX_BRANCH_NAME = 30;
const MONEY_PAGE_SIZE = 20;
const DEFAULT_START_ROOM = 'W5N5';
/** Statistics windows: interval (minutes per point) -> number of points (backend `overview`). */
const STAT_INTERVALS: Record<number, number> = { 8: 8, 180: 8, 1440: 7 };
const NOTIFY_INTERVALS = [5, 10, 30, 60, 180, 360, 720, 1440, 4320];
const NOTIFY_ERROR_INTERVALS = [0, 5, 10, 30, 60, 180, 360, 720, 1440, 4320, 100000];

// --- code branches --------------------------------------------------------------------------

function userBranches(state: ServerState, userId: string): CodeBranch[] {
  return Object.values(state.branches).filter((branch) => branch.user === userId);
}

/** Backend branch query: `$activeWorld` / `$activeSim` select the active branch, else by name. */
function findBranch(state: ServerState, userId: string, selector: string): CodeBranch | undefined {
  const branches = userBranches(state, userId);
  if (selector === '$activeWorld') return branches.find((branch) => branch.activeWorld);
  if (selector === '$activeSim') return branches.find((branch) => branch.activeSim);
  return branches.find((branch) => branch.branch === selector);
}

/**
 * Backend `translateModulesToDb` semantics on untrusted input: module names whose stored form
 * would start with `$` (leading `$`, `.`, `/` or `\`) are dropped and `main` always exists.
 * Values are source text or `{binary: base64}`.
 */
function parseModules(value: unknown): CodeModules {
  if (!isRecord(value)) throw new ApiError('invalid params');
  const modules: CodeModules = {};
  for (const [name, source] of Object.entries(value)) {
    if (/^[$./\\]/.test(name) || name === '__proto__') continue;
    if (typeof source === 'string') {
      modules[name] = source;
    } else if (isRecord(source) && typeof source.binary === 'string') {
      modules[name] = { binary: source.binary };
    } else {
      throw new ApiError('invalid params');
    }
  }
  if (modules.main === undefined) modules.main = '';
  return modules;
}

/** Keeps the runtime's world code in lockstep with the `activeWorld` branch. */
function syncWorldCode(context: ServerContext, branch: CodeBranch): void {
  if (branch.activeWorld) context.runtime.setCode(branch.user, branch.modules, branch.branch);
}

function createBranch(
  state: ServerState,
  userId: string,
  name: string,
  modules: CodeModules,
  timestamp: number,
): CodeBranch {
  const branch: CodeBranch = {
    _id: newId(state),
    user: userId,
    branch: name,
    modules,
    activeWorld: false,
    activeSim: false,
    timestamp,
  };
  state.branches[branch._id] = branch;
  return branch;
}

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

// --- profile views ----------------------------------------------------------------------------

function publicUser(context: ServerContext, user: User): Record<string, unknown> {
  const result: Record<string, unknown> = { _id: user._id };
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

export const accountRoutes: readonly ApiRoute[] = [
  // --- /api/auth --------------------------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/auth/me',
    auth: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const profile = context.state.profiles[user._id];
      const steam: JsonObject = {};
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
        badge: user.badge,
        password: profile?.passwordHash !== undefined,
        lastRespawnDate: user.lastRespawnDate,
        notifyPrefs: profile?.notifyPrefs,
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
    },
  },
  {
    method: 'POST',
    path: '/api/auth/signin',
    write: true,
    handle(request, context) {
      const { email: login, password } = request.body;
      if (typeof login !== 'string' || typeof password !== 'string' || login === '') {
        throw new ApiError('unauthorized', 401);
      }
      const { state } = context;
      const userId = login.includes('@')
        ? findUserIdByEmail(state, login)
        : findUserByUsername(state, login)?._id;
      const hash = userId === undefined ? undefined : state.profiles[userId]?.passwordHash;
      if (!verifyPassword(password, hash) || userId === undefined) {
        throw new ApiError('unauthorized', 401);
      }
      return { token: context.auth.issue(userId) };
    },
  },
  {
    method: 'POST',
    path: '/api/auth/steam-ticket',
    write: true,
    async prepare(request, context) {
      if (request.body.useNativeAuth) {
        throw new ApiError('authentication method is not supported');
      }
      const { ticket } = request.body;
      if (typeof ticket !== 'string') throw new ApiError('could not authenticate');
      return { steamId: await verifySteamTicket(ticket, context.config.steamKey) };
    },
    handle(request, context) {
      const { prepared } = request;
      if (!isRecord(prepared) || typeof prepared.steamId !== 'string') {
        throw new ApiError('could not authenticate');
      }
      const steamId = prepared.steamId;
      const userId =
        findUserIdBySteamId(context.state, steamId) ?? createUser(context, { steamId })._id;
      return { token: context.auth.issue(userId), steamid: steamId };
    },
  },

  // --- /api/register ----------------------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/register/check-email',
    handle(request, context) {
      const email = request.query.get('email');
      if (!email) throw new ApiError('invalid email');
      if (findUserIdByEmail(context.state, email) !== undefined) throw new ApiError('exists');
      return {};
    },
  },
  {
    method: 'GET',
    path: '/api/register/check-username',
    handle(request, context) {
      const username = request.query.get('username');
      if (!username) throw new ApiError('invalid username');
      if (findUserByUsername(context.state, username) !== undefined) {
        throw new ApiError('exists');
      }
      return {};
    },
  },
  {
    method: 'POST',
    path: '/api/register/set-username',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { username, email } = request.body;
      let normalizedEmail: string | undefined;
      if (email !== undefined && email !== null && email !== '') {
        if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
          throw new ApiError('invalid email');
        }
        normalizedEmail = email.toLowerCase();
      }
      if (user.username !== undefined) throw new ApiError('username already set');
      if (typeof username !== 'string' || !isUsernameAvailable(context.state, username)) {
        throw new ApiError('invalid username');
      }
      const profile = context.state.profiles[user._id];
      if (normalizedEmail !== undefined) {
        const owner = findUserIdByEmail(context.state, normalizedEmail);
        if (owner !== undefined && owner !== user._id) throw new ApiError('email already exists');
      }
      user.username = username;
      user.usernameLower = username.toLowerCase();
      if (normalizedEmail !== undefined && profile) profile.email = normalizedEmail;
      return {};
    },
  },

  // --- /api/user: world ---------------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/user/world-start-room',
    auth: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const rooms = controllerRooms(context.state, user._id);
      if (rooms.length > 0) {
        return { room: [rooms[Math.floor(Math.random() * rooms.length)]] };
      }
      const { rooms: worldRooms } = context.state.world;
      if (worldRooms[DEFAULT_START_ROOM]) return { room: [DEFAULT_START_ROOM] };
      const fallback = Object.keys(worldRooms)
        .filter((name) => worldRooms[name]?.status === 'normal')
        .sort()[0];
      return { room: [fallback ?? DEFAULT_START_ROOM] };
    },
  },
  {
    method: 'GET',
    path: '/api/user/world-status',
    auth: true,
    handle(request, context) {
      const user = requireUser(request, context);
      return { status: getUserWorldStatus(context.state.world, user._id) };
    },
  },
  {
    method: 'GET',
    path: '/api/user/respawn-prohibited-rooms',
    auth: true,
    handle(request, context) {
      requireUser(request, context);
      return { rooms: [] };
    },
  },
  {
    method: 'POST',
    path: '/api/user/respawn',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const status = getUserWorldStatus(context.state.world, user._id);
      if (status !== 'normal' && status !== 'lost') throw new ApiError('invalid status');
      respawnUser(context.state, user._id);
      user.lastRespawnDate = context.now();
      return {};
    },
  },
  {
    method: 'GET',
    path: '/api/user/rooms',
    handle(request, context) {
      const id = request.query.get('id') ?? '';
      return { rooms: controllerRooms(context.state, id) };
    },
  },

  // --- /api/user: code branches -------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/user/branches',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { state } = context;
      if (!userBranches(state, user._id).some((branch) => branch.branch === 'default')) {
        createBranch(state, user._id, 'default', { main: '' }, context.now());
      }
      return { list: structuredClone(userBranches(state, user._id)) };
    },
  },
  {
    method: 'POST',
    path: '/api/user/code',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { body } = request;
      if (body.modules !== undefined && JSON.stringify(body.modules).length > MAX_CODE_SIZE) {
        throw new ApiError('code length exceeds 5 MB limit');
      }
      const modules = parseModules(body.modules);
      const selector =
        typeof body.branch === 'string' && body.branch !== '' ? body.branch : '$activeWorld';
      const branch = findBranch(context.state, user._id, selector);
      if (!branch) throw new ApiError('branch does not exist');
      user.active = 10000;
      branch.modules = modules;
      branch.timestamp = context.now();
      syncWorldCode(context, branch);
      const hash = body._hash;
      const event: JsonObject = { id: branch._id };
      if (typeof hash === 'string' || typeof hash === 'number') event.hash = hash;
      context.publish(`user:${user._id}/code`, event);
      return { timestamp: context.now() };
    },
  },
  {
    method: 'GET',
    path: '/api/user/code',
    auth: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const branch = findBranch(
        context.state,
        user._id,
        request.query.get('branch') || '$activeWorld',
      );
      if (!branch) throw new ApiError('no code');
      return { branch: branch.branch, modules: structuredClone(branch.modules) };
    },
  },
  {
    method: 'POST',
    path: '/api/user/set-active-branch',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { activeName, branch: name } = request.body;
      if (activeName !== 'activeWorld' && activeName !== 'activeSim') {
        throw new ApiError('invalid params');
      }
      const target =
        typeof name === 'string'
          ? userBranches(context.state, user._id).find((branch) => branch.branch === name)
          : undefined;
      if (!target) throw new ApiError('no branch');
      for (const branch of userBranches(context.state, user._id)) branch[activeName] = false;
      target[activeName] = true;
      if (activeName === 'activeWorld') syncWorldCode(context, target);
      context.publish(`user:${user._id}/set-active-branch`, { activeName, branch: target.branch });
      return {};
    },
  },
  {
    method: 'POST',
    path: '/api/user/clone-branch',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
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
      const { state } = context;
      const branches = userBranches(state, user._id);
      const existing = branches.find((branch) => branch.branch === newName);
      if (!existing && !/^tutorial-\d$/.test(newName) && branches.length >= MAX_BRANCHES) {
        throw new ApiError('too many branches');
      }
      const sourceBranch =
        typeof source === 'string' && source !== ''
          ? branches.find((branch) => branch.branch === source)
          : undefined;
      const modules = sourceBranch
        ? structuredClone(sourceBranch.modules)
        : defaultModules
          ? parseModules(defaultModules)
          : { main: '' };
      const now = context.now();
      let target: CodeBranch;
      if (existing) {
        existing.modules = modules;
        existing.timestamp = now;
        syncWorldCode(context, existing);
        target = existing;
      } else {
        target = createBranch(state, user._id, newName, modules, now);
      }
      context.publish(`user:${user._id}/code`, { id: target._id });
      return { timestamp: now };
    },
  },
  {
    method: 'POST',
    path: '/api/user/delete-branch',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { branch: name } = request.body;
      for (const branch of userBranches(context.state, user._id)) {
        if (branch.branch === name && !branch.activeWorld && !branch.activeSim) {
          Reflect.deleteProperty(context.state.branches, branch._id);
        }
      }
      return { timestamp: context.now() };
    },
  },

  // --- /api/user: memory and console --------------------------------------------------------
  {
    method: 'GET',
    path: '/api/user/memory',
    auth: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const path = request.query.get('path');
      let current: unknown;
      try {
        current = JSON.parse(context.runtime.getMemory(user._id) || '{}');
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
    },
  },
  {
    method: 'POST',
    path: '/api/user/memory',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
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
      context.runtime.enqueueConsoleCommand(user._id, memoryExpression(parts, json), true);
      return {};
    },
  },
  {
    method: 'GET',
    path: '/api/user/memory-segment',
    auth: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const id = Number.parseInt(request.query.get('segment') ?? '', 10);
      if (Number.isNaN(id) || id < 0 || id > 99) throw new ApiError('invalid segment ID');
      return { data: context.runtime.getSegment(user._id, id) ?? null };
    },
  },
  {
    method: 'POST',
    path: '/api/user/memory-segment',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { segment, data } = request.body;
      const id = Number.parseInt(String(segment), 10);
      if (Number.isNaN(id) || id < 0 || id > 99) throw new ApiError('invalid segment ID');
      if (typeof data !== 'string' && typeof data !== 'number' && typeof data !== 'boolean') {
        throw new ApiError('invalid params');
      }
      const text = String(data);
      if (text.length > MAX_SEGMENT_SIZE) throw new ApiError('length limit exceeded');
      context.runtime.setSegment(user._id, id, text);
      return {};
    },
  },
  {
    method: 'POST',
    path: '/api/user/console',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { expression } = request.body;
      if (typeof expression !== 'string') throw new ApiError('invalid params');
      if (JSON.stringify(expression).length > MAX_CONSOLE_SIZE) {
        throw new ApiError('expression size is too large');
      }
      context.runtime.enqueueConsoleCommand(user._id, expression);
      return {};
    },
  },

  // --- /api/user: profile -------------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/user/find',
    handle(request, context) {
      const username = request.query.get('username');
      const id = request.query.get('id');
      const user = id
        ? ownValue(context.state.world.users, id)
        : username
          ? findUserByUsername(context.state, username)
          : undefined;
      if (!user) throw new ApiError('user not found');
      return { user: publicUser(context, user) };
    },
  },
  {
    method: 'POST',
    path: '/api/user/badge',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const badge = parseSubmittedBadge(
        request.body.badge,
        context.state.profiles[user._id]?.customBadge,
      );
      if (!badge) throw new ApiError('invalid params');
      user.badge = badge;
      return {};
    },
  },
  {
    method: 'GET',
    path: '/api/user/badge-svg',
    handle(request, context) {
      const username = request.query.get('username');
      const user = username ? findUserByUsername(context.state, username) : undefined;
      if (!user) return new RawResponse('Not Found', 'text/plain; charset=utf-8', 404);
      const badge = readBadge(user.badge);
      const svg = badge ? getBadgeSvg(badge, request.query.get('border') === '1') : EMPTY_BADGE_SVG;
      return new RawResponse(svg, 'image/svg+xml; charset=utf-8');
    },
  },
  {
    method: 'POST',
    path: '/api/user/notify-prefs',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const profile = context.state.profiles[user._id];
      if (!profile) throw new ApiError('unauthorized', 401);
      const prefs = (profile.notifyPrefs ??= {});
      const { body } = request;
      if (body.disabled !== undefined) prefs.disabled = Boolean(body.disabled);
      if (body.disabledOnMessages !== undefined) {
        prefs.disabledOnMessages = Boolean(body.disabledOnMessages);
      }
      if (body.sendOnline !== undefined) prefs.sendOnline = Boolean(body.sendOnline);
      const interval = Number(body.interval);
      if (NOTIFY_INTERVALS.includes(interval)) prefs.interval = interval;
      const errorsInterval = Number(body.errorsInterval);
      if (NOTIFY_ERROR_INTERVALS.includes(errorsInterval)) prefs.errorsInterval = errorsInterval;
      return {};
    },
  },
  {
    method: 'POST',
    path: '/api/user/email',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { email } = request.body;
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ApiError('invalid email');
      }
      const normalized = email.toLowerCase();
      if (findUserIdByEmail(context.state, normalized) !== undefined) {
        throw new ApiError('email already exists');
      }
      const profile = context.state.profiles[user._id];
      if (!profile) throw new ApiError('unauthorized', 401);
      profile.email = normalized;
      return {};
    },
  },
  {
    method: 'POST',
    path: '/api/user/set-steam-visible',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const steam = context.state.profiles[user._id]?.steam;
      if (steam) steam.steamProfileLinkHidden = !request.body.visible;
      return {};
    },
  },
  {
    method: 'POST',
    path: '/api/user/tutorial-done',
    auth: true,
    handle(request, context) {
      requireUser(request, context);
      return {};
    },
  },
  {
    method: 'GET',
    path: '/api/user/money-history',
    auth: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const page = Math.max(0, Number.parseInt(request.query.get('page') ?? '', 10) || 0);
      const entries = Object.values(context.state.world.usersMoney)
        .filter((entry) => entry.user === user._id)
        .sort((a, b) => b.date - a.date || b.tick - a.tick);
      const start = page * MONEY_PAGE_SIZE;
      return {
        page,
        list: entries.slice(start, start + MONEY_PAGE_SIZE),
        hasMore: entries.length > start + MONEY_PAGE_SIZE,
      };
    },
  },

  // --- /api/user: statistics ----------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/user/stats',
    handle(request, context) {
      const interval = Number.parseInt(request.query.get('interval') ?? '', 10);
      if (STAT_INTERVALS[interval] === undefined) throw new ApiError('invalid params');
      const id = request.query.get('id') ?? request.userId;
      if (id === undefined || !ownValue(context.state.world.users, id)) {
        throw new ApiError('user not found');
      }
      const stats: Record<string, number> = {};
      for (const { sample } of statWindow(context, interval).samples) {
        for (const users of Object.values(sample.rooms)) {
          for (const [name, value] of Object.entries(users[id] ?? {})) {
            stats[name] = (stats[name] ?? 0) + value;
          }
        }
      }
      return { stats };
    },
  },
  {
    method: 'GET',
    path: '/api/user/overview',
    auth: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const interval = Number.parseInt(request.query.get('interval') ?? '', 10) || 8;
      const statName = request.query.get('statName') || 'energyHarvested';
      const window = statWindow(context, interval);
      const rooms = controllerRooms(context.state, user._id);
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
    },
  },

  ...messageRoutes,
];
