/*
 * Socket channel names (backend `socket/*.js`) and who may subscribe to them.
 *
 * Upstream only rejected `user:` channels when the connection was authenticated and the channel
 * did not start with `user:<own id>` (so `user:1` could read `user:12/...`), and the user module's
 * async `onSubscribe` made every other subscription succeed regardless of authentication. Here a
 * channel is accepted only when it parses completely and names exactly the authenticated user.
 */

export type ChannelSpec =
  | { kind: 'server-message' }
  | { kind: 'room'; room: string }
  | { kind: 'roomMap'; room: string }
  | { kind: 'mapVisual'; userId: string }
  | { kind: 'memory'; userId: string; path: string }
  | { kind: 'cpu'; userId: string }
  | { kind: 'resources'; userId: string }
  /** Published per-user events: console, code, set-active-branch, newMessage, message:<id>, ... */
  | { kind: 'user'; userId: string };

/** Room names accepted by `room:` and `roomMap2:` (upstream `[a-zA-Z0-9_-]+`). */
const ROOM_NAME = /^[a-zA-Z0-9_-]+$/;
/** `.` in the upstream `^subscribe (.*)$` pattern does not match line terminators. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

export function parseChannel(channel: string): ChannelSpec | undefined {
  if (LINE_TERMINATOR.test(channel)) return undefined;
  if (channel === 'server-message') return { kind: 'server-message' };
  if (channel.startsWith('room:')) {
    const room = channel.slice('room:'.length);
    return ROOM_NAME.test(room) ? { kind: 'room', room } : undefined;
  }
  if (channel.startsWith('roomMap2:')) {
    const room = channel.slice('roomMap2:'.length);
    return ROOM_NAME.test(room) ? { kind: 'roomMap', room } : undefined;
  }
  if (channel.startsWith('mapVisual:')) {
    const userId = channel.slice('mapVisual:'.length);
    return userId ? { kind: 'mapVisual', userId } : undefined;
  }
  if (!channel.startsWith('user:')) return undefined;
  const rest = channel.slice('user:'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  const userId = rest.slice(0, slash);
  const topic = rest.slice(slash + 1);
  if (topic.startsWith('memory/')) {
    const path = topic.slice('memory/'.length);
    return path ? { kind: 'memory', userId, path } : undefined;
  }
  if (topic === 'cpu') return { kind: 'cpu', userId };
  if (topic === 'resources') return { kind: 'resources', userId };
  return { kind: 'user', userId };
}

/** Whether a connection authenticated as `userId` (or anonymous) may subscribe. */
export function canSubscribe(spec: ChannelSpec, userId: string | undefined): boolean {
  switch (spec.kind) {
    case 'server-message':
      return true;
    case 'room':
    case 'roomMap':
      return userId !== undefined;
    default:
      return userId !== undefined && spec.userId === userId;
  }
}
