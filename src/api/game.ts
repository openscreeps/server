import { Controller, Inject, UseGuards, UseInterceptors } from '@nestjs/common';
import type { ApiRequest } from '../contracts.ts';
import { GameService } from '../services/game.ts';
import { ApiOperation } from './operations.ts';
import { ApiGuard, ApiInput, ApiInterceptor } from './transport.ts';

@Controller()
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class GameController {
  constructor(@Inject(GameService) readonly service: GameService) {}

  @ApiOperation('gameMapStats', { auth: true })
  mapStats(@ApiInput() request: ApiRequest) {
    return this.service.mapStats(request);
  }

  @ApiOperation('gameTime')
  time() {
    return this.service.time();
  }

  @ApiOperation('gameTick')
  tick() {
    return this.service.tick();
  }

  @ApiOperation('gameWorldSize')
  worldSize() {
    return this.service.worldSize();
  }

  @ApiOperation('gameRoomTerrain')
  roomTerrain(@ApiInput() request: ApiRequest) {
    return this.service.roomTerrain(request);
  }

  @ApiOperation('gameRooms')
  rooms(@ApiInput() request: ApiRequest) {
    return this.service.rooms(request);
  }

  @ApiOperation('gameRoomStatus', { auth: true })
  roomStatus(@ApiInput() request: ApiRequest) {
    return this.service.roomStatus(request);
  }

  /** Public like screeps.com: a supplied token is neither required nor refreshed. */
  @ApiOperation('gameRoomObjects')
  roomObjects(@ApiInput() request: ApiRequest) {
    return this.service.roomObjects(request);
  }

  /** Public like room-objects: a supplied token is neither required nor refreshed. */
  @ApiOperation('gameFindObject')
  findObject(@ApiInput() request: ApiRequest) {
    return this.service.findObject(request);
  }

  @ApiOperation('gameRandomNoviceRoom')
  randomNoviceRoom() {
    return this.service.randomNoviceRoom();
  }

  @ApiOperation('gameRoomOverview', { auth: true })
  roomOverview(@ApiInput() request: ApiRequest) {
    return this.service.roomOverview(request);
  }

  @ApiOperation('gameGenUniqueObjectName', { auth: true })
  genUniqueObjectName(@ApiInput() request: ApiRequest) {
    return this.service.genUniqueObjectName(request);
  }

  @ApiOperation('gameCheckUniqueObjectName', { auth: true })
  checkUniqueObjectName(@ApiInput() request: ApiRequest) {
    return this.service.checkUniqueObjectName(request);
  }

  @ApiOperation('gamePlaceSpawn', { auth: true, write: true })
  placeSpawn(@ApiInput() request: ApiRequest) {
    return this.service.placeSpawn(request);
  }

  @ApiOperation('gameCreateConstruction', { auth: true, write: true })
  createConstruction(@ApiInput() request: ApiRequest) {
    return this.service.createConstruction(request);
  }

  @ApiOperation('gameCreateFlag', { auth: true, write: true })
  createFlag(@ApiInput() request: ApiRequest) {
    return this.service.createFlag(request);
  }

  @ApiOperation('gameGenUniqueFlagName', { auth: true })
  genUniqueFlagName(@ApiInput() request: ApiRequest) {
    return this.service.genUniqueFlagName(request);
  }

  @ApiOperation('gameCheckUniqueFlagName', { auth: true })
  checkUniqueFlagName(@ApiInput() request: ApiRequest) {
    return this.service.checkUniqueFlagName(request);
  }

  @ApiOperation('gameChangeFlagColor', { auth: true, write: true })
  changeFlagColor(@ApiInput() request: ApiRequest) {
    return this.service.changeFlagColor(request);
  }

  @ApiOperation('gameRemoveFlag', { auth: true, write: true })
  removeFlag(@ApiInput() request: ApiRequest) {
    return this.service.removeFlag(request);
  }

  @ApiOperation('gameAddObjectIntent', { auth: true, write: true })
  addObjectIntent(@ApiInput() request: ApiRequest) {
    return this.service.addObjectIntent(request);
  }

  @ApiOperation('gameAddGlobalIntent', { auth: true, write: true })
  addGlobalIntent(@ApiInput() request: ApiRequest) {
    return this.service.addGlobalIntent(request);
  }

  @ApiOperation('gameSetNotifyWhenAttacked', { auth: true, write: true })
  setNotifyWhenAttacked(@ApiInput() request: ApiRequest) {
    return this.service.setNotifyWhenAttacked(request);
  }

  @ApiOperation('gameCreateInvader', { auth: true, write: true })
  createInvader(@ApiInput() request: ApiRequest): ReturnType<GameService['createInvader']> {
    return this.service.createInvader(request);
  }

  @ApiOperation('gameRemoveInvader', { auth: true, write: true })
  removeInvader(@ApiInput() request: ApiRequest) {
    return this.service.removeInvader(request);
  }
}
