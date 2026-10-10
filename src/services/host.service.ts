import { Inject, Injectable } from '@nestjs/common';
import { ApiError, type ApiContext } from '../contracts.ts';
import { SERVER_CONTEXT } from '../api/transport.ts';
import { historyTicks } from '../realtime/diff.ts';
import { getAsset } from '../assets.ts';
import { ServerKernel } from './server-kernel.service.ts';

@Injectable()
export class HostService {
  constructor(
    @Inject(SERVER_CONTEXT) readonly context: ApiContext,
    @Inject(ServerKernel) readonly kernel: ServerKernel,
  ) {}

  version() {
    const { context } = this;
    return {
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
    };
  }

  history(room: string, base: number) {
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
