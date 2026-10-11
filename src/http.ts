import {
  Controller,
  Header,
  Inject,
  Param,
  Query,
  StreamableFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiError } from './contracts.ts';
import { HostService } from './services/host.service.ts';
import { ApiOperation, Operation } from './api/operations.ts';
import { ApiGuard, ApiInterceptor } from './api/transport.ts';

@Controller()
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class InformationController {
  constructor(@Inject(HostService) readonly service: HostService) {}

  @ApiOperation('platformVersion')
  version() {
    return this.service.version();
  }
}

@Controller()
export class RootController {
  constructor(@Inject(HostService) readonly service: HostService) {}

  @Operation('platformRoot')
  @Header('Content-Type', 'text/html; charset=utf-8')
  root(): string {
    return '<!doctype html><title>OpenScreeps</title><h1>OpenScreeps server</h1><p>Connect using the Screeps game client.</p>';
  }

  @Operation('platformRoomHistory')
  @UseGuards(ApiGuard)
  async history(@Query('room') room: unknown, @Query('time') time: unknown) {
    const base = typeof time === 'string' ? Number(time) : NaN;
    if (typeof room !== 'string' || !Number.isSafeInteger(base) || base < 0) {
      throw new ApiError('invalid params', 400);
    }
    return this.service.history(room, base);
  }
}

@Controller()
export class HostController {
  constructor(@Inject(HostService) readonly service: HostService) {}

  @Operation('platformHealth')
  health() {
    return this.service.health();
  }

  @Operation('platformAsset')
  @Header('Cache-Control', 'no-cache')
  @Header('X-Content-Type-Options', 'nosniff')
  async asset(@Param('path') rawPath: unknown): Promise<StreamableFile> {
    let path: string;
    if (typeof rawPath === 'string') path = rawPath;
    else if (Array.isArray(rawPath) && rawPath.every((item: unknown) => typeof item === 'string')) {
      path = rawPath.join('/');
    } else throw new ApiError('not found', 404);
    const asset = await this.service.asset(path);
    return new StreamableFile(asset.body, { type: asset.contentType });
  }
}
