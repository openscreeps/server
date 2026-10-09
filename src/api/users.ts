/*
 * Account registry: user creation (backend `steamFindOrCreateUser` / CLI bot spawn documents),
 * identity validation and local password credentials.
 */

import { constants, type CodeModules } from '@openscreeps/engine';
import {
  ApiError,
  newId,
  type ServerContext,
  type ServerState,
  type User,
  type UserProfile,
} from '../contracts.ts';
import { hashPassword } from './auth.ts';
import type { Badge } from './badge.ts';

/** Backend `register/set-username` username rule. */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,}$/;
/** Backend email rule (`register/set-username`, `user/email`). */
export const EMAIL_PATTERN = /^[\w.+&-]+@[\w.&-]+\.[\w.&-]{2,}$/;
const STEAM_ID_PATTERN = /^\d{1,20}$/;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 1024;

export interface CreateUserOptions {
  username?: string;
  password?: string;
  steamId?: string;
  email?: string;
  /** CPU limit; default 100. */
  cpu?: number;
  /** Raw GCL points; default 0. */
  gcl?: number;
  /** Bot AI name for NPC players. */
  bot?: string;
  active?: number;
  badge?: Badge;
  /** CPU bucket; default 0. */
  cpuAvailable?: number;
  /** Code of the `default` branch (active in world and simulation); default `{main: ''}`. */
  modules?: CodeModules;
}

export function findUserByUsername(state: ServerState, username: string): User | undefined {
  const lower = username.toLowerCase();
  return Object.values(state.world.users).find((user) => user.usernameLower === lower);
}

export function findUserIdByEmail(state: ServerState, email: string): string | undefined {
  const lower = email.toLowerCase();
  return Object.keys(state.profiles).find((id) => state.profiles[id]?.email === lower);
}

export function findUserIdBySteamId(state: ServerState, steamId: string): string | undefined {
  return Object.keys(state.profiles).find((id) => state.profiles[id]?.steam?.id === steamId);
}

/** Usernames are unique case-insensitively; the system account name can never be claimed. */
export function isUsernameAvailable(state: ServerState, username: string): boolean {
  return (
    USERNAME_PATTERN.test(username) &&
    username.toLowerCase() !== constants.SYSTEM_USERNAME.toLowerCase() &&
    findUserByUsername(state, username) === undefined
  );
}

function validatePassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new ApiError(
      `password must be ${String(PASSWORD_MIN_LENGTH)}-${String(PASSWORD_MAX_LENGTH)} characters long`,
    );
  }
}

/**
 * Creates a player: `users` document, private profile, `default` code branch active in world and
 * simulation, runtime code and empty `Memory`. Synchronous; call while holding the context lock.
 */
export function createUser(context: ServerContext, options: CreateUserOptions): User {
  const { state } = context;
  const { username, password, steamId } = options;
  if (username === undefined && steamId === undefined) {
    throw new ApiError('username or steam id required');
  }
  if (username !== undefined) {
    if (!USERNAME_PATTERN.test(username)) throw new ApiError('invalid username');
    if (!isUsernameAvailable(state, username)) throw new ApiError('username already exists');
  }
  let email: string | undefined;
  if (options.email !== undefined) {
    if (!EMAIL_PATTERN.test(options.email)) throw new ApiError('invalid email');
    email = options.email.toLowerCase();
    if (findUserIdByEmail(state, email) !== undefined) throw new ApiError('email already exists');
  }
  if (steamId !== undefined) {
    if (!STEAM_ID_PATTERN.test(steamId)) throw new ApiError('invalid steam id');
    if (findUserIdBySteamId(state, steamId) !== undefined) {
      throw new ApiError('steam id already exists');
    }
  }
  if (password !== undefined) {
    if (username === undefined) throw new ApiError('password sign-in requires a username');
    validatePassword(password);
  }

  const now = context.now();
  const id = newId(state);
  const user: User = {
    _id: id,
    cpu: options.cpu ?? 100,
    cpuAvailable: options.cpuAvailable ?? 0,
    gcl: options.gcl ?? 0,
    money: 0,
    rooms: [],
  };
  if (username !== undefined) {
    user.username = username;
    user.usernameLower = username.toLowerCase();
  }
  if (options.bot !== undefined) user.bot = options.bot;
  else user.powerExperimentations = 30;
  if (options.active !== undefined) user.active = options.active;
  if (options.badge !== undefined) user.badge = structuredClone(options.badge);

  const profile: UserProfile = { registeredDate: now };
  if (email !== undefined) profile.email = email;
  if (password !== undefined) profile.passwordHash = hashPassword(password);
  if (steamId !== undefined) profile.steam = { id: steamId };

  const modules = structuredClone(options.modules ?? { main: '' });
  if (modules.main === undefined) modules.main = '';
  const branchId = newId(state);

  state.world.users[id] = user;
  state.profiles[id] = profile;
  state.branches[branchId] = {
    _id: branchId,
    user: id,
    branch: 'default',
    modules,
    activeWorld: true,
    activeSim: true,
    timestamp: now,
  };
  context.runtime.setCode(id, modules, 'default');
  context.runtime.setMemory(id, '{}');
  return user;
}

/**
 * Sets (or replaces) the local password of an existing named user and revokes every session:
 * tokens are dropped and `auth:revoked` (`{user}`) is published, which the kernel delivers only
 * after the mutation commits so realtime sessions are closed. Call inside `context.mutate`.
 */
export function setUserPassword(context: ServerContext, userId: string, password: string): void {
  const user = context.state.world.users[userId];
  const profile = context.state.profiles[userId];
  if (!user || !profile) throw new ApiError('user not found');
  if (user.username === undefined) throw new ApiError('password sign-in requires a username');
  validatePassword(password);
  profile.passwordHash = hashPassword(password);
  for (const [hash, entry] of Object.entries(context.state.tokens)) {
    if (entry.userId === userId) Reflect.deleteProperty(context.state.tokens, hash);
  }
  context.publish('auth:revoked', { user: userId });
}
