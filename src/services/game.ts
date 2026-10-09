import { Inject, Injectable } from '@nestjs/common';
import {
  addGlobalIntent,
  addObjectIntent,
  changeFlagColor,
  checkUniqueFlagName,
  checkUniqueObjectName,
  createConstructionSite,
  createFlag,
  createInvader,
  mapStats,
  ownValue,
  placeSpawn,
  removeFlag,
  removeInvader,
  roomOverview,
  roomStatus,
  roomTerrain,
  setNotifyWhenAttacked,
  terrainTiles,
  uniqueFlagName,
  uniqueObjectName,
  worldSize,
  type RoomObject,
} from '@openscreeps/game';
import {
  ApiError,
  requireUser,
  type ApiContext,
  type ApiRequest,
  type ServerContext,
} from '../contracts.ts';
import {
  numberParam,
  parseInteger,
  publicUser,
  publicUsers,
  stringParam,
} from '../api/gameplay-support.ts';
import { SERVER_CONTEXT } from '../api/transport.ts';

const TICK_HISTORY = 30;

/** Last tick intervals per server, newest first (upstream keeps 30 `roomsDone` gaps in memory). */
const tickIntervals = new WeakMap<ServerContext['events'], number[]>();

function recentTickIntervals(context: ServerContext): readonly number[] {
  let intervals = tickIntervals.get(context.events);
  if (!intervals) {
    const list: number[] = [];
    let last: number | undefined;
    context.events.on('tick', ({ timestamp }) => {
      if (last !== undefined) {
        list.unshift(timestamp - last);
        list.splice(TICK_HISTORY);
      }
      last = timestamp;
    });
    tickIntervals.set(context.events, list);
    intervals = list;
  }
  return intervals;
}

/** HTTP adapter of the game's world operations: body/query decoding and wire envelopes only. */
@Injectable()
export class GameService {
  constructor(@Inject(SERVER_CONTEXT) readonly context: ApiContext) {}

  mapStats(request: ApiRequest) {
    const { world } = this.context.state;
    const { rooms, statName } = request.body;
    if (!Array.isArray(rooms) || typeof statName !== 'string') {
      throw new ApiError('invalid params');
    }
    const { userIds, ...stats } = mapStats(this.context.state, this.context.now(), {
      statName,
      rooms: (rooms as readonly unknown[]).filter(
        (room): room is string => typeof room === 'string',
      ),
    });
    return { ...stats, users: publicUsers(world, userIds) };
  }

  time() {
    return { time: this.context.state.world.gameTime };
  }

  tick() {
    const intervals = recentTickIntervals(this.context);
    return { tick: intervals.length ? Math.min(...intervals) : this.context.state.tickDuration };
  }

  worldSize() {
    const size = worldSize(this.context.state.world);
    return { width: size, height: size };
  }

  roomTerrain(request: ApiRequest) {
    const room = request.query.get('room');
    if (room === null) {
      throw new ApiError('invalid room');
    }
    const terrain = roomTerrain(this.context.state.world, room);
    // `rooms.terrain` documents: one encoded terrain string per room.
    if (request.query.get('encoded')) {
      return { terrain: [{ _id: room, room, terrain, type: 'terrain' }] };
    }
    return { terrain: terrainTiles(room, terrain) };
  }

  rooms(request: ApiRequest) {
    const rooms = request.body['rooms'];
    if (!Array.isArray(rooms)) {
      throw new ApiError('invalid params');
    }
    const found = new Map<string, Record<string, string>>();
    for (const room of rooms as readonly unknown[]) {
      const terrain = ownValue(this.context.state.world.terrain, room);
      if (typeof room === 'string' && terrain !== undefined) {
        found.set(room, { _id: room, room, terrain, type: 'terrain' });
      }
    }
    return { rooms: [...found.values()] };
  }

  roomStatus(request: ApiRequest) {
    return {
      room: roomStatus(this.context.state.world, request.query.get('room') ?? undefined),
    };
  }

  roomOverview(request: ApiRequest) {
    const { world } = this.context.state;
    const { ownerId, ...stats } = roomOverview(this.context.state, this.context.now(), {
      room: request.query.get('room') ?? undefined,
      interval: parseInteger(request.query.get('interval')),
    });
    const owner = ownerId ? publicUser(world, ownerId) : undefined;
    return {
      owner: owner ? { username: owner.username, badge: owner.badge } : null,
      ...stats,
    };
  }

  genUniqueObjectName(request: ApiRequest) {
    const user = requireUser(request, this.context);
    return {
      name: uniqueObjectName(this.context.state.world, user._id, stringParam(request.body['type'])),
    };
  }

  checkUniqueObjectName(request: ApiRequest) {
    const user = requireUser(request, this.context);
    checkUniqueObjectName(this.context.state.world, user._id, {
      type: stringParam(request.body['type']),
      name: stringParam(request.body['name']),
    });
    return {};
  }

  placeSpawn(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const { body } = request;
    placeSpawn(this.context, user._id, {
      room: stringParam(body['room']),
      x: parseInteger(body['x']),
      y: parseInteger(body['y']),
      name: stringParam(body['name']),
    });
    return { newbie: true };
  }

  createConstruction(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const { body } = request;
    const name = body['name'];
    if (name && typeof name !== 'string') {
      throw new ApiError('invalid params');
    }
    const site = createConstructionSite(this.context, user._id, {
      room: stringParam(body['room']),
      x: parseInteger(body['x']),
      y: parseInteger(body['y']),
      structureType: stringParam(body['structureType']),
      name: typeof name === 'string' && name ? name : undefined,
    });
    return { _id: site._id };
  }

  createFlag(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const { body } = request;
    createFlag(this.context, user._id, {
      room: stringParam(body['room']),
      x: numberParam(body['x']),
      y: numberParam(body['y']),
      name: stringParam(body['name']),
      color: numberParam(body['color']),
      secondaryColor: numberParam(body['secondaryColor']),
    });
    return {};
  }

  genUniqueFlagName(request: ApiRequest) {
    const user = requireUser(request, this.context);
    return { name: uniqueFlagName(this.context.state.world, user._id) };
  }

  checkUniqueFlagName(request: ApiRequest) {
    const user = requireUser(request, this.context);
    checkUniqueFlagName(this.context.state.world, user._id, stringParam(request.body['name']));
    return {};
  }

  changeFlagColor(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const { body } = request;
    changeFlagColor(this.context.state, user._id, {
      room: stringParam(body['room']),
      name: stringParam(body['name']),
      color: numberParam(body['color']),
      secondaryColor: numberParam(body['secondaryColor']),
    });
    return {};
  }

  removeFlag(request: ApiRequest) {
    const user = requireUser(request, this.context);
    removeFlag(this.context.state, user._id, {
      room: stringParam(request.body['room']),
      name: stringParam(request.body['name']),
    });
    return {};
  }

  addObjectIntent(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const { body } = request;
    addObjectIntent(this.context, user._id, {
      room: stringParam(body['room']),
      targetId: stringParam(body['_id']),
      name: stringParam(body['name']),
      intent: body['intent'],
    });
    return {};
  }

  addGlobalIntent(request: ApiRequest) {
    const user = requireUser(request, this.context);
    addGlobalIntent(this.context.state, user._id, {
      name: stringParam(request.body['name']),
      intent: request.body['intent'],
    });
    return {};
  }

  setNotifyWhenAttacked(request: ApiRequest) {
    const user = requireUser(request, this.context);
    setNotifyWhenAttacked(this.context.state, user._id, {
      id: stringParam(request.body['_id']),
      enabled: !!request.body['enabled'],
    });
    return {};
  }

  createInvader(request: ApiRequest): RoomObject {
    const user = requireUser(request, this.context);
    const { body } = request;
    const creep = createInvader(this.context, user._id, {
      room: stringParam(body['room']),
      x: parseInteger(body['x']),
      y: parseInteger(body['y']),
      size: stringParam(body['size']),
      type: stringParam(body['type']),
      boosted: !!body['boosted'],
    });
    return { ...creep };
  }

  removeInvader(request: ApiRequest) {
    const user = requireUser(request, this.context);
    removeInvader(this.context.state, user._id, stringParam(request.body['_id']));
    return {};
  }
}
