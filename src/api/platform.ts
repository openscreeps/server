/*
 * Official-client requests to screeps.com platform services that the pinned standalone backend
 * does not serve: the Steam announcement feed, the Xsolla item-shop promotion banner and the
 * decoration inventory (room decorations, owned items, themes). The standalone compatibility
 * profile documents each adaptation; nothing here claims to provide the hosted service.
 */

import { Controller, Inject, UseGuards, UseInterceptors } from '@nestjs/common';
import { SteamNewsService } from '../services/steam-news.ts';
import { ApiOperation } from './operations.ts';
import { ApiGuard, ApiInterceptor } from './transport.ts';

@Controller()
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class SteamController {
  constructor(@Inject(SteamNewsService) readonly service: SteamNewsService) {}

  /** The upstream Steam request runs outside the world lock. */
  @ApiOperation('platformSteamNews', { unlocked: true })
  news() {
    return this.service.news();
  }
}

@Controller()
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class XsollaController {
  /**
   * screeps.com reports `{ok: 1, discount, dateUntil}` while its Xsolla item shop runs a sale and
   * `{ok: 1}` otherwise. This server sells nothing through Xsolla, so no promotion is ever active;
   * relaying screeps.com's sale would advertise purchases that do not reach this server's inventory.
   */
  @ApiOperation('platformActivePromotion', { unlocked: true })
  activePromotion() {
    return {};
  }
}

@Controller()
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class DecorationsController {
  /**
   * screeps.com lists the inventory decorations players have activated in a room as
   * `{decorations: [{user, active, decoration}]}` and `[]` for an undecorated room. This server has
   * no decoration inventory (and `/api/version` advertises no `inventory` feature), so every room
   * is undecorated.
   */
  @ApiOperation('gameRoomDecorations', { unlocked: true })
  roomDecorations() {
    return { decorations: [] };
  }
}

@Controller()
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class UserDecorationsController {
  /** The player's decoration items, `{list: [...]}` on screeps.com; nobody owns any here. */
  @ApiOperation('userDecorationsInventory', { auth: true })
  inventory() {
    return { list: [] };
  }

  /** Decoration themes offered to the player, `{list: [...]}` on screeps.com; none exist here. */
  @ApiOperation('userDecorationsThemes', { auth: true })
  themes() {
    return { list: [] };
  }
}
