import type {
  GameContext,
  GameState,
  GameTick,
  JsonObject,
  NotificationBatch,
  User,
} from '@openscreeps/game';
import type { EventEmitter } from 'node:events';

export interface UserProfile {
  email?: string;
  emailDirty?: string;
  passwordHash?: string;
  registeredDate: number;
  steam?: {
    id: string;
    displayName?: string;
    ownership?: boolean;
    steamProfileLinkHidden?: boolean;
  };
  notifyPrefs?: JsonObject;
  customBadge?: { path1: string; path2: string };
  lastChargeTime?: number;
  lastOnline?: number;
}
export interface UserMessage {
  _id: string;
  user: string;
  respondent: string;
  date: number;
  type: 'in' | 'out';
  text: string;
  unread: boolean;
  outMessage?: string;
}
/**
 * The persisted world: the credential-free game state plus server-private account, session and
 * scheduling records (one flat document, so existing snapshots keep their shape).
 */
export interface ServerState extends GameState {
  profiles: Record<string, UserProfile>;
  /** SHA-256 token hashes, never plaintext bearer credentials. */
  tokens: Record<string, { userId: string; expires: number }>;
  messages: Record<string, UserMessage>;
  /** Notification batches from maintenance, ready for delivery to an operator-configured sink. */
  notificationOutbox: NotificationBatch[];
  paused: boolean;
  tickDuration: number;
}
export interface ServerConfig {
  host: string;
  port: number;
  /** SQLite world file; also locates the local admin token file when the world is in PostgreSQL. */
  database: string;
  /** PostgreSQL connection URL (postgres:// or postgresql://); when set it holds the world. */
  databaseUrl?: string;
  tickDuration: number;
  paused: boolean;
  worldSize: number;
  seed: number;
  shardName: string;
  serverPassword?: string;
  adminToken?: string;
  steamKey?: string;
  assetDirectory?: string;
  welcomeText: string;
  historyChunkSize: number;
  historyTicks: number;
  socketUpdateThrottle: number;
  tokenLifetimeMs: number;
  /** Optional delivery callback; absent means retained operator-visible outbox, never lost mail. */
  deliverNotifications?: (notification: NotificationBatch) => Promise<void>;
}
export type TickEvent = GameTick;
export interface ServerEvents {
  tick: [event: TickEvent];
  message: [channel: string, data: unknown];
  terrain: [];
  reset: [];
  error: [error: Error];
}
export interface ServerContext extends GameContext<ServerState> {
  readonly config: ServerConfig;
  readonly events: EventEmitter<ServerEvents>;
  /** Serialize reads with ticks. Call only from outside a read/mutate callback. */
  read<T>(operation: () => T | Promise<T>): Promise<T>;
  /** Serialize, durably commit, then publish events. Never nest calls. */
  mutate<T>(operation: () => T | Promise<T>): Promise<T>;
  publish(channel: string, data: unknown): void;
  /** Call after changing room terrain inside a mutation; refreshes pathfinding before next tick. */
  terrainChanged(): void;
  step(): Promise<TickEvent>;
  setPaused(paused: boolean): Promise<void>;
  setTickDuration(milliseconds: number): Promise<void>;
}
export interface AuthService {
  /** Called within a context read/mutate callback. */
  check(token: string): string | undefined;
  /** Called within a context mutate callback. */
  issue(userId: string): string;
}
export interface ApiContext extends ServerContext {
  readonly auth: AuthService;
}
export interface ApiRequest {
  query: URLSearchParams;
  body: Record<string, unknown>;
  userId?: string;
  headers: Record<string, string | string[] | undefined>;
}
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 200,
  ) {
    super(message);
  }
}
export class RawResponse {
  constructor(
    readonly body: string | Buffer,
    readonly contentType: string,
    readonly status = 200,
  ) {}
}
export function requireUser(request: ApiRequest, context: ServerContext): User {
  const user = request.userId === undefined ? undefined : context.state.world.users[request.userId];
  if (!user) throw new ApiError('unauthorized', 401);
  return user;
}
