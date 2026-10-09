import { Controller, Get, Inject, UseGuards, UseInterceptors } from '@nestjs/common';
import type { ApiRequest } from '../contracts.ts';
import { MarketService } from '../services/market.ts';
import { ApiGuard, ApiInput, ApiInterceptor, ApiPolicy } from './transport.ts';

@Controller('api/game/market')
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class MarketController {
  constructor(@Inject(MarketService) readonly service: MarketService) {}

  @Get('orders-index')
  @ApiPolicy({ auth: true })
  ordersIndex() {
    return this.service.ordersIndex();
  }

  @Get('orders')
  @ApiPolicy({ auth: true })
  orders(@ApiInput() request: ApiRequest) {
    return this.service.orders(request);
  }

  @Get('my-orders')
  @ApiPolicy({ auth: true })
  myOrders(@ApiInput() request: ApiRequest) {
    return this.service.myOrders(request);
  }

  @Get('stats')
  @ApiPolicy({ auth: true })
  stats(@ApiInput() request: ApiRequest): ReturnType<MarketService['stats']> {
    return this.service.stats(request);
  }
}
