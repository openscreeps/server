import { constants as C, type WorldState } from '@openscreeps/engine';
import { ApiError } from '../contracts.ts';

export type World = WorldState;
export type RoomObject = WorldState['roomObjects'][string];
export type RoomInfo = WorldState['rooms'][string];

/** Public projection of a user (upstream `{_id, username, badge}` field selection). */
export interface PublicUser {
  _id: string;
  username?: string;
  badge?: unknown;
}

export const CONSTRUCTION_COST: Readonly<Record<string, number>> = C.CONSTRUCTION_COST;
export const CONTROLLER_STRUCTURES: Readonly<Record<string, Readonly<Record<number, number>>>> =
  C.CONTROLLER_STRUCTURES;
const COLORS: readonly number[] = C.COLORS_ALL;

/** Own-property lookup that never resolves inherited members such as `__proto__` or `constructor`. */
export function ownValue<T>(record: Readonly<Record<string, T>>, key: unknown): T | undefined {
  return typeof key === 'string' && Object.hasOwn(record, key) ? record[key] : undefined;
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

/** Room tile coordinate (0..49) parsed like upstream `parseInt`, or `undefined` when out of range. */
export function parseCoordinate(value: unknown): number | undefined {
  const coordinate = parseInteger(value);
  return Number.isInteger(coordinate) && coordinate >= 0 && coordinate <= 49
    ? coordinate
    : undefined;
}

/** Strict JSON number coordinate (upstream `_.isNumber` + range), rejecting NaN and fractions. */
export function numberCoordinate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 49
    ? value
    : undefined;
}

export function isFlagColor(value: unknown): value is number {
  return typeof value === 'number' && COLORS.includes(value);
}

/**
 * Upstream `checkGame`: the room must exist on this shard, be a world room (`W..`/`E..`) and be
 * inside the borders and already open.
 */
export function checkGameRoom(world: World, room: unknown, now: number): string {
  const info = ownValue(world.rooms, room);
  if (typeof room !== 'string' || !info) {
    throw new ApiError('invalid room');
  }
  if (!/^(W|E)/.test(room)) {
    throw new ApiError('not supported');
  }
  if (info.status === 'out of borders' || (info.openTime && info.openTime > now)) {
    throw new ApiError('out of borders');
  }
  return room;
}

/** Upstream `utils.activateRoom`: schedule the room for processing on the next tick. */
export function activateRoom(world: World, room: string): void {
  if (!world.activeRooms.includes(room)) {
    world.activeRooms.push(room);
  }
}

export function roomObjects(world: World, room: string): RoomObject[] {
  return Object.values(world.roomObjects).filter((object) => object.room === room);
}

export function roomController(world: World, room: string): RoomObject | undefined {
  return Object.values(world.roomObjects).find(
    (object) => object.room === room && object.type === 'controller',
  );
}

export function publicUser(world: World, userId: string): PublicUser | undefined {
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
export function publicUsers(world: World, userIds: Iterable<string>): Record<string, PublicUser> {
  const result: Record<string, PublicUser> = {};
  for (const id of userIds) {
    const user = publicUser(world, id);
    if (user) {
      result[user._id] = user;
    }
  }
  return result;
}

/** Upstream `parseInt(terrain.charAt(y * 50 + x)) & mask` (tiles outside the room have no terrain). */
export function hasTerrain(terrain: string, x: number, y: number, mask: number): boolean {
  return (Number.parseInt(terrain.charAt(y * 50 + x), 10) & mask) !== 0;
}
