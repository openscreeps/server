import { Controller, Inject, UseGuards, UseInterceptors } from '@nestjs/common';
import type { ApiRequest } from '../contracts.ts';
import { PowerService } from '../services/power.ts';
import { ApiOperation } from './operations.ts';
import { ApiGuard, ApiInput, ApiInterceptor } from './transport.ts';

@Controller()
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class PowerController {
  constructor(@Inject(PowerService) readonly service: PowerService) {}

  @ApiOperation('powerCreepsList', { auth: true })
  list(@ApiInput() request: ApiRequest): ReturnType<PowerService['list']> {
    return this.service.list(request);
  }

  @ApiOperation('powerCreepsCreate', { auth: true, write: true })
  create(@ApiInput() request: ApiRequest): ReturnType<PowerService['create']> {
    return this.service.create(request);
  }

  @ApiOperation('powerCreepsDelete', { auth: true, write: true })
  delete(@ApiInput() request: ApiRequest) {
    return this.service.delete(request);
  }

  @ApiOperation('powerCreepsCancelDelete', { auth: true, write: true })
  cancelDelete(@ApiInput() request: ApiRequest) {
    return this.service.cancelDelete(request);
  }

  @ApiOperation('powerCreepsUpgrade', { auth: true, write: true })
  upgrade(@ApiInput() request: ApiRequest) {
    return this.service.upgrade(request);
  }

  @ApiOperation('powerCreepsRename', { auth: true, write: true })
  rename(@ApiInput() request: ApiRequest) {
    return this.service.rename(request);
  }

  @ApiOperation('powerCreepsExperimentation', { auth: true, write: true })
  experimentation(@ApiInput() request: ApiRequest) {
    return this.service.experimentation(request);
  }
}
