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
import type { ApiOperationResult } from '../api/operations.ts';

type OrderView = ApiOperationResult<'marketOrders'>['list'][number];
const REQUIRED_ORDER_NUMBERS = ['amount', 'remainingAmount', 'price'];
const OPTIONAL_ORDER_NUMBERS = ['created', 'createdTimestamp', 'totalAmount'];
const OPTIONAL_ORDER_STRINGS = ['_id', 'roomName'];

/** The game strips private scratch fields and converts prices, but types its view as unknown. */
function assertOrderViews(orders: Array<Record<string, unknown>>): asserts orders is OrderView[] {
  for (const order of orders) {
    if (
      (order['type'] !== 'buy' && order['type'] !== 'sell') ||
      typeof order['resourceType'] !== 'string' ||
      !REQUIRED_ORDER_NUMBERS.every((key) => typeof order[key] === 'number') ||
      !OPTIONAL_ORDER_NUMBERS.every(
        (key) => order[key] === undefined || typeof order[key] === 'number',
      ) ||
      !OPTIONAL_ORDER_STRINGS.every(
        (key) => order[key] === undefined || typeof order[key] === 'string',
      ) ||
      (order['user'] !== undefined &&
        order['user'] !== null &&
        typeof order['user'] !== 'string') ||
      (order['active'] !== undefined && typeof order['active'] !== 'boolean')
    ) {
      throw new Error('Invalid public market order projection');
    }
  }
}

/** HTTP adapter of the game's market views. */
@Injectable()
export class MarketService {
  constructor(@Inject(SERVER_CONTEXT) readonly context: ApiContext) {}

  ordersIndex() {
    return { list: marketOrderIndex(this.context.state.world) };
  }

  orders(request: ApiRequest) {
    requireUser(request, this.context);
    const list = activeMarketOrders(
      this.context.state.world,
      request.query.get('resourceType') ?? undefined,
    );
    assertOrderViews(list);
    return { list };
  }

  myOrders(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const list = userMarketOrders(this.context.state.world, user._id);
    assertOrderViews(list);
    return { list };
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
