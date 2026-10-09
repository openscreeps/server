import 'reflect-metadata';
import { Inject, Module, type DynamicModule, type OnModuleDestroy } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded, type NextFunction, type Request, type Response } from 'express';
import { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ApiContext, ServerConfig, ServerState } from './contracts.ts';
import { createConfig } from './config.ts';
import { ServerKernel } from './services/server-kernel.service.ts';
import { StateStore } from './services/state-store.service.ts';
import { PersistenceModule } from './persistence.module.ts';
import { createAuthService } from './api/auth.ts';
import { HostController, InformationController, RootController } from './http.ts';
import { AdminController, AdminGuard } from './admin.ts';
import { AuthController, RegistrationController, UserController } from './api/accounts.ts';
import { MessagesController } from './api/messages.ts';
import { GameController } from './api/game.ts';
import { MarketController } from './api/market.ts';
import { PowerController } from './api/power.ts';
import { LeaderboardController } from './api/leaderboard.ts';
import {
  DecorationsController,
  SteamController,
  UserDecorationsController,
  XsollaController,
} from './api/platform.ts';
import {
  ApiExceptionFilter,
  ApiGuard,
  ApiInterceptor,
  SERVER_CONTEXT,
  secretsEqual,
} from './api/transport.ts';
import { AccountsService } from './services/accounts.ts';
import { MessagesService } from './services/messages.ts';
import { GameService } from './services/game.ts';
import { MarketService } from './services/market.ts';
import { PowerService } from './services/power.ts';
import { LeaderboardService } from './services/leaderboard.ts';
import { SteamNewsService } from './services/steam-news.ts';
import { AdminService } from './services/admin.service.ts';
import { HostService } from './services/host.service.ts';
import { RealtimeService } from './services/realtime.service.ts';

@Module({})
export class OpenScreepsModule implements OnModuleDestroy {
  constructor(@Inject(ServerKernel) readonly kernel: ServerKernel) {}

  async onModuleDestroy(): Promise<void> {
    // Drain outstanding mutations before TypeORM destroys the database connection.
    await this.kernel.close();
  }

  static register(
    config: ServerConfig,
    options: { state?: ServerState; now?: () => number } = {},
  ): DynamicModule {
    return {
      module: OpenScreepsModule,
      imports: [PersistenceModule.register(config)],
      controllers: [
        InformationController,
        RootController,
        HostController,
        AdminController,
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
        {
          provide: ServerKernel,
          useFactory: (store: StateStore) => ServerKernel.create(config, options, store),
          inject: [StateStore],
        },
        {
          provide: SERVER_CONTEXT,
          useFactory: (kernel: ServerKernel): ApiContext =>
            Object.assign(kernel, { auth: createAuthService(kernel) }),
          inject: [ServerKernel],
        },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        ApiGuard,
        ApiInterceptor,
        AdminGuard,
        AccountsService,
        MessagesService,
        GameService,
        MarketService,
        PowerService,
        LeaderboardService,
        SteamNewsService,
        AdminService,
        HostService,
        RealtimeService,
      ],
      exports: [ServerKernel, SERVER_CONTEXT],
    };
  }
}

export interface ServerOptions extends Partial<ServerConfig> {
  initialState?: ServerState;
  now?: () => number;
}

export interface RunningServer extends AsyncDisposable {
  readonly kernel: ServerKernel;
  readonly context: ApiContext;
  readonly address: AddressInfo;
  close(): Promise<void>;
}

/** Start a complete Nest application with the default Express adapter and official SockJS transport. */
export async function createServer(options: ServerOptions = {}): Promise<RunningServer> {
  const { initialState, now, ...settings } = options;
  const config = createConfig(settings);
  let app: NestExpressApplication | undefined;
  try {
    app = await NestFactory.create<NestExpressApplication>(
      OpenScreepsModule.register(config, {
        ...(initialState === undefined ? {} : { state: initialState }),
        ...(now === undefined ? {} : { now }),
      }),
      { bodyParser: false, logger: false, abortOnError: false },
    );
    app.enableCors({
      origin: true,
      exposedHeaders: ['X-Token'],
      methods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
    });
    app.use(
      '/admin',
      (request: Request, response: Response, next: NextFunction) => {
        // Authenticate before buffering potentially large world backups, not only in the Nest guard.
        if (!config.adminToken) {
          response.status(403).json({ error: 'admin API disabled' });
          return;
        }
        const authorization = request.get('Authorization');
        if (!authorization?.startsWith('Bearer ')) {
          response.set('WWW-Authenticate', 'Bearer').status(401).json({ error: 'unauthorized' });
          return;
        }
        if (!secretsEqual(authorization.slice(7), config.adminToken)) {
          response.status(403).json({ error: 'forbidden' });
          return;
        }
        next();
      },
      json({ limit: '256mb' }),
    );
    app.use(json({ limit: '8mb' }));
    app.use(urlencoded({ limit: '8mb', extended: true }));
    await app.init();
    const rawServer: unknown = app.getHttpServer();
    if (!(rawServer instanceof HttpServer))
      throw new Error('Nest did not create a Node HTTP server');
    const server = rawServer as HttpServer;
    await app.listen(config.port, config.host);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listen address');
    const kernel = app.get(ServerKernel);
    const context = app.get<ApiContext>(SERVER_CONTEXT);
    kernel.start();
    let closing: Promise<void> | undefined;
    const application = app;
    const close = (): Promise<void> => (closing ??= application.close());
    return { kernel, context, address, close, [Symbol.asyncDispose]: close };
  } catch (error) {
    await app?.close();
    throw error;
  }
}
