import { newId, type ServerState } from '../contracts.ts';
import type { World } from './gameplay-support.ts';

type FlagDoc = World['flags'][string];

/** One flag as stored upstream: `[name, color, secondaryColor, x, y]`. */
export type FlagEntry = string[];

/** Upstream `getFlags` parser for a `rooms.flags` document's `data` string. */
function parseFlags(data: string): FlagEntry[] {
  if (!data.length) {
    return [];
  }
  return data.split('|').map((entry) => {
    const item = entry.split('~');
    item[0] = (item[0] ?? '').replace(/\$VLINE\$/g, '|').replace(/\$TILDE\$/g, '~');
    return item;
  });
}

/** All flags of a user grouped by room (upstream `getFlags(user)`). */
export function userFlags(world: World, userId: string): Map<string, FlagEntry[]> {
  const rooms = new Map<string, FlagEntry[]>();
  for (const doc of Object.values(world.flags)) {
    if (doc.user === userId) {
      rooms.set(doc.room, [...(rooms.get(doc.room) ?? []), ...parseFlags(doc.data)]);
    }
  }
  return rooms;
}

/**
 * Upstream `setFlags`: one document per user and room, serialized with the separator escapes the
 * engine and runtime parse. A room without flags drops its document, because the processor parses
 * an empty `data` string as one nameless flag.
 */
export function saveRoomFlags(
  state: ServerState,
  userId: string,
  room: string,
  flags: readonly FlagEntry[],
): void {
  const docs: FlagDoc[] = Object.values(state.world.flags).filter(
    (doc) => doc.user === userId && doc.room === room,
  );
  for (const duplicate of docs.slice(1)) {
    Reflect.deleteProperty(state.world.flags, duplicate._id);
  }
  const doc = docs[0];
  if (!flags.length) {
    if (doc) {
      Reflect.deleteProperty(state.world.flags, doc._id);
    }
    return;
  }
  const data = flags
    .map(([name = '', ...rest]) =>
      [name.replace(/\|/g, '$VLINE$').replace(/~/g, '$TILDE$'), ...rest].join('~'),
    )
    .join('|');
  if (doc) {
    doc.data = data;
    return;
  }
  const _id = newId(state);
  state.world.flags[_id] = { _id, user: userId, room, data };
}
