import { isRecord, parseGameState } from '@openscreeps/game';
import type { ServerState } from './contracts.ts';

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function entriesMatch(value: unknown, check: (entry: unknown) => boolean): boolean {
  return isRecord(value) && Object.values(value).every(check);
}

function strings(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string');
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
    !value.notificationOutbox.every(
      (entry: unknown) =>
        isRecord(entry) &&
        typeof entry.id === 'string' &&
        typeof entry.userId === 'string' &&
        (entry.email === undefined || typeof entry.email === 'string') &&
        strings(entry.messages) &&
        finite(entry.date),
    )
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
  return state as unknown as ServerState;
}
