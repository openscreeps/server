import { All, Controller, Get, Inject, Injectable, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ApiError,
  RawResponse,
  type ApiContext,
  type ApiRequest,
  type ApiRoute,
} from './contracts.ts';
import { accountRoutes } from './api/accounts.ts';
import { gameRoutes } from './api/game.ts';
import { marketRoutes } from './api/market.ts';
import { powerRoutes } from './api/power.ts';
import { leaderboardRoutes } from './api/leaderboard.ts';
import { historyTicks } from './realtime/diff.ts';

export const SERVER_CONTEXT = Symbol('ServerContext');

export function secretsEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(actual).digest(),
    createHash('sha256').update(expected).digest(),
  );
}

function objectBody(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new ApiError('invalid params', 400);
  return value as Record<string, unknown>;
}

export function requestToken(request: Request): string {
  const token = request.get('X-Token');
  if (token) return token;
  const authorization = request.get('Authorization');
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7);
  return new URL(request.originalUrl, 'http://server').searchParams.get('token') ?? '';
}

export function checkServerPassword(request: Request, context: ApiContext): void {
  const password = context.config.serverPassword;
  if (password && !secretsEqual(request.get('X-Server-Password') ?? '', password)) {
    throw new ApiError('incorrect server password');
  }
}

export function sendError(error: unknown, response: Response): void {
  if (error instanceof ApiError) {
    response.status(error.status).json({ error: error.message });
  } else {
    console.error(error);
    response.status(500).json({ error: 'internal server error' });
  }
}

export const informationRoutes: readonly ApiRoute[] = [
  {
    method: 'GET',
    path: '/api/version',
    handle: (_request, context) => ({
      protocol: 14,
      useNativeAuth: false,
      users: Object.values(context.state.world.users).filter(
        (user) => user.active !== 0 && (user.cpu ?? 0) > 0 && !user.bot,
      ).length,
      packageVersion: '0.0.0',
      serverData: {
        welcomeText: context.config.welcomeText,
        customObjectTypes: {},
        historyChunkSize: context.config.historyChunkSize,
        socketUpdateThrottle: context.config.socketUpdateThrottle,
        renderer: { resources: {}, metadata: {} },
      },
    }),
  },
];

@Injectable()
export class ApiDispatcher {
  readonly #routes = new Map<string, ApiRoute>();

  constructor(@Inject(SERVER_CONTEXT) readonly context: ApiContext) {
    for (const route of [
      ...informationRoutes,
      ...accountRoutes,
      ...gameRoutes,
      ...marketRoutes,
      ...powerRoutes,
      ...leaderboardRoutes,
    ]) {
      const key = `${route.method} ${route.path}`;
      if (this.#routes.has(key)) throw new Error(`Duplicate API route: ${key}`);
      this.#routes.set(key, route);
    }
  }

  async dispatch(request: Request, response: Response): Promise<void> {
    try {
      checkServerPassword(request, this.context);
      const url = new URL(request.originalUrl, 'http://server');
      const route = this.#routes.get(`${request.method} ${url.pathname.replace(/\/$/, '')}`);
      if (!route) throw new ApiError('not found', 404);
      const body: unknown = request.body;
      const input: ApiRequest = {
        query: url.searchParams,
        body: objectBody(body),
        headers: request.headers,
      };
      if (route.prepare) {
        if (route.auth) {
          const userId = await this.context.read(() =>
            this.context.auth.check(requestToken(request)),
          );
          if (!userId) throw new ApiError('unauthorized', 401);
          input.userId = userId;
        }
        input.prepared = await route.prepare(input, this.context);
      }
      let refreshedToken: string | undefined;
      const operation = () => {
        if (route.auth) {
          const userId = this.context.auth.check(requestToken(request));
          if (!userId) throw new ApiError('unauthorized', 401);
          input.userId = userId;
          refreshedToken = this.context.auth.issue(userId);
          const profile = this.context.state.profiles[userId];
          if (profile) profile.lastOnline = this.context.now();
        }
        return route.handle(input, this.context);
      };
      const result: unknown =
        route.write || route.auth
          ? await this.context.mutate(operation)
          : await this.context.read(operation);
      if (refreshedToken) response.set('X-Token', refreshedToken);
      if (result instanceof RawResponse) {
        response.status(result.status).type(result.contentType).send(result.body);
      } else if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
        response.json({ ok: 1, ...result });
      } else {
        response.json({ ok: 1 });
      }
    } catch (error) {
      sendError(error, response);
    }
  }
}

@Controller('api')
export class ApiController {
  constructor(@Inject(ApiDispatcher) readonly dispatcher: ApiDispatcher) {}

  @All('{*path}')
  async handle(@Req() request: Request, @Res() response: Response): Promise<void> {
    await this.dispatcher.dispatch(request, response);
  }
}

@Controller()
export class RootController {
  constructor(@Inject(SERVER_CONTEXT) readonly context: ApiContext) {}

  @Get()
  root(@Res() response: Response): void {
    response
      .type('html')
      .send(
        '<!doctype html><title>OpenScreeps</title><h1>OpenScreeps server</h1><p>Connect using the Screeps game client.</p>',
      );
  }

  @Get('room-history')
  async history(
    @Req() request: Request,
    @Res() response: Response,
    @Query('room') room: unknown,
    @Query('time') time: unknown,
  ): Promise<void> {
    try {
      checkServerPassword(request, this.context);
      const base = typeof time === 'string' ? Number(time) : NaN;
      if (typeof room !== 'string' || !Number.isSafeInteger(base) || base < 0) {
        throw new ApiError('invalid params', 400);
      }
      const chunk = await this.context.read(() => {
        const frames = this.context.state.history[room] ?? [];
        const index = frames.findIndex((frame) => frame.time === base);
        if (index < 0) throw new ApiError('history not found', 404);
        const selected = [];
        for (let offset = 0; offset < this.context.config.historyChunkSize; offset++) {
          const frame = frames[index + offset];
          if (!frame || frame.time !== base + offset) break;
          selected.push(frame);
        }
        return { timestamp: this.context.now(), room, base, ticks: historyTicks(selected) };
      });
      response.json(chunk);
    } catch (error) {
      sendError(error, response);
    }
  }
}
