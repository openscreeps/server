/*
 * Official-client requests to screeps.com platform services that the pinned standalone backend
 * does not serve: the Steam announcement feed, the Xsolla item-shop promotion banner and the
 * decoration inventory (room decorations, owned items, themes).
 */

import { Controller, Get, Inject, UseGuards, UseInterceptors } from '@nestjs/common';
import { SteamNewsService } from '../services/steam-news.ts';
import { ApiGuard, ApiInterceptor, ApiPolicy } from './transport.ts';

@Controller('api/steam')
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class SteamController {
  constructor(@Inject(SteamNewsService) readonly service: SteamNewsService) {}

  /** The upstream Steam request runs outside the world lock. */
  @Get('news')
  @ApiPolicy({ unlocked: true })
  news() {
    return this.service.news();
  }
}

@Controller('api/xsolla')
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class XsollaController {
  /**
   * screeps.com reports `{ok: 1, discount, dateUntil}` while its Xsolla item shop runs a sale and
   * `{ok: 1}` otherwise. This server sells nothing through Xsolla, so no promotion is ever active;
   * relaying screeps.com's sale would advertise purchases that do not reach this server's inventory.
   */
  @Get('active-promotion')
  @ApiPolicy({ unlocked: true })
  activePromotion() {
    return {};
  }
}

@Controller('api/game')
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class DecorationsController {
  /**
   * screeps.com lists the inventory decorations players have activated in a room as
   * `{decorations: [{user, active, decoration}]}` and `[]` for an undecorated room. This server has
   * no decoration inventory (and `/api/version` advertises no `inventory` feature), so every room
   * is undecorated.
   */
  @Get('room-decorations')
  @ApiPolicy({ unlocked: true })
  roomDecorations() {
    return { decorations: [] };
  }
}

@Controller('api/user/decorations')
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class UserDecorationsController {
  /** The player's decoration items, `{list: [...]}` on screeps.com; nobody owns any here. */
  @Get('inventory')
  @ApiPolicy({ auth: true })
  inventory() {
    return { list: [] };
  }

  /** Decoration themes offered to the player, `{list: [...]}` on screeps.com; none exist here. */
  @Get('themes')
  @ApiPolicy({ auth: true })
  themes() {
    return { list: [] };
  }
}
