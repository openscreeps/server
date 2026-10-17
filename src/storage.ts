import { createGameState, isRecord, parseGameState, type Constants } from '@openscreeps/game';
import type { ServerConfig, ServerState } from './contracts.ts';
import { assertOriginalStorageData } from './compatibility/original-storage.ts';

/** The world a kernel creates for an empty database. */
export function initialServerState(config: ServerConfig, constants?: Constants): ServerState {
  return {
    ...createGameState({
      size: config.worldSize,
      seed: config.seed,
      shardName: config.shardName,
      ...(constants === undefined ? {} : { constants }),
    }),
    profiles: {},
    tokens: {},
    messages: {},
    notificationOutbox: [],
    paused: config.paused,
    tickDuration: config.tickDuration,
  };
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function entriesMatch(value: unknown, check: (entry: unknown) => boolean): boolean {
  return isRecord(value) && Object.values(value).every(check);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string');
}

/** `message\n[type] (count)`, the formatted text of one notification in a batch. */
const FORMATTED_NOTIFICATION = /^([\s\S]*)\n\[([^\]\n]*)\] \((\d+)\)$/;

/**
 * Batches persisted before they carried their source notifications kept only the formatted text.
 * Recover `message`, `type` and `count` from it (unrecognized text becomes a `msg` with count 1);
 * the original dates were not stored, so the batch date stands in for them.
 */
function upgradeNotificationBatch(entry: Record<string, unknown>): void {
  if (entry.notifications !== undefined || !strings(entry.messages) || !finite(entry.date)) return;
  const date = entry.date;
  entry.notifications = entry.messages.map((text) => {
    const match = FORMATTED_NOTIFICATION.exec(text);
    if (!match) return { message: text, date, count: 1, type: 'msg' };
    const [, message = '', type = '', count = '0'] = match;
    return { message, date, count: Number(count), type };
  });
}

/** Validate server-private records before replacing the last durable world. */
function validateServerRecords(value: Record<string, unknown>): void {
  const checks: Record<string, (entry: unknown) => boolean> = {
    profiles: (entry) =>
      isRecord(entry) &&
      finite(entry.registeredDate) &&
      ['email', 'emailDirty', 'passwordHash'].every(
        (key) => entry[key] === undefined || typeof entry[key] === 'string',
      ) &&
      (entry.steam === undefined || (isRecord(entry.steam) && typeof entry.steam.id === 'string')),
    tokens: (entry) => isRecord(entry) && typeof entry.userId === 'string' && finite(entry.expires),
    messages: (entry) =>
      isRecord(entry) &&
      ['_id', 'user', 'respondent', 'text'].every((key) => typeof entry[key] === 'string') &&
      finite(entry.date) &&
      (entry.type === 'in' || entry.type === 'out') &&
      typeof entry.unread === 'boolean',
  };
  for (const [name, check] of Object.entries(checks)) {
    if (!entriesMatch(value[name], check)) throw new Error(`Invalid server collection: ${name}`);
  }
  if (
    !Array.isArray(value.notificationOutbox) ||
    !value.notificationOutbox.every((entry: unknown) => {
      if (!isRecord(entry)) return false;
      upgradeNotificationBatch(entry);
      return (
        typeof entry.id === 'string' &&
        typeof entry.userId === 'string' &&
        (entry.email === undefined || typeof entry.email === 'string') &&
        strings(entry.messages) &&
        Array.isArray(entry.notifications) &&
        entry.notifications.every(
          (detail: unknown) =>
            isRecord(detail) &&
            typeof detail.message === 'string' &&
            finite(detail.date) &&
            finite(detail.count) &&
            typeof detail.type === 'string',
        ) &&
        entry.notifications.length === entry.messages.length &&
        finite(entry.date)
      );
    })
  ) {
    throw new Error('Invalid notification outbox');
  }
  if (
    typeof value.paused !== 'boolean' ||
    typeof value.tickDuration !== 'number' ||
    !Number.isFinite(value.tickDuration) ||
    value.tickDuration < 1
  ) {
    throw new Error('Invalid scheduler snapshot');
  }
}

/**
 * Only our versioned, durably-written snapshots enter this boundary. Fail closed on corruption:
 * the game state is validated by the game, the account, session and scheduler records here.
 */
export function decodeState(serialized: string): ServerState {
  const value: unknown = JSON.parse(serialized);
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isRecord(value.world) ||
    !isRecord(value.runtime)
  ) {
    throw new Error('Unsupported or invalid server snapshot');
  }
  const state = parseGameState(value);
  validateServerRecords(value);
  if (value.originalStorage !== undefined) assertOriginalStorageData(value.originalStorage);
  return state as unknown as ServerState;
}

export type RoomHistory = ServerState['history'];

/**
 * JSON of the world without its room history: the durable snapshot row. History frames are
 * persisted one row each and never mutated once recorded, so they are compared by identity.
 */
export function snapshotJson(state: ServerState): string {
  return JSON.stringify({ ...state, history: {} });
}

/** Per room, a new array of the same frames: later appends and expiries leave the copy as it was. */
export function copyHistory(history: RoomHistory): RoomHistory {
  const copy: RoomHistory = {};
  for (const [room, frames] of Object.entries(history)) copy[room] = [...frames];
  return copy;
}

/** Whether both histories hold the same rooms with the same frame objects in the same order. */
export function sameHistory(a: RoomHistory, b: RoomHistory): boolean {
  const rooms = Object.keys(a);
  if (rooms.length !== Object.keys(b).length) return false;
  return rooms.every((room) => {
    const left = a[room];
    const right = Object.hasOwn(b, room) ? b[room] : undefined;
    return (
      left !== undefined &&
      right !== undefined &&
      left.length === right.length &&
      left.every((frame, index) => frame === right[index])
    );
  });
}
