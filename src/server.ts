import 'reflect-metadata';
import {
  Catch,
  Controller,
  Get,
  HttpException,
  Inject,
  Module,
  Param,
  Res,
  type ArgumentsHost,
  type DynamicModule,
  type ExceptionFilter,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded, type NextFunction, type Request, type Response } from 'express';
import { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiError, type ApiContext, type ServerConfig, type ServerState } from './contracts.ts';
import { createConfig } from './config.ts';
import { ServerKernel } from './kernel.ts';
import { createAuthService } from './api/auth.ts';
import {
  ApiController,
  ApiDispatcher,
  RootController,
  SERVER_CONTEXT,
  secretsEqual,
  sendError,
} from './http.ts';
import { AdminController, AdminGuard } from './admin.ts';
import { getAsset } from './assets.ts';
import { installRealtime } from './realtime/index.ts';

@Controller()
class HostController {
  constructor(
    @Inject(SERVER_CONTEXT) readonly context: ApiContext,
    @Inject(ServerKernel) readonly kernel: ServerKernel,
  ) {}

  @Get('health')
  async health(@Res() response: Response): Promise<void> {
    if (!this.kernel.healthy) {
      response.status(503).json({ error: 'server unavailable' });
      return;
    }
    try {
      const state = await this.context.read(() => ({
        ok: 1,
        time: this.context.state.world.gameTime,
        paused: this.context.state.paused,
      }));
      response.json(state);
    } catch {
      response.status(503).json({ error: 'server unavailable' });
    }
  }

  @Get('assets/{*path}')
  async asset(@Param('path') rawPath: unknown, @Res() response: Response): Promise<void> {
    try {
      let path: string;
      if (typeof rawPath === 'string') path = rawPath;
      else if (
        Array.isArray(rawPath) &&
        rawPath.every((item: unknown) => typeof item === 'string')
      ) {
        path = rawPath.join('/');
      } else throw new ApiError('not found', 404);
      const asset = await getAsset(this.context, path);
      if (!asset) throw new ApiError('not found', 404);
      response
        .set('Cache-Control', 'no-cache')
        .set('X-Content-Type-Options', 'nosniff')
        .type(asset.contentType)
        .send(asset.body);
    } catch (error) {
      sendError(error, response);
    }
  }
}

@Catch()
class HttpErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) return;
    if (error instanceof HttpException) {
      const body = error.getResponse();
      if (typeof body === 'object' && 'error' in body)
        response.status(error.getStatus()).json(body);
      else response.status(error.getStatus()).json({ error: error.message });
    } else if (
      error instanceof Error &&
      'status' in error &&
      typeof error.status === 'number' &&
      error.status >= 400 &&
      error.status < 500
    ) {
      response
        .status(error.status)
        .json({ error: error.status === 413 ? 'request too large' : 'invalid request' });
    } else sendError(error, response);
  }
}

@Module({})
export class OpenScreepsModule {
  constructor(@Inject(ServerKernel) readonly kernel: ServerKernel) {}

  async onApplicationShutdown(): Promise<void> {
    await this.kernel.close();
  }

  static register(kernel: ServerKernel, context: ApiContext): DynamicModule {
    return {
      module: OpenScreepsModule,
      controllers: [ApiController, RootController, HostController, AdminController],
      providers: [
        { provide: ServerKernel, useValue: kernel },
        { provide: SERVER_CONTEXT, useValue: context },
        ApiDispatcher,
        AdminGuard,
      ],
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
  const kernel = new ServerKernel(config, {
    ...(initialState === undefined ? {} : { state: initialState }),
    ...(now === undefined ? {} : { now }),
  });
  const context: ApiContext = Object.assign(kernel, { auth: createAuthService(kernel) });
  let app: NestExpressApplication | undefined;
  let realtime: { close(): void } | undefined;
  try {
    app = await NestFactory.create<NestExpressApplication>(
      OpenScreepsModule.register(kernel, context),
      {
        bodyParser: false,
        logger: false,
        abortOnError: false,
      },
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
    app.useGlobalFilters(new HttpErrorFilter());
    await app.init();
    const rawServer: unknown = app.getHttpServer();
    if (!(rawServer instanceof HttpServer))
      throw new Error('Nest did not create a Node HTTP server');
    const server = rawServer as HttpServer;
    realtime = installRealtime(server, context);
    await app.listen(config.port, config.host);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listen address');
    kernel.start();
    let closing: Promise<void> | undefined;
    const application = app;
    const sockets = realtime;
    const close = (): Promise<void> =>
      (closing ??= (async () => {
        sockets.close();
        try {
          await application.close();
        } finally {
          await kernel.close();
        }
      })());
    return { kernel, context, address, close, [Symbol.asyncDispose]: close };
  } catch (error) {
    realtime?.close();
    try {
      await app?.close();
    } finally {
      await kernel.close();
    }
    throw error;
  }
}
