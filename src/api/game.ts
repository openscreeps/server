import { Controller, Get, Inject, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import type { ApiRequest } from '../contracts.ts';
import { GameService } from '../services/game.ts';
import { ApiGuard, ApiInput, ApiInterceptor, ApiPolicy } from './transport.ts';

@Controller('api/game')
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class GameController {
  constructor(@Inject(GameService) readonly service: GameService) {}

  @Post('map-stats')
  @ApiPolicy({ auth: true })
  mapStats(@ApiInput() request: ApiRequest) {
    return this.service.mapStats(request);
  }

  @Get('time')
  @ApiPolicy()
  time() {
    return this.service.time();
  }

  @Get('tick')
  @ApiPolicy()
  tick() {
    return this.service.tick();
  }

  @Get('world-size')
  @ApiPolicy()
  worldSize() {
    return this.service.worldSize();
  }

  @Get('room-terrain')
  @ApiPolicy()
  roomTerrain(@ApiInput() request: ApiRequest) {
    return this.service.roomTerrain(request);
  }

  @Post('rooms')
  @ApiPolicy()
  rooms(@ApiInput() request: ApiRequest) {
    return this.service.rooms(request);
  }

  @Get('room-status')
  @ApiPolicy({ auth: true })
  roomStatus(@ApiInput() request: ApiRequest) {
    return this.service.roomStatus(request);
  }

  @Get('room-overview')
  @ApiPolicy({ auth: true })
  roomOverview(@ApiInput() request: ApiRequest) {
    return this.service.roomOverview(request);
  }

  @Post('gen-unique-object-name')
  @ApiPolicy({ auth: true })
  genUniqueObjectName(@ApiInput() request: ApiRequest) {
    return this.service.genUniqueObjectName(request);
  }

  @Post('check-unique-object-name')
  @ApiPolicy({ auth: true })
  checkUniqueObjectName(@ApiInput() request: ApiRequest) {
    return this.service.checkUniqueObjectName(request);
  }

  @Post('place-spawn')
  @ApiPolicy({ auth: true, write: true })
  placeSpawn(@ApiInput() request: ApiRequest) {
    return this.service.placeSpawn(request);
  }

  @Post('create-construction')
  @ApiPolicy({ auth: true, write: true })
  createConstruction(@ApiInput() request: ApiRequest) {
    return this.service.createConstruction(request);
  }

  @Post('create-flag')
  @ApiPolicy({ auth: true, write: true })
  createFlag(@ApiInput() request: ApiRequest) {
    return this.service.createFlag(request);
  }

  @Post('gen-unique-flag-name')
  @ApiPolicy({ auth: true })
  genUniqueFlagName(@ApiInput() request: ApiRequest) {
    return this.service.genUniqueFlagName(request);
  }

  @Post('check-unique-flag-name')
  @ApiPolicy({ auth: true })
  checkUniqueFlagName(@ApiInput() request: ApiRequest) {
    return this.service.checkUniqueFlagName(request);
  }

  @Post('change-flag-color')
  @ApiPolicy({ auth: true, write: true })
  changeFlagColor(@ApiInput() request: ApiRequest) {
    return this.service.changeFlagColor(request);
  }

  @Post('remove-flag')
  @ApiPolicy({ auth: true, write: true })
  removeFlag(@ApiInput() request: ApiRequest) {
    return this.service.removeFlag(request);
  }

  @Post('add-object-intent')
  @ApiPolicy({ auth: true, write: true })
  addObjectIntent(@ApiInput() request: ApiRequest) {
    return this.service.addObjectIntent(request);
  }

  @Post('add-global-intent')
  @ApiPolicy({ auth: true, write: true })
  addGlobalIntent(@ApiInput() request: ApiRequest) {
    return this.service.addGlobalIntent(request);
  }

  @Post('set-notify-when-attacked')
  @ApiPolicy({ auth: true, write: true })
  setNotifyWhenAttacked(@ApiInput() request: ApiRequest) {
    return this.service.setNotifyWhenAttacked(request);
  }

  @Post('create-invader')
  @ApiPolicy({ auth: true, write: true })
  createInvader(@ApiInput() request: ApiRequest): ReturnType<GameService['createInvader']> {
    return this.service.createInvader(request);
  }

  @Post('remove-invader')
  @ApiPolicy({ auth: true, write: true })
  removeInvader(@ApiInput() request: ApiRequest) {
    return this.service.removeInvader(request);
  }
}
