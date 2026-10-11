import { Controller, Inject, UseGuards, UseInterceptors } from '@nestjs/common';
import type { ApiRequest } from '../contracts.ts';
import { LeaderboardService } from '../services/leaderboard.ts';
import { ApiOperation } from './operations.ts';
import { ApiGuard, ApiInput, ApiInterceptor } from './transport.ts';

@Controller()
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class LeaderboardController {
  constructor(@Inject(LeaderboardService) readonly service: LeaderboardService) {}

  @ApiOperation('leaderboardSeasons')
  seasons() {
    return this.service.seasons();
  }

  @ApiOperation('leaderboardList')
  list(@ApiInput() request: ApiRequest): ReturnType<LeaderboardService['list']> {
    return this.service.list(request);
  }

  @ApiOperation('leaderboardFind')
  find(@ApiInput() request: ApiRequest): ReturnType<LeaderboardService['find']> {
    return this.service.find(request);
  }
}
