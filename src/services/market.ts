import { Inject, Injectable } from '@nestjs/common';
import {
  activeMarketOrders,
  marketHistory,
  marketOrderIndex,
  userMarketOrders,
  type MarketStats,
} from '@openscreeps/game';
import { requireUser, type ApiContext, type ApiRequest } from '../contracts.ts';
import { SERVER_CONTEXT } from '../api/transport.ts';

/** HTTP adapter of the game's market views. */
@Injectable()
export class MarketService {
  constructor(@Inject(SERVER_CONTEXT) readonly context: ApiContext) {}

  ordersIndex() {
    return { list: marketOrderIndex(this.context.state.world) };
  }

  orders(request: ApiRequest) {
    requireUser(request, this.context);
    return {
      list: activeMarketOrders(
        this.context.state.world,
        request.query.get('resourceType') ?? undefined,
      ),
    };
  }

  myOrders(request: ApiRequest) {
    const user = requireUser(request, this.context);
    return { list: userMarketOrders(this.context.state.world, user._id) };
  }

  stats(request: ApiRequest): { stats: MarketStats[] } {
    return {
      stats: marketHistory(
        this.context.state.world,
        request.query.get('resourceType') ?? undefined,
      ),
    };
  }
}
