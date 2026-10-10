import { Controller, Inject, UseGuards, UseInterceptors } from '@nestjs/common';
import type { ApiRequest } from '../contracts.ts';
import { MarketService } from '../services/market.ts';
import { ApiOperation } from './operations.ts';
import { ApiGuard, ApiInput, ApiInterceptor } from './transport.ts';

@Controller()
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class MarketController {
  constructor(@Inject(MarketService) readonly service: MarketService) {}

  @ApiOperation('marketOrdersIndex', { auth: true })
  ordersIndex() {
    return this.service.ordersIndex();
  }

  @ApiOperation('marketOrders', { auth: true })
  orders(@ApiInput() request: ApiRequest) {
    return this.service.orders(request);
  }

  @ApiOperation('marketMyOrders', { auth: true })
  myOrders(@ApiInput() request: ApiRequest) {
    return this.service.myOrders(request);
  }

  @ApiOperation('marketStats', { auth: true })
  stats(@ApiInput() request: ApiRequest): ReturnType<MarketService['stats']> {
    return this.service.stats(request);
  }
}
