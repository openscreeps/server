import { storeIntents } from '@openscreeps/engine';
import { ApiError, type ServerState } from '../contracts.ts';
import { isRecord } from './guards.ts';

/** Room-level intents the room processor handles (`processRoomIntents`). */
const ROOM_INTENTS: Readonly<Record<string, true>> = {
  removeFlag: true,
  createFlag: true,
  createConstructionSite: true,
  removeConstructionSite: true,
  destroyStructure: true,
};

/**
 * Global intents accepted from the API: power creep account actions and the market, which the global
 * processor fully validates. Account intents (`generatePixel`, `unlockCpu`, `activateAccess`) are
 * excluded because only the runtime charges their cost (CPU bucket) before recording them.
 */
const GLOBAL_INTENTS: Readonly<Record<string, true>> = {
  spawnPowerCreep: true,
  suicidePowerCreep: true,
  deletePowerCreep: true,
  upgradePowerCreep: true,
  createPowerCreep: true,
  renamePowerCreep: true,
  createOrder: true,
  changeOrderPrice: true,
  extendOrder: true,
  cancelOrder: true,
  deal: true,
};

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

/**
 * Sanitizes `{[name]: intent}` for one room object exactly like upstream
 * `sanitizeUserIntents({[name]: intent})`, using the engine's stored-intent schema.
 */
export function sanitizeObjectIntent(
  room: string,
  objectId: string,
  name: string,
  intent: unknown,
): Record<string, unknown> {
  const stored = storeIntents({ [objectId]: { [name]: intent } }, () => room);
  const sanitized: Readonly<Record<string, unknown>> = stored.rooms[room]?.[objectId] ?? {};
  if (!Object.hasOwn(sanitized, name)) {
    throw new ApiError('invalid params');
  }
  return { [name]: sanitized[name] };
}

/**
 * Sanitizes a list of room-level intents element by element (keeping their order). Every element
 * must name `room` as its `roomName` before it reaches the engine sanitizer: the processors create
 * flags and construction sites in `intent.roomName`, so a foreign room name would escape the room
 * whose ownership was validated, and the sanitizer groups by that name with plain property writes.
 */
export function sanitizeRoomIntents(room: string, name: string, intents: unknown): unknown[] {
  if (!Object.hasOwn(ROOM_INTENTS, name) || !Array.isArray(intents) || !intents.length) {
    throw new ApiError('invalid params');
  }
  return (intents as readonly unknown[]).map((intent) => {
    if (!isRecord(intent) || intent['roomName'] !== room) {
      throw new ApiError('invalid params');
    }
    const stored = storeIntents({ room: { [name]: [intent] } }, () => undefined);
    const bucket: Readonly<Record<string, unknown>> | undefined = stored.rooms[room]?.['room'];
    const [sanitized] = listOf(bucket?.[name]);
    if (sanitized === undefined) {
      throw new ApiError('invalid params');
    }
    return sanitized;
  });
}

/** Upstream `sanitizeUserIntents({[name]: [intent]})` for a global intent. */
export function sanitizeGlobalIntent(name: string, intent: unknown): unknown[] {
  if (!Object.hasOwn(GLOBAL_INTENTS, name)) {
    throw new ApiError('invalid params');
  }
  const stored = storeIntents({ global: { [name]: [intent] } }, () => undefined);
  const global: Readonly<Record<string, unknown>> = stored.global ?? {};
  const sanitized = listOf(global[name]);
  if (sanitized.length !== 1) {
    throw new ApiError('invalid params');
  }
  return [...sanitized];
}

/**
 * Queues manual object intents for the next tick (upstream `rooms.intents` `objectsManual` merge):
 * one payload per intent name per object, the latest request winning, while room-level intent
 * lists accumulate so several clicks within one tick are all processed.
 */
export function queueManualIntents(
  state: ServerState,
  room: string,
  userId: string,
  targetId: string,
  intents: Readonly<Record<string, unknown>>,
): void {
  const rooms = { ...state.pendingIntents };
  const users = { ...rooms[room] };
  const targets = { ...users[userId] };
  const previous: Readonly<Record<string, unknown>> = targets[targetId] ?? {};
  const merged: Record<string, unknown> = { ...previous };
  for (const [name, payload] of Object.entries(intents)) {
    merged[name] = targetId === 'room' ? [...listOf(previous[name]), ...listOf(payload)] : payload;
  }
  targets[targetId] = merged;
  users[userId] = targets;
  rooms[room] = users;
  state.pendingIntents = rooms;
}

/** Queues global intents (upstream inserts one `users.intents` document per request). */
export function queueGlobalIntents(
  state: ServerState,
  userId: string,
  name: string,
  intents: readonly unknown[],
): void {
  const previous: Readonly<Record<string, unknown>> = state.pendingGlobalIntents[userId] ?? {};
  const merged: Record<string, unknown> = {
    ...previous,
    [name]: [...listOf(previous[name]), ...intents],
  };
  state.pendingGlobalIntents = {
    ...state.pendingGlobalIntents,
    [userId]: merged,
  };
}
