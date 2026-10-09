import { Controller, Get, Inject, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import type { ApiRequest } from '../contracts.ts';
import { AccountsService } from '../services/accounts.ts';
import { ApiGuard, ApiInput, ApiInterceptor, ApiPolicy } from './transport.ts';

@Controller('api/auth')
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class AuthController {
  constructor(@Inject(AccountsService) readonly service: AccountsService) {}

  @Get('me')
  @ApiPolicy({ auth: true })
  me(@ApiInput() request: ApiRequest) {
    return this.service.me(request);
  }

  @Post('signin')
  @ApiPolicy({ write: true })
  signin(@ApiInput() request: ApiRequest) {
    return this.service.signin(request);
  }

  @Post('steam-ticket')
  @ApiPolicy({ unlocked: true })
  steamTicket(@ApiInput() request: ApiRequest) {
    return this.service.steamTicket(request);
  }
}

@Controller('api/register')
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class RegistrationController {
  constructor(@Inject(AccountsService) readonly service: AccountsService) {}

  @Get('check-email')
  @ApiPolicy()
  checkEmail(@ApiInput() request: ApiRequest) {
    return this.service.checkEmail(request);
  }

  @Get('check-username')
  @ApiPolicy()
  checkUsername(@ApiInput() request: ApiRequest) {
    return this.service.checkUsername(request);
  }

  @Post('set-username')
  @ApiPolicy({ auth: true, write: true })
  setUsername(@ApiInput() request: ApiRequest) {
    return this.service.setUsername(request);
  }
}

@Controller('api/user')
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class UserController {
  constructor(@Inject(AccountsService) readonly service: AccountsService) {}

  // --- /api/user: world ---------------------------------------------------------------------
  @Get('world-start-room')
  @ApiPolicy({ auth: true })
  worldStartRoom(@ApiInput() request: ApiRequest) {
    return this.service.worldStartRoom(request);
  }

  @Get('world-status')
  @ApiPolicy({ auth: true })
  worldStatus(@ApiInput() request: ApiRequest) {
    return this.service.worldStatus(request);
  }

  @Get('respawn-prohibited-rooms')
  @ApiPolicy({ auth: true })
  respawnProhibitedRooms(@ApiInput() request: ApiRequest) {
    return this.service.respawnProhibitedRooms(request);
  }

  @Post('respawn')
  @ApiPolicy({ auth: true, write: true })
  respawn(@ApiInput() request: ApiRequest) {
    return this.service.respawn(request);
  }

  @Get('rooms')
  @ApiPolicy()
  rooms(@ApiInput() request: ApiRequest) {
    return this.service.rooms(request);
  }

  // --- /api/user: code branches -------------------------------------------------------------
  @Get('branches')
  @ApiPolicy({ auth: true, write: true })
  branches(@ApiInput() request: ApiRequest) {
    return this.service.branches(request);
  }

  @Post('code')
  @ApiPolicy({ auth: true, write: true })
  saveCode(@ApiInput() request: ApiRequest) {
    return this.service.saveCode(request);
  }

  @Get('code')
  @ApiPolicy({ auth: true })
  code(@ApiInput() request: ApiRequest) {
    return this.service.code(request);
  }

  @Post('set-active-branch')
  @ApiPolicy({ auth: true, write: true })
  setActiveBranch(@ApiInput() request: ApiRequest) {
    return this.service.setActiveBranch(request);
  }

  @Post('clone-branch')
  @ApiPolicy({ auth: true, write: true })
  cloneBranch(@ApiInput() request: ApiRequest) {
    return this.service.cloneBranch(request);
  }

  @Post('delete-branch')
  @ApiPolicy({ auth: true, write: true })
  deleteBranch(@ApiInput() request: ApiRequest) {
    return this.service.deleteBranch(request);
  }

  // --- /api/user: memory and console --------------------------------------------------------
  @Get('memory')
  @ApiPolicy({ auth: true })
  memory(@ApiInput() request: ApiRequest) {
    return this.service.memory(request);
  }

  @Post('memory')
  @ApiPolicy({ auth: true, write: true })
  setMemory(@ApiInput() request: ApiRequest) {
    return this.service.setMemory(request);
  }

  @Get('memory-segment')
  @ApiPolicy({ auth: true })
  memorySegment(@ApiInput() request: ApiRequest) {
    return this.service.memorySegment(request);
  }

  @Post('memory-segment')
  @ApiPolicy({ auth: true, write: true })
  setMemorySegment(@ApiInput() request: ApiRequest) {
    return this.service.setMemorySegment(request);
  }

  @Post('console')
  @ApiPolicy({ auth: true, write: true })
  console(@ApiInput() request: ApiRequest) {
    return this.service.console(request);
  }

  // --- /api/user: profile -------------------------------------------------------------------
  @Get('find')
  @ApiPolicy()
  find(@ApiInput() request: ApiRequest) {
    return this.service.find(request);
  }

  @Post('badge')
  @ApiPolicy({ auth: true, write: true })
  badge(@ApiInput() request: ApiRequest) {
    return this.service.badge(request);
  }

  @Get('badge-svg')
  @ApiPolicy()
  badgeSvg(@ApiInput() request: ApiRequest) {
    return this.service.badgeSvg(request);
  }

  @Post('notify-prefs')
  @ApiPolicy({ auth: true, write: true })
  notifyPrefs(@ApiInput() request: ApiRequest) {
    return this.service.notifyPrefs(request);
  }

  @Post('email')
  @ApiPolicy({ auth: true, write: true })
  email(@ApiInput() request: ApiRequest) {
    return this.service.email(request);
  }

  @Post('set-steam-visible')
  @ApiPolicy({ auth: true, write: true })
  setSteamVisible(@ApiInput() request: ApiRequest) {
    return this.service.setSteamVisible(request);
  }

  @Post('tutorial-done')
  @ApiPolicy({ auth: true })
  tutorialDone(@ApiInput() request: ApiRequest) {
    return this.service.tutorialDone(request);
  }

  @Get('money-history')
  @ApiPolicy({ auth: true })
  moneyHistory(@ApiInput() request: ApiRequest): ReturnType<AccountsService['moneyHistory']> {
    return this.service.moneyHistory(request);
  }

  // --- /api/user: statistics ----------------------------------------------------------------
  @Get('stats')
  @ApiPolicy()
  stats(@ApiInput() request: ApiRequest) {
    return this.service.stats(request);
  }

  @Get('overview')
  @ApiPolicy({ auth: true })
  overview(@ApiInput() request: ApiRequest) {
    return this.service.overview(request);
  }
}
