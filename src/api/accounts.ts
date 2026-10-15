import { Controller, Inject, UseGuards, UseInterceptors } from '@nestjs/common';
import type { ApiRequest } from '../contracts.ts';
import { AccountsService } from '../services/accounts.ts';
import { ApiOperation } from './operations.ts';
import { ApiGuard, ApiInput, ApiInterceptor } from './transport.ts';

@Controller()
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class AuthController {
  constructor(@Inject(AccountsService) readonly service: AccountsService) {}

  @ApiOperation('authMe', { auth: true })
  me(@ApiInput() request: ApiRequest) {
    return this.service.me(request);
  }

  @ApiOperation('authSignin', { write: true })
  signin(@ApiInput() request: ApiRequest) {
    return this.service.signin(request);
  }

  @ApiOperation('authSteamTicket', { unlocked: true })
  steamTicket(@ApiInput() request: ApiRequest) {
    return this.service.steamTicket(request);
  }
}

@Controller()
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class RegistrationController {
  constructor(@Inject(AccountsService) readonly service: AccountsService) {}

  @ApiOperation('registerCheckEmail')
  checkEmail(@ApiInput() request: ApiRequest) {
    return this.service.checkEmail(request);
  }

  @ApiOperation('registerCheckUsername')
  checkUsername(@ApiInput() request: ApiRequest) {
    return this.service.checkUsername(request);
  }

  @ApiOperation('registerSetUsername', { auth: true, write: true })
  setUsername(@ApiInput() request: ApiRequest) {
    return this.service.setUsername(request);
  }

  @ApiOperation('registerSubmit', { write: true })
  register(@ApiInput() request: ApiRequest) {
    return this.service.register(request);
  }
}

@Controller()
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class UserController {
  constructor(@Inject(AccountsService) readonly service: AccountsService) {}

  // --- /api/user: world ---------------------------------------------------------------------
  @ApiOperation('userWorldStartRoom', { auth: true })
  worldStartRoom(@ApiInput() request: ApiRequest) {
    return this.service.worldStartRoom(request);
  }

  @ApiOperation('userWorldStatus', { auth: true })
  worldStatus(@ApiInput() request: ApiRequest) {
    return this.service.worldStatus(request);
  }

  @ApiOperation('userRespawnProhibitedRooms', { auth: true })
  respawnProhibitedRooms(@ApiInput() request: ApiRequest) {
    return this.service.respawnProhibitedRooms(request);
  }

  @ApiOperation('userRespawn', { auth: true, write: true })
  respawn(@ApiInput() request: ApiRequest) {
    return this.service.respawn(request);
  }

  @ApiOperation('userRooms')
  rooms(@ApiInput() request: ApiRequest) {
    return this.service.rooms(request);
  }

  // --- /api/user: code branches -------------------------------------------------------------
  @ApiOperation('userBranches', { auth: true, write: true })
  branches(@ApiInput() request: ApiRequest) {
    return this.service.branches(request);
  }

  @ApiOperation('userCodeSet', { auth: true, write: true })
  saveCode(@ApiInput() request: ApiRequest) {
    return this.service.saveCode(request);
  }

  @ApiOperation('userCodeGet', { auth: true })
  code(@ApiInput() request: ApiRequest) {
    return this.service.code(request);
  }

  @ApiOperation('userSetActiveBranch', { auth: true, write: true })
  setActiveBranch(@ApiInput() request: ApiRequest) {
    return this.service.setActiveBranch(request);
  }

  @ApiOperation('userCloneBranch', { auth: true, write: true })
  cloneBranch(@ApiInput() request: ApiRequest) {
    return this.service.cloneBranch(request);
  }

  @ApiOperation('userDeleteBranch', { auth: true, write: true })
  deleteBranch(@ApiInput() request: ApiRequest) {
    return this.service.deleteBranch(request);
  }

  // --- /api/user: memory and console --------------------------------------------------------
  @ApiOperation('userMemoryGet', { auth: true })
  memory(@ApiInput() request: ApiRequest) {
    return this.service.memory(request);
  }

  @ApiOperation('userMemorySet', { auth: true, write: true })
  setMemory(@ApiInput() request: ApiRequest) {
    return this.service.setMemory(request);
  }

  @ApiOperation('userMemorySegmentGet', { auth: true })
  memorySegment(@ApiInput() request: ApiRequest) {
    return this.service.memorySegment(request);
  }

  @ApiOperation('userMemorySegmentSet', { auth: true, write: true })
  setMemorySegment(@ApiInput() request: ApiRequest) {
    return this.service.setMemorySegment(request);
  }

  @ApiOperation('userConsole', { auth: true, write: true })
  console(@ApiInput() request: ApiRequest) {
    return this.service.console(request);
  }

  // --- /api/user: profile -------------------------------------------------------------------
  @ApiOperation('userName', { auth: true })
  name(@ApiInput() request: ApiRequest) {
    return this.service.name(request);
  }

  @ApiOperation('userFind')
  find(@ApiInput() request: ApiRequest) {
    return this.service.find(request);
  }

  @ApiOperation('userBadgeSet', { auth: true, write: true })
  badge(@ApiInput() request: ApiRequest) {
    return this.service.badge(request);
  }

  @ApiOperation('userBadgeSvg')
  badgeSvg(@ApiInput() request: ApiRequest) {
    return this.service.badgeSvg(request);
  }

  @ApiOperation('userNotifyPrefsSet', { auth: true, write: true })
  notifyPrefs(@ApiInput() request: ApiRequest) {
    return this.service.notifyPrefs(request);
  }

  @ApiOperation('userEmailSet', { auth: true, write: true })
  email(@ApiInput() request: ApiRequest) {
    return this.service.email(request);
  }

  @ApiOperation('userSetSteamVisible', { auth: true, write: true })
  setSteamVisible(@ApiInput() request: ApiRequest) {
    return this.service.setSteamVisible(request);
  }

  @ApiOperation('userTutorialDone', { auth: true })
  tutorialDone(@ApiInput() request: ApiRequest) {
    return this.service.tutorialDone(request);
  }

  @ApiOperation('userMoneyHistory', { auth: true })
  moneyHistory(@ApiInput() request: ApiRequest): ReturnType<AccountsService['moneyHistory']> {
    return this.service.moneyHistory(request);
  }

  @ApiOperation('userMoneyHistoryDetails', { auth: true })
  moneyHistoryDetails(@ApiInput() request: ApiRequest) {
    return this.service.moneyHistoryDetails(request);
  }

  @ApiOperation('userPasswordSet', { auth: true, write: true })
  setPassword(@ApiInput() request: ApiRequest) {
    return this.service.setPassword(request);
  }

  // --- /api/user: statistics ----------------------------------------------------------------
  @ApiOperation('userStats')
  stats(@ApiInput() request: ApiRequest) {
    return this.service.stats(request);
  }

  @ApiOperation('userOverview', { auth: true })
  overview(@ApiInput() request: ApiRequest) {
    return this.service.overview(request);
  }
}
