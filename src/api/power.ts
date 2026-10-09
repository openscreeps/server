import { Controller, Get, Inject, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import type { ApiRequest } from '../contracts.ts';
import { PowerService } from '../services/power.ts';
import { ApiGuard, ApiInput, ApiInterceptor, ApiPolicy } from './transport.ts';

@Controller('api/game/power-creeps')
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class PowerController {
  constructor(@Inject(PowerService) readonly service: PowerService) {}

  @Get('list')
  @ApiPolicy({ auth: true })
  list(@ApiInput() request: ApiRequest): ReturnType<PowerService['list']> {
    return this.service.list(request);
  }

  @Post('create')
  @ApiPolicy({ auth: true, write: true })
  create(@ApiInput() request: ApiRequest): ReturnType<PowerService['create']> {
    return this.service.create(request);
  }

  @Post('delete')
  @ApiPolicy({ auth: true, write: true })
  delete(@ApiInput() request: ApiRequest) {
    return this.service.delete(request);
  }

  @Post('cancel-delete')
  @ApiPolicy({ auth: true, write: true })
  cancelDelete(@ApiInput() request: ApiRequest) {
    return this.service.cancelDelete(request);
  }

  @Post('upgrade')
  @ApiPolicy({ auth: true, write: true })
  upgrade(@ApiInput() request: ApiRequest) {
    return this.service.upgrade(request);
  }

  @Post('rename')
  @ApiPolicy({ auth: true, write: true })
  rename(@ApiInput() request: ApiRequest) {
    return this.service.rename(request);
  }

  @Post('experimentation')
  @ApiPolicy({ auth: true, write: true })
  experimentation(@ApiInput() request: ApiRequest) {
    return this.service.experimentation(request);
  }
}
