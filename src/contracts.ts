import type {
  BotRuntime,
  CodeModules,
  ManualIntents,
  RuntimeSnapshot,
  StoredUserIntents,
  TickResult,
  TickRunResult,
  WorldState,
} from '@openscreeps/engine';
import type { EventEmitter } from 'node:events';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type User = WorldState['users'][string];
export type RoomObject = WorldState['roomObjects'][string];
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
export interface CodeBranch {
  _id: string;
  user: string;
  branch: string;
  modules: CodeModules;
  activeWorld: boolean;
  activeSim: boolean;
  timestamp: number;
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
export interface HistoryFrame {
  time: number;
  objects: Record<string, unknown>;
}
export interface StatisticsSample {
  /** Minute bucket start in wall-clock milliseconds; room increments accumulate in this bucket. */
  time: number;
  tick: number;
  ticks: number;
  rooms: TickResult['roomStats'];
  users: Record<
    string,
    { cpu: number; memory: number; bucket: number; gcl: number; power: number }
  >;
}
export interface ServerState {
  version: 1;
  world: WorldState;
  runtime: RuntimeSnapshot;
  profiles: Record<string, UserProfile>;
  branches: Record<string, CodeBranch>;
  /** SHA-256 token hashes, never plaintext bearer credentials. */
  tokens: Record<string, { userId: string; expires: number }>;
  messages: Record<string, UserMessage>;
  history: Record<string, HistoryFrame[]>;
  statistics: StatisticsSample[];
  leaderboard: Record<string, Record<string, { world: number; power: number }>>;
  /** Persisted backend timers and per-room scheduler metadata. */
  jobs: Record<string, number>;
  /** Notifications ready for delivery to an operator-configured sink. */
  notificationOutbox: Array<{
    id: string;
    userId: string;
    email?: string;
    messages: string[];
    date: number;
  }>;
  pendingIntents: ManualIntents;
  pendingGlobalIntents: Record<string, NonNullable<StoredUserIntents['global']>>;
  paused: boolean;
  tickDuration: number;
}
export interface ServerConfig {
  host: string;
  port: number;
  database: string;
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
  deliverNotifications?: (notification: ServerState['notificationOutbox'][number]) => Promise<void>;
}
export interface TickEvent {
  simulation: TickResult;
  runtime: TickRunResult;
  timestamp: number;
}
export interface ServerEvents {
  tick: [event: TickEvent];
  message: [channel: string, data: unknown];
  terrain: [];
  reset: [];
  error: [error: Error];
}
export interface ServerContext {
  readonly config: ServerConfig;
  readonly state: ServerState;
  readonly runtime: BotRuntime;
  readonly events: EventEmitter<ServerEvents>;
  now(): number;
  /** Serialize reads with ticks. Call only from outside a read/mutate callback. */
  read<T>(operation: () => T | Promise<T>): Promise<T>;
  /** Serialize, durably commit, then publish events. Never nest calls. */
  mutate<T>(operation: () => T | Promise<T>): Promise<T>;
  publish(channel: string, data: unknown): void;
  /** Call after changing room terrain; refreshes engine pathfinding before next tick. */
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
  /** Verified external input prepared by the route, never read from request JSON. */
  prepared?: unknown;
}
export interface ApiRoute {
  method: 'GET' | 'POST';
  path: string;
  auth?: boolean;
  write?: boolean;
  /** External authentication/network work, before acquiring the world lock. */
  prepare?(request: ApiRequest, context: ServerContext): Promise<unknown>;
  /** Normal handlers already run under the context lock; do not call read/mutate inside them. */
  handle(request: ApiRequest, context: ApiContext): unknown;
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
export function newId(state: ServerState): string {
  return (++state.world.idCounter).toString(16).padStart(24, '0');
}
