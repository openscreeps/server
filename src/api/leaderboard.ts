import { Controller, Get, Inject, UseGuards, UseInterceptors } from '@nestjs/common';
import type { ApiRequest } from '../contracts.ts';
import { LeaderboardService } from '../services/leaderboard.ts';
import { ApiGuard, ApiInput, ApiInterceptor, ApiPolicy } from './transport.ts';

@Controller('api/leaderboard')
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class LeaderboardController {
  constructor(@Inject(LeaderboardService) readonly service: LeaderboardService) {}

  @Get('seasons')
  @ApiPolicy()
  seasons() {
    return this.service.seasons();
  }

  @Get('list')
  @ApiPolicy()
  list(@ApiInput() request: ApiRequest): ReturnType<LeaderboardService['list']> {
    return this.service.list(request);
  }

  @Get('find')
  @ApiPolicy()
  find(@ApiInput() request: ApiRequest): ReturnType<LeaderboardService['find']> {
    return this.service.find(request);
  }
}
