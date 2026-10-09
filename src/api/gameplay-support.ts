import type { WorldState } from '@openscreeps/game';
import { ownValue } from '@openscreeps/game';

/** Public projection of a user (upstream `{_id, username, badge}` field selection). */
export interface PublicUser {
  _id: string;
  username?: string;
  badge?: unknown;
}

/** JS `parseInt(value)` restricted to the number and string inputs a JSON body can carry. */
export function parseInteger(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : Number.NaN;
  }
  if (typeof value === 'string') {
    return Number.parseInt(value, 10);
  }
  return Number.NaN;
}

/** A JSON string parameter; any other value reaches the game as missing. */
export function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A strict JSON number parameter (upstream `_.isNumber`); any other value is missing. */
export function numberParam(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function publicUser(world: WorldState, userId: string): PublicUser | undefined {
  const user = ownValue(world.users, userId);
  if (!user) {
    return undefined;
  }
  const result: PublicUser = { _id: user._id };
  if (user.username !== undefined) {
    result.username = user.username;
  }
  if (user.badge !== undefined) {
    result.badge = user.badge;
  }
  return result;
}

/** Upstream `_.indexBy(db.users.find({_id: {$in: ids}}, {_id, username, badge}), '_id')`. */
export function publicUsers(
  world: WorldState,
  userIds: Iterable<string>,
): Record<string, PublicUser> {
  const result: Record<string, PublicUser> = {};
  for (const id of userIds) {
    const user = publicUser(world, id);
    if (user) {
      result[user._id] = user;
    }
  }
  return result;
}
