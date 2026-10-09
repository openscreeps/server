import { requireUser, type ApiRoute } from '../contracts.ts';
import type { World } from './gameplay-support.ts';

type MarketOrder = World['marketOrders'][string];

/**
 * Client view of a stored order: price converted from the stored thousandths of a credit, processing
 * scratch fields (`_skip`, `_cancelled`) dropped, and the owner hidden on other players' orders.
 */
function orderView(order: MarketOrder, viewerId: string): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(order)) {
    if (key === '_id' || !key.startsWith('_')) {
      view[key] = value;
    }
  }
  view['price'] = order.price / 1000;
  if (order.user !== viewerId) {
    delete view['user'];
  }
  return view;
}

export const marketRoutes: readonly ApiRoute[] = [
  {
    method: 'GET',
    path: '/api/game/market/orders-index',
    auth: true,
    handle(_request, context) {
      type IndexEntry = { _id: string; count: number; buying: number; selling: number };
      const list = new Map<string, IndexEntry>();
      for (const order of Object.values(context.state.world.marketOrders)) {
        const { active, resourceType, type } = order;
        if (!active) {
          continue;
        }
        let entry = list.get(resourceType);
        if (!entry) {
          entry = { _id: resourceType, count: 0, buying: 0, selling: 0 };
          list.set(resourceType, entry);
        }
        if (type === 'buy') {
          entry.buying++;
        }
        if (type === 'sell') {
          entry.selling++;
        }
        entry.count++;
      }
      return { list: [...list.values()] };
    },
  },
  {
    method: 'GET',
    path: '/api/game/market/orders',
    auth: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const resourceType = request.query.get('resourceType');
      return {
        list: Object.values(context.state.world.marketOrders)
          .filter((order) => order.active && order.resourceType === resourceType)
          .map((order) => orderView(order, user._id)),
      };
    },
  },
  {
    method: 'GET',
    path: '/api/game/market/my-orders',
    auth: true,
    handle(request, context) {
      const user = requireUser(request, context);
      return {
        list: Object.values(context.state.world.marketOrders)
          .filter((order) => order.user === user._id)
          .map((order) => orderView(order, user._id)),
      };
    },
  },
  {
    method: 'GET',
    path: '/api/game/market/stats',
    auth: true,
    handle(request, context) {
      const resourceType = request.query.get('resourceType');
      return {
        stats: Object.values(context.state.world.marketStats)
          .filter((stats) => stats.resourceType === resourceType)
          .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
      };
    },
  },
];
