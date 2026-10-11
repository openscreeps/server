/*
 * Account registry: account creation (backend `steamFindOrCreateUser` / CLI bot spawn documents)
 * around the game's player registry, identity validation and local password credentials.
 */

import {
  checkNewUsername,
  createPlayer,
  type CreatePlayerOptions,
  type User,
} from '@openscreeps/game';
import { ApiError, type ServerContext, type ServerState, type UserProfile } from '../contracts.ts';
import { hashPassword } from './auth.ts';

/** Backend email rule (`register/set-username`, `user/email`). */
export const EMAIL_PATTERN = /^[\w.+&-]+@[\w.&-]+\.[\w.&-]{2,}$/;
const STEAM_ID_PATTERN = /^\d{1,20}$/;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 1024;

export interface CreateUserOptions extends CreatePlayerOptions {
  password?: string;
  steamId?: string;
  email?: string;
}
function dropWhere<T>(collection: Record<string, T>, predicate: (value: T) => boolean): void {
  for (const [key, value] of Object.entries(collection)) {
    if (predicate(value)) Reflect.deleteProperty(collection, key);
  }
}

/** Deletes the server-private account records of a removed player (`removePlayer`). Lock-held. */
export function purgeAccountRecords(state: ServerState, userId: string): void {
  Reflect.deleteProperty(state.profiles, userId);
  dropWhere(state.tokens, (token) => token.userId === userId);
  dropWhere(state.messages, (message) => message.user === userId);
  state.notificationOutbox = state.notificationOutbox.filter(
    (notification) => notification.userId !== userId,
  );
}

export function findUserIdByEmail(state: ServerState, email: string): string | undefined {
  const lower = email.toLowerCase();
  return Object.keys(state.profiles).find((id) => state.profiles[id]?.email === lower);
}

export function findUserIdBySteamId(state: ServerState, steamId: string): string | undefined {
  return Object.keys(state.profiles).find((id) => state.profiles[id]?.steam?.id === steamId);
}

function validatePassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new ApiError(
      `password must be ${String(PASSWORD_MIN_LENGTH)}-${String(PASSWORD_MAX_LENGTH)} characters long`,
    );
  }
}

/**
 * Creates an account: the game player (`users` document, `default` code branch, runtime code and
 * empty `Memory`) plus its private profile. Synchronous; call while holding the context lock.
 */
export function createUser(context: ServerContext, options: CreateUserOptions): User {
  const { state } = context;
  const { password, steamId, email: requestedEmail, ...player } = options;
  const { username } = player;
  if (username === undefined && steamId === undefined) {
    throw new ApiError('username or steam id required');
  }
  if (username !== undefined) checkNewUsername(state, username);
  let email: string | undefined;
  if (requestedEmail !== undefined) {
    if (!EMAIL_PATTERN.test(requestedEmail)) throw new ApiError('invalid email');
    email = requestedEmail.toLowerCase();
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

  const user = createPlayer(context, player);
  const profile: UserProfile = { registeredDate: context.now() };
  if (email !== undefined) profile.email = email;
  if (password !== undefined) profile.passwordHash = hashPassword(password);
  if (steamId !== undefined) profile.steam = { id: steamId };
  state.profiles[user._id] = profile;
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
