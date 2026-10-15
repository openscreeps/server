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
import { isRecord } from '../api/guards.ts';
import {
  numberParam,
  parseInteger,
  publicUser,
  publicUsers,
  stringParam,
} from '../api/gameplay-support.ts';
import type { ApiOperationResult } from '../api/operations.ts';
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

/** `rooms.terrain` document: one encoded terrain string per room. */
interface RoomTerrainDocument {
  _id: string;
  room: string;
  terrain: string;
  type: 'terrain';
}

/** One player's total of the requested map stat. */
interface MapStatEntry {
  user: string;
  value: number;
}

/** Controller owner (`level` = RCL), reserver (`level: 0`), or a leveled invader core. */
interface MapStatsOwner {
  user?: string;
  level: number;
}

interface MapStatsSign {
  user: string;
  text: string;
  time: number;
  datetime: number;
}

interface MapStatsMineral {
  type?: string;
  density?: number;
}

/**
 * Map stats of one room: the named status/ownership fields plus the requested stat ranking under
 * its `statName` key. Stat names end in an interval (`energyHarvested8`), so the ranking key never
 * collides with a named field (`minerals0` does not name a room stat).
 */
interface MapStatsRoom {
  [statName: string]:
    | string
    | number
    | true
    | null
    | MapStatsOwner
    | MapStatsSign
    | MapStatsMineral
    | readonly MapStatEntry[]
    | undefined;
  status?: string;
  novice?: number | null;
  respawnArea?: number | null;
  openTime?: number | null;
  own?: MapStatsOwner;
  sign?: MapStatsSign;
  safeMode?: true;
  minerals0?: MapStatsMineral;
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

function isMapStatEntry(value: unknown): value is MapStatEntry {
  return isRecord(value) && typeof value.user === 'string' && typeof value.value === 'number';
}

/**
 * Narrows one room entry of the game's `mapStats` (typed as loose records by the game package) to
 * the fields it writes: the room document's status fields, controller/core ownership, sign, safe
 * mode, mineral and the `statName` ranking. Values of any other shape are omitted.
 */
function mapStatsRoom(entry: Readonly<Record<string, unknown>>, statName: string): MapStatsRoom {
  const { status, novice, respawnArea, openTime, own, sign, safeMode, minerals0 } = entry;
  const room: MapStatsRoom = {};
  if (typeof status === 'string') room.status = status;
  if (isNullableNumber(novice)) room.novice = novice;
  if (isNullableNumber(respawnArea)) room.respawnArea = respawnArea;
  if (isNullableNumber(openTime)) room.openTime = openTime;
  if (isRecord(own) && typeof own.level === 'number') {
    room.own =
      typeof own.user === 'string' ? { user: own.user, level: own.level } : { level: own.level };
  }
  if (
    isRecord(sign) &&
    typeof sign.user === 'string' &&
    typeof sign.text === 'string' &&
    typeof sign.time === 'number' &&
    typeof sign.datetime === 'number'
  ) {
    room.sign = { user: sign.user, text: sign.text, time: sign.time, datetime: sign.datetime };
  }
  if (safeMode === true) room.safeMode = true;
  if (isRecord(minerals0)) {
    const mineral: MapStatsMineral = {};
    if (typeof minerals0.type === 'string') mineral.type = minerals0.type;
    if (typeof minerals0.density === 'number') mineral.density = minerals0.density;
    room.minerals0 = mineral;
  }
  const ranking = entry[statName];
  if (Array.isArray(ranking)) {
    room[statName] = (ranking as readonly unknown[]).filter(isMapStatEntry);
  }
  return room;
}

type InvaderCreep = ApiOperationResult<'gameCreateInvader'>;
type InvaderBodyPart = NonNullable<InvaderCreep['body']>[number];
type BodyPart = NonNullable<RoomObject['body']>[number];
type WireRoomObject = ApiOperationResult<'gameRoomObjects'>['objects'][number];

/** NPC Invader user id and lifetime of a summoned invader. */
const INVADER_USER = '2';
const INVADER_TICKS_TO_LIVE = 1500;

/** Creep body part types of the contract (`BODYPARTS_ALL`). */
const BODY_PART_TYPES: Readonly<Record<InvaderBodyPart['type'], true>> = {
  move: true,
  work: true,
  carry: true,
  attack: true,
  ranged_attack: true,
  tough: true,
  heal: true,
  claim: true,
};

function isBodyPartType(type: string): type is InvaderBodyPart['type'] {
  return Object.hasOwn(BODY_PART_TYPES, type);
}

function invaderBodyPart({ type, hits, boost }: BodyPart): InvaderBodyPart {
  if (!isBodyPartType(type)) {
    throw new Error(`createInvader produced unknown body part ${type}`);
  }
  return boost === undefined ? { type, hits } : { type, hits, boost };
}

/** The creep document `createInvader` inserted, asserted to be a summoned NPC invader creep. */
function invaderCreep(creep: RoomObject): InvaderCreep {
  const { _id, type, room, x, y, user, name, body, hits, hitsMax, fatigue, store, ticksToLive } =
    creep;
  if (
    type !== 'creep' ||
    user !== INVADER_USER ||
    ticksToLive !== INVADER_TICKS_TO_LIVE ||
    body === undefined ||
    name === undefined ||
    hits === undefined ||
    hitsMax === undefined ||
    fatigue === undefined ||
    store === undefined
  ) {
    throw new Error(`createInvader produced a non-invader object ${_id}`);
  }
  return {
    _id,
    type,
    user,
    body: body.map(invaderBodyPart),
    hits,
    hitsMax,
    ticksToLive,
    x,
    y,
    room,
    fatigue,
    store,
    storeCapacity: creep.storeCapacity ?? undefined,
    name,
    userSummoned: creep.userSummoned,
  };
}

/** HTTP adapter of the game's world operations: body/query decoding and wire envelopes only. */
@Injectable()
export class GameService {
  constructor(@Inject(SERVER_CONTEXT) readonly context: ApiContext) {}

  mapStats(request: ApiRequest): ApiOperationResult<'gameMapStats'> {
    const { world } = this.context.state;
    const { rooms, statName } = request.body;
    if (!Array.isArray(rooms) || typeof statName !== 'string') {
      throw new ApiError('invalid params');
    }
    const { gameTime, stats, statsMax, userIds } = mapStats(
      this.context.state,
      this.context.now(),
      {
        statName,
        rooms: (rooms as readonly unknown[]).filter(
          (room): room is string => typeof room === 'string',
        ),
      },
    );
    const roomStats: Record<string, MapStatsRoom> = {};
    for (const [room, entry] of Object.entries(stats)) {
      roomStats[room] = mapStatsRoom(entry, statName);
    }
    return { gameTime, stats: roomStats, statsMax, users: publicUsers(world, userIds) };
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

  roomTerrain(request: ApiRequest): ApiOperationResult<'gameRoomTerrain'> {
    const room = request.query.get('room');
    if (room === null) {
      throw new ApiError('invalid room');
    }
    const terrain = roomTerrain(this.context.state.world, room);
    if (request.query.get('encoded')) {
      const encoded: RoomTerrainDocument = { _id: room, room, terrain, type: 'terrain' };
      return { terrain: [encoded] };
    }
    return { terrain: terrainTiles(room, terrain) };
  }

  rooms(request: ApiRequest): ApiOperationResult<'gameRooms'> {
    const rooms = request.body['rooms'];
    if (!Array.isArray(rooms)) {
      throw new ApiError('invalid params');
    }
    const found = new Map<string, RoomTerrainDocument>();
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

  /**
   * screeps.com `GET /api/game/room-objects`: every object document of the room (flags are
   * separate documents and not included) plus the public profiles of their owners. Objects are
   * copied because the response is serialized after the world lock is released.
   */
  roomObjects(request: ApiRequest): ApiOperationResult<'gameRoomObjects'> {
    const room = request.query.get('room');
    if (!room) {
      throw new ApiError('invalid room');
    }
    const { world } = this.context.state;
    const objects: RoomObject[] = [];
    const owners = new Set<string>();
    for (const object of Object.values(world.roomObjects)) {
      if (object.room !== room) continue;
      objects.push(structuredClone(object));
      if (typeof object.user === 'string') owners.add(object.user);
    }
    // World documents carry an open `type: string`; the contract's `GameRoomObject` union keys
    // undescribed types by a generated placeholder, so the wire shape is asserted here and
    // validated against the union by the HTTP conformance test.
    return {
      objects: objects as unknown as WireRoomObject[],
      users: structuredClone(publicUsers(world, owners)),
    };
  }

  /** screeps.com `GET /api/game/find-object`: one room object document by id, any room. */
  findObject(request: ApiRequest): ApiOperationResult<'gameFindObject'> {
    const id = request.query.get('_id');
    if (!id) {
      throw new ApiError('invalid params');
    }
    const object = ownValue(this.context.state.world.roomObjects, id);
    if (!object) {
      throw new ApiError('object not found');
    }
    return { object: structuredClone(object) };
  }

  /**
   * screeps.com `GET /api/game/random-novice-room`: a random normal room of an active novice
   * area (`novice` end time still ahead) on this server's single shard. Without a novice area
   * the body has no `room`, which the official world map treats as nothing to show.
   */
  randomNoviceRoom() {
    const now = this.context.now();
    const { rooms } = this.context.state.world;
    const novice = Object.keys(rooms)
      .filter((name) => {
        const room = rooms[name];
        return room?.status === 'normal' && typeof room.novice === 'number' && room.novice > now;
      })
      .sort();
    const room = novice[Math.floor(Math.random() * novice.length)];
    return room === undefined ? {} : { room, shard: this.context.state.world.shardName };
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
    return { newbie: true as const };
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
    addObjectIntent(
      this.context,
      user._id,
      {
        room: stringParam(body['room']),
        targetId: stringParam(body['_id']),
        name: stringParam(body['name']),
        intent: body['intent'],
      },
      this.context.mods?.backend.customIntentTypes,
    );
    return {};
  }

  addGlobalIntent(request: ApiRequest) {
    const user = requireUser(request, this.context);
    addGlobalIntent(
      this.context.state,
      user._id,
      {
        name: stringParam(request.body['name']),
        intent: request.body['intent'],
      },
      this.context.mods?.backend.customIntentTypes,
    );
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

  createInvader(request: ApiRequest): InvaderCreep {
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
    return invaderCreep(creep);
  }

  removeInvader(request: ApiRequest) {
    const user = requireUser(request, this.context);
    removeInvader(this.context.state, user._id, stringParam(request.body['_id']));
    return {};
  }
}
