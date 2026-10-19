import { Controller, Inject, UseGuards, UseInterceptors } from '@nestjs/common';
import type { ApiRequest } from '../contracts.ts';
import { ApiTokensService } from '../services/api-tokens.ts';
import { ApiOperation } from './operations.ts';
import { ApiGuard, ApiInput, ApiInterceptor } from './transport.ts';

@Controller()
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class ApiTokensController {
  constructor(@Inject(ApiTokensService) readonly service: ApiTokensService) {}

  @ApiOperation('userAuthTokenList', { auth: true })
  list(@ApiInput() request: ApiRequest) {
    return this.service.list(request);
  }

  @ApiOperation('userAuthTokenCreate', { auth: true, write: true })
  create(@ApiInput() request: ApiRequest) {
    return this.service.create(request);
  }

  @ApiOperation('userAuthTokenDelete', { auth: true, write: true })
  delete(@ApiInput() request: ApiRequest) {
    return this.service.delete(request);
  }

  @ApiOperation('authQueryToken')
  query(@ApiInput() request: ApiRequest) {
    return this.service.query(request);
  }
}
