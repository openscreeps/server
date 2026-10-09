import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Server } from 'node:http';
import { SERVER_CONTEXT } from '../api/transport.ts';
import type { ApiContext } from '../contracts.ts';
import { installRealtime } from '../realtime/index.ts';

/** SockJS must attach after Nest's HTTP routes and close before the HTTP server is disposed. */
@Injectable()
export class RealtimeService implements OnApplicationBootstrap, OnModuleDestroy {
  #realtime: ReturnType<typeof installRealtime> | undefined;

  constructor(
    @Inject(HttpAdapterHost) readonly adapter: HttpAdapterHost,
    @Inject(SERVER_CONTEXT) readonly context: ApiContext,
  ) {}

  onApplicationBootstrap(): void {
    const server: unknown = this.adapter.httpAdapter.getHttpServer();
    if (!(server instanceof Server)) throw new Error('SockJS requires a Node HTTP server');
    this.#realtime = installRealtime(server as Server, this.context);
  }

  onModuleDestroy(): void {
    this.#realtime?.close();
    this.#realtime = undefined;
  }
}
