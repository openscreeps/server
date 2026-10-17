import { Inject, Injectable } from '@nestjs/common';
import { ApiError, type ApiContext } from '../contracts.ts';
import { SERVER_CONTEXT } from '../api/transport.ts';
import { historyTicks } from '../realtime/diff.ts';
import { getAsset } from '../assets.ts';
import { ServerKernel } from './server-kernel.service.ts';
import { SteamAuthService } from './native-steam.ts';
import type { OperationResult } from '../api/operations.ts';

/**
 * `serverData.features` of `GET /api/version`. The official client uses `market` and `auth`
 * (its MARKET_FEATURE and AUTH_FEATURE) whenever a server lists no features, so listing them
 * keeps its behaviour; `openscreeps` identifies this server to clients (version 1 of the
 * marker).
 */
const FEATURES = [
  {
    name: 'market',
    version: 1,
    menuData: [
      {
        section: 0,
        after: 'World',
        item: { label: 'Market', routerLink: '/market', svg: 'market' },
      },
    ],
  },
  { name: 'auth', version: 1 },
  { name: 'openscreeps', version: 1 },
];

@Injectable()
export class HostService {
  constructor(
    @Inject(SERVER_CONTEXT) readonly context: ApiContext,
    @Inject(ServerKernel) readonly kernel: ServerKernel,
    @Inject(SteamAuthService) readonly steam: SteamAuthService,
  ) {}

  version() {
    const { context } = this;
    return {
      protocol: 14,
      useNativeAuth: this.steam.useNativeAuth,
      users: Object.values(context.state.world.users).filter(
        (user) => user.active !== 0 && (user.cpu ?? 0) > 0 && !user.bot,
      ).length,
      packageVersion: '0.0.0',
      serverData: {
        welcomeText: this.kernel.mods.backend.welcomeText,
        customObjectTypes: this.kernel.mods.backend.customObjectTypes,
        historyChunkSize: this.kernel.mods.backend.historyChunkSize,
        socketUpdateThrottle: this.kernel.mods.backend.socketUpdateThrottle,
        renderer: this.kernel.mods.backend.renderer,
        features: FEATURES,
      },
    };
  }

  history(room: string, base: number): Promise<OperationResult<'platformRoomHistory'>> {
    const originalHistory = this.kernel.mods.backend.onGetRoomHistory;
    if (originalHistory) {
      const { promise, resolve, reject } =
        Promise.withResolvers<OperationResult<'platformRoomHistory'>>();
      originalHistory(room, base, (error, data) => {
        const message = error instanceof Error ? error.message : String(error);
        if (error) reject(new ApiError(message, 500));
        else if (data === undefined) reject(new ApiError('history not found', 404));
        else resolve(data);
      });
      return promise;
    }
    return this.context.read(() => {
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
  }

  async health() {
    if (!this.kernel.healthy) throw new ApiError('server unavailable', 503);
    try {
      return await this.context.read(() => ({
        ok: 1 as const,
        time: this.context.state.world.gameTime,
        paused: this.context.state.paused,
      }));
    } catch {
      throw new ApiError('server unavailable', 503);
    }
  }

  async asset(path: string): Promise<NonNullable<Awaited<ReturnType<typeof getAsset>>>> {
    const asset = await getAsset(this.context, path);
    if (!asset) throw new ApiError('not found', 404);
    return asset;
  }
}
