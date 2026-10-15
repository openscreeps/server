import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import { request as httpRequest, Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach } from 'node:test';
import { AuthController, RegistrationController, UserController } from '../src/api/accounts.ts';
import { GameController } from '../src/api/game.ts';
import { LeaderboardController } from '../src/api/leaderboard.ts';
import { MarketController } from '../src/api/market.ts';
import { MessagesController } from '../src/api/messages.ts';
import { PowerController } from '../src/api/power.ts';
import {
  DecorationsController,
  SteamController,
  UserDecorationsController,
  XsollaController,
} from '../src/api/platform.ts';
import { ApiExceptionFilter, SERVER_CONTEXT } from '../src/api/transport.ts';
import { AccountsService } from '../src/services/accounts.ts';
import { GameService } from '../src/services/game.ts';
import { LeaderboardService } from '../src/services/leaderboard.ts';
import { MarketService } from '../src/services/market.ts';
import { MessagesService } from '../src/services/messages.ts';
import { PowerService } from '../src/services/power.ts';
import { SteamAuthService } from '../src/services/native-steam.ts';
import { SteamNewsService } from '../src/services/steam-news.ts';
import { ApiError, RawResponse, type ApiContext } from '../src/contracts.ts';

export interface ApiCallOptions {
  body?: Record<string, unknown>;
  query?: Record<string, string>;
  token?: string;
  serverPassword?: string;
}

@Module({})
class ApiTestModule {}

interface RunningApi {
  app: INestApplication;
  port: number;
}

async function startApi(context: ApiContext): Promise<RunningApi> {
  const app = await NestFactory.create<NestExpressApplication>(
    {
      module: ApiTestModule,
      controllers: [
        AuthController,
        RegistrationController,
        UserController,
        MessagesController,
        GameController,
        MarketController,
        PowerController,
        LeaderboardController,
        SteamController,
        XsollaController,
        DecorationsController,
        UserDecorationsController,
      ],
      providers: [
        { provide: SERVER_CONTEXT, useValue: context },
        AccountsService,
        MessagesService,
        GameService,
        MarketService,
        PowerService,
        LeaderboardService,
        SteamNewsService,
        SteamAuthService,
      ],
    },
    { bodyParser: false, logger: false, abortOnError: false },
  );
  app.use(json({ limit: '8mb' }));
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  const server: unknown = app.getHttpServer();
  if (!(server instanceof HttpServer)) throw new Error('expected a Node HTTP server');
  return { app, port: (server.address() as AddressInfo).port };
}

interface HttpReply {
  status: number;
  contentType: string;
  body: Buffer;
}

function send(
  port: number,
  method: string,
  path: string,
  options: ApiCallOptions,
): Promise<HttpReply> {
  const query = new URLSearchParams(options.query ?? {}).toString();
  const payload = method === 'POST' ? JSON.stringify(options.body ?? {}) : undefined;
  const headers: Record<string, string> = {};
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token !== undefined) headers['X-Token'] = options.token;
  if (options.serverPassword !== undefined) headers['X-Server-Password'] = options.serverPassword;
  const { promise, resolve, reject } = Promise.withResolvers<HttpReply>();
  const outgoing = httpRequest(
    { host: '127.0.0.1', port, method, path: query ? `${path}?${query}` : path, headers },
    (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => {
        resolve({
          status: incoming.statusCode ?? 0,
          contentType: incoming.headers['content-type'] ?? '',
          body: Buffer.concat(chunks),
        });
      });
    },
  );
  outgoing.on('error', reject);
  outgoing.end(payload);
  return promise;
}

/**
 * Real Nest HTTP application over a supplied context: guards, interceptor and exception filter
 * all run. Started lazily on the first call; every client is closed after each test.
 */
export class ApiTestClient {
  #running: Promise<RunningApi> | undefined;

  constructor(readonly context: ApiContext) {
    clients.add(this);
  }

  /** Resolves the `ok` envelope's payload, a RawResponse for non-JSON, or throws the ApiError. */
  async call(method: 'GET' | 'POST', path: string, options: ApiCallOptions = {}): Promise<unknown> {
    this.#running ??= startApi(this.context);
    const { port } = await this.#running;
    const reply = await send(port, method, path, options);
    if (!reply.contentType.startsWith('application/json')) {
      return new RawResponse(reply.body.toString(), reply.contentType, reply.status);
    }
    const parsed: unknown = JSON.parse(reply.body.toString());
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`unexpected API reply: ${reply.body.toString()}`);
    }
    if ('error' in parsed && typeof parsed.error === 'string') {
      throw new ApiError(parsed.error, reply.status);
    }
    if (!('ok' in parsed) || parsed.ok !== 1) {
      throw new Error(`unexpected API reply: ${reply.body.toString()}`);
    }
    const result: Record<string, unknown> = { ...parsed };
    delete result['ok'];
    return result;
  }

  async close(): Promise<void> {
    const running = this.#running;
    this.#running = undefined;
    clients.delete(this);
    if (running) await (await running).app.close();
  }
}

const clients = new Set<ApiTestClient>();
afterEach(async () => {
  await Promise.all([...clients].map((client) => client.close()));
});
