import { constants as C } from '@openscreeps/engine';
import { ApiError, newId, requireUser, type ApiRoute, type ServerContext } from '../contracts.ts';
import { saveRoomFlags, userFlags, type FlagEntry } from './game-flags.ts';
import {
  queueGlobalIntents,
  queueManualIntents,
  sanitizeGlobalIntent,
  sanitizeObjectIntent,
  sanitizeRoomIntents,
} from './game-intents.ts';
import {
  checkConstructionController,
  checkConstructionSpot,
  checkSpawnController,
  createInvader,
  INVADER_BODIES,
  placeSpawn,
} from './game-world.ts';
import {
  activateRoom,
  checkGameRoom,
  CONSTRUCTION_COST,
  hasTerrain,
  isFlagColor,
  numberCoordinate,
  ownValue,
  parseCoordinate,
  parseInteger,
  publicUser,
  publicUsers,
  roomController,
  type RoomInfo,
  type RoomObject,
  type World,
} from './gameplay-support.ts';
import { isRoomStatName, roomOverviewStats, roomStatTotals, statWindow } from './room-stats.ts';

const RESPAWN_COOLDOWN = 180000;
const TICK_HISTORY = 30;
const DEFAULT_OVERVIEW_INTERVAL = 8;

/** Upstream `_.pick(room, ['status', 'novice', 'respawnArea', 'openTime'])`. */
function roomStatus(info: RoomInfo): Record<string, unknown> {
  const status: Record<string, unknown> = {};
  for (const key of ['status', 'novice', 'respawnArea', 'openTime'] as const) {
    if (info[key] !== undefined) {
      status[key] = info[key];
    }
  }
  return status;
}

/** Upstream `calcWorldSize` over the room documents (whose maxima start at 0). */
function worldSize(world: World): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = 0;
  let maxY = 0;
  for (const room of Object.keys(world.rooms)) {
    const match = /^([WE])(\d+)([NS])(\d+)$/.exec(room);
    if (!match) {
      continue;
    }
    const [, horizontal, xText = '', vertical, yText = ''] = match;
    const x = horizontal === 'W' ? -Number(xText) - 1 : Number(xText);
    const y = vertical === 'N' ? -Number(yText) - 1 : Number(yText);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return minX === Infinity ? 0 : Math.max(maxX - minX + 1, maxY - minY + 1);
}

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

/**
 * The client's manual safe mode button bypasses the runtime's `Controller.activateSafeMode`
 * checks, so they are repeated here: one room in safe mode per player (counting activations
 * already queued for this tick), and the controller conditions the processor enforces.
 */
function checkManualSafeMode(context: ServerContext, userId: string, controller: RoomObject): void {
  const { world, pendingIntents } = context.state;
  const gameTime = world.gameTime;
  const queuedElsewhere = Object.values(pendingIntents).some((byUser) =>
    Object.entries(byUser[userId] ?? {}).some(
      ([targetId, intents]) => targetId !== controller._id && intents.activateSafeMode,
    ),
  );
  if (
    queuedElsewhere ||
    Object.values(world.roomObjects).some(
      (object) =>
        object.type === 'controller' && object.user === userId && (object.safeMode ?? 0) > gameTime,
    )
  ) {
    throw new ApiError('safe mode active already');
  }
  if (controller.type !== 'controller' || !controller.level) {
    throw new ApiError('invalid object');
  }
  if (!((controller.safeModeAvailable ?? 0) > 0)) {
    throw new ApiError('no safe mode available');
  }
  if (
    (controller.safeModeCooldown ?? 0) >= gameTime ||
    (controller.upgradeBlocked ?? 0) > gameTime
  ) {
    throw new ApiError('safe mode cooldown');
  }
  const downgrade = ownValue<number>(C.CONTROLLER_DOWNGRADE, String(controller.level)) ?? 0;
  if (
    (controller.downgradeTime ?? 0) <
    gameTime + downgrade / 2 - C.CONTROLLER_DOWNGRADE_SAFEMODE_THRESHOLD
  ) {
    throw new ApiError('controller downgrading');
  }
}

export const gameRoutes: readonly ApiRoute[] = [
  {
    method: 'POST',
    path: '/api/game/map-stats',
    auth: true,
    handle(request, context) {
      const { world, statistics } = context.state;
      const rooms = request.body['rooms'];
      const statName = request.body['statName'];
      const match = typeof statName === 'string' ? /^(.*?)(\d+)$/.exec(statName) : null;
      if (!Array.isArray(rooms) || typeof statName !== 'string' || !match) {
        throw new ApiError('invalid params');
      }
      const gameTime = world.gameTime;
      const stats: Record<string, Record<string, unknown>> = {};
      const requested = new Set<string>();
      for (const room of rooms as readonly unknown[]) {
        const info = ownValue(world.rooms, room);
        if (typeof room === 'string' && info) {
          requested.add(room);
          stats[room] = roomStatus(info);
        }
      }
      const userIds = new Set<string>();
      for (const object of Object.values(world.roomObjects)) {
        const entry = requested.has(object.room) ? stats[object.room] : undefined;
        if (!entry) {
          continue;
        }
        if (object.type === 'controller') {
          if (object.user) {
            entry['own'] = { user: object.user, level: object.level };
            userIds.add(object.user);
          }
          if (object.reservation) {
            entry['own'] = { user: object.reservation.user, level: 0 };
            userIds.add(object.reservation.user);
          }
          if (object.sign) {
            entry['sign'] = object.sign;
            userIds.add(object.sign.user);
          }
          if (object.hardSign) {
            entry['hardSign'] = object.hardSign;
          }
          if ((object.safeMode ?? 0) > gameTime) {
            entry['safeMode'] = true;
          }
          if (object.isPowerEnabled) {
            entry['isPowerEnabled'] = true;
          }
        }
        if (object.type === 'invaderCore' && (object.level ?? 0) > 0 && object.user) {
          entry['own'] = { user: object.user, level: object.level };
          userIds.add(object.user);
        }
        if (object.type === 'mineral') {
          entry['minerals0'] = { type: object.mineralType, density: object.density };
        }
      }
      const statsMax: Record<string, number> = {};
      const [, name = '', interval = ''] = match;
      const window = statWindow(Number(interval), context.now());
      if (isRoomStatName(name) && window) {
        let max = 0;
        const totals = roomStatTotals(statistics, name, window, (id) =>
          Object.hasOwn(world.users, id),
        );
        for (const [room, byUser] of totals) {
          const list = [...byUser]
            .map(([user, value]) => ({ user, value }))
            .sort((a, b) => b.value - a.value);
          max = Math.max(max, list[0]?.value ?? 0);
          const entry = requested.has(room) ? stats[room] : undefined;
          if (entry) {
            entry[statName] = list;
            for (const item of list) {
              userIds.add(item.user);
            }
          }
        }
        statsMax[statName] = max;
      }
      return { gameTime, stats, statsMax, users: publicUsers(world, userIds) };
    },
  },
  {
    method: 'GET',
    path: '/api/game/time',
    handle(_request, context) {
      return { time: context.state.world.gameTime };
    },
  },
  {
    method: 'GET',
    path: '/api/game/tick',
    handle(_request, context) {
      const intervals = recentTickIntervals(context);
      return { tick: intervals.length ? Math.min(...intervals) : context.state.tickDuration };
    },
  },
  {
    method: 'GET',
    path: '/api/game/world-size',
    handle(_request, context) {
      const size = worldSize(context.state.world);
      return { width: size, height: size };
    },
  },
  {
    method: 'GET',
    path: '/api/game/room-terrain',
    handle(request, context) {
      const room = request.query.get('room');
      const terrain = ownValue(context.state.world.terrain, room);
      if (room === null || terrain === undefined) {
        throw new ApiError('invalid room');
      }
      // `rooms.terrain` documents: one encoded terrain string per room.
      if (request.query.get('encoded')) {
        return { terrain: [{ _id: room, room, terrain, type: 'terrain' }] };
      }
      const decoded: Array<{ room: string; x: number; y: number; type: string }> = [];
      for (let y = 0; y < 50; y++) {
        for (let x = 0; x < 50; x++) {
          if (hasTerrain(terrain, x, y, C.TERRAIN_MASK_WALL)) {
            decoded.push({ room, x, y, type: 'wall' });
          }
          if (hasTerrain(terrain, x, y, C.TERRAIN_MASK_SWAMP)) {
            decoded.push({ room, x, y, type: 'swamp' });
          }
        }
      }
      return { terrain: decoded };
    },
  },
  {
    method: 'POST',
    path: '/api/game/rooms',
    handle(request, context) {
      const rooms = request.body['rooms'];
      if (!Array.isArray(rooms)) {
        throw new ApiError('invalid params');
      }
      const found = new Map<string, Record<string, string>>();
      for (const room of rooms as readonly unknown[]) {
        const terrain = ownValue(context.state.world.terrain, room);
        if (typeof room === 'string' && terrain !== undefined) {
          found.set(room, { _id: room, room, terrain, type: 'terrain' });
        }
      }
      return { rooms: [...found.values()] };
    },
  },
  {
    method: 'GET',
    path: '/api/game/room-status',
    auth: true,
    handle(request, context) {
      const info = ownValue(context.state.world.rooms, request.query.get('room'));
      return { room: info ? roomStatus(info) : {} };
    },
  },
  {
    method: 'GET',
    path: '/api/game/room-overview',
    auth: true,
    handle(request, context) {
      const { world, statistics } = context.state;
      const room = request.query.get('room');
      if (room === null || !Object.hasOwn(world.rooms, room)) {
        throw new ApiError('invalid room');
      }
      const now = context.now();
      const window =
        statWindow(parseInteger(request.query.get('interval')), now) ??
        statWindow(DEFAULT_OVERVIEW_INTERVAL, now);
      if (!window) {
        throw new ApiError('invalid params');
      }
      const ownerId = roomController(world, room)?.user;
      const owner = ownerId ? publicUser(world, ownerId) : undefined;
      return {
        owner: owner ? { username: owner.username, badge: owner.badge } : null,
        ...roomOverviewStats(statistics, room, window, (id) => Object.hasOwn(world.users, id)),
      };
    },
  },
  {
    method: 'POST',
    path: '/api/game/gen-unique-object-name',
    auth: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const type = request.body['type'];
      if (type !== 'spawn') {
        throw new ApiError('invalid params');
      }
      const objects = Object.values(context.state.world.roomObjects).filter(
        (object) =>
          object.user === user._id && (object.type === type || object.type === 'constructionSite'),
      );
      let counter = 1;
      while (
        objects.some(
          (object) =>
            (object.type === type || object.structureType === type) &&
            object.name === `Spawn${String(counter)}`,
        )
      ) {
        counter++;
      }
      return { name: `Spawn${String(counter)}` };
    },
  },
  {
    method: 'POST',
    path: '/api/game/check-unique-object-name',
    auth: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { type, name } = request.body;
      if (type !== 'spawn' || typeof name !== 'string') {
        throw new ApiError('invalid params');
      }
      const exists = Object.values(context.state.world.roomObjects).some(
        (object) =>
          object.user === user._id &&
          (object.type === type || object.type === 'constructionSite') &&
          object.name === name,
      );
      if (exists) {
        throw new ApiError('name exists');
      }
      return {};
    },
  },
  {
    method: 'POST',
    path: '/api/game/place-spawn',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { state } = context;
      const x = parseCoordinate(request.body['x']);
      const y = parseCoordinate(request.body['y']);
      const name = request.body['name'];
      if (
        x === undefined ||
        y === undefined ||
        typeof name !== 'string' ||
        !name.length ||
        name.length > 50
      ) {
        throw new ApiError('invalid params');
      }
      if (user.blocked) {
        throw new ApiError('blocked');
      }
      if (!user.cpu) {
        throw new ApiError('no cpu');
      }
      const now = context.now();
      if (user.lastRespawnDate && now - user.lastRespawnDate < RESPAWN_COOLDOWN) {
        throw new ApiError('too soon after last respawn');
      }
      const room = checkGameRoom(state.world, request.body['room'], now);
      if (Object.values(state.world.roomObjects).some((object) => object.user === user._id)) {
        throw new ApiError('already playing');
      }
      checkSpawnController(state.world, room, user._id);
      checkConstructionSpot(state.world, room, 'spawn', x, y);
      placeSpawn(state, room, x, y, name, user._id);
      return { newbie: true };
    },
  },
  {
    method: 'POST',
    path: '/api/game/create-construction',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { state } = context;
      const { world } = state;
      const x = parseCoordinate(request.body['x']);
      const y = parseCoordinate(request.body['y']);
      const { structureType, name } = request.body;
      if (
        x === undefined ||
        y === undefined ||
        typeof structureType !== 'string' ||
        !Object.hasOwn(CONSTRUCTION_COST, structureType) ||
        (name && (typeof name !== 'string' || name.length > 50)) ||
        (structureType === 'spawn' && !name)
      ) {
        throw new ApiError('invalid params');
      }
      const room = checkGameRoom(world, request.body['room'], context.now());
      checkConstructionSpot(world, room, structureType, x, y);
      checkConstructionController(world, room, structureType, user._id);
      let progressTotal = CONSTRUCTION_COST[structureType] ?? 0;
      if (structureType === 'road') {
        const terrain = world.terrain[room] ?? '';
        if (hasTerrain(terrain, x, y, C.TERRAIN_MASK_SWAMP)) {
          progressTotal *= C.CONSTRUCTION_COST_ROAD_SWAMP_RATIO;
        }
        if (hasTerrain(terrain, x, y, C.TERRAIN_MASK_WALL)) {
          progressTotal *= C.CONSTRUCTION_COST_ROAD_WALL_RATIO;
        }
      }
      const sites = Object.values(world.roomObjects).filter(
        (object) => object.type === 'constructionSite' && object.user === user._id,
      ).length;
      if (sites >= C.MAX_CONSTRUCTION_SITES) {
        throw new ApiError('too many');
      }
      const site: RoomObject = {
        _id: newId(state),
        type: 'constructionSite',
        room,
        x,
        y,
        structureType,
        user: user._id,
        progress: 0,
        progressTotal,
      };
      if (typeof name === 'string' && name) {
        site.name = name;
      }
      world.roomObjects[site._id] = site;
      activateRoom(world, room);
      return { _id: site._id };
    },
  },
  {
    method: 'POST',
    path: '/api/game/create-flag',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { state } = context;
      const x = numberCoordinate(request.body['x']);
      const y = numberCoordinate(request.body['y']);
      const { name, color, secondaryColor } = request.body;
      if (
        x === undefined ||
        y === undefined ||
        typeof name !== 'string' ||
        !name.length ||
        name.length > 60 ||
        !isFlagColor(color) ||
        !isFlagColor(secondaryColor)
      ) {
        throw new ApiError('invalid params');
      }
      const room = checkGameRoom(state.world, request.body['room'], context.now());
      const flags = userFlags(state.world, user._id);
      const previousRoom = [...flags].find(([, list]) =>
        list.some((flag) => flag[0] === name),
      )?.[0];
      let count = 0;
      for (const [flagRoom, list] of flags) {
        const kept = flagRoom === previousRoom ? list.filter((flag) => flag[0] !== name) : list;
        flags.set(flagRoom, kept);
        count += kept.length;
      }
      if (count >= C.FLAGS_LIMIT) {
        throw new ApiError('flags limit exceeded');
      }
      if (previousRoom !== undefined && previousRoom !== room) {
        saveRoomFlags(state, user._id, previousRoom, flags.get(previousRoom) ?? []);
      }
      const flag: FlagEntry = [name, String(color), String(secondaryColor), String(x), String(y)];
      saveRoomFlags(state, user._id, room, [...(flags.get(room) ?? []), flag]);
      return {};
    },
  },
  {
    method: 'POST',
    path: '/api/game/gen-unique-flag-name',
    auth: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const names = new Set(
        [...userFlags(context.state.world, user._id).values()].flat().map((flag) => flag[0]),
      );
      let counter = 1;
      while (names.has(`Flag${String(counter)}`)) {
        counter++;
      }
      return { name: `Flag${String(counter)}` };
    },
  },
  {
    method: 'POST',
    path: '/api/game/check-unique-flag-name',
    auth: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const name = request.body['name'];
      for (const list of userFlags(context.state.world, user._id).values()) {
        if (list.some((flag) => flag[0] === name)) {
          throw new ApiError('name exists');
        }
      }
      return {};
    },
  },
  {
    method: 'POST',
    path: '/api/game/change-flag-color',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { room, name, color, secondaryColor } = request.body;
      if (!isFlagColor(color) || !isFlagColor(secondaryColor) || typeof room !== 'string') {
        throw new ApiError('invalid params');
      }
      const flags = userFlags(context.state.world, user._id).get(room) ?? [];
      const flag = flags.find((item) => item[0] === name);
      if (flag) {
        flag[1] = String(color);
        flag[2] = String(secondaryColor);
        saveRoomFlags(context.state, user._id, room, flags);
      }
      return {};
    },
  },
  {
    method: 'POST',
    path: '/api/game/remove-flag',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { room, name } = request.body;
      if (typeof room !== 'string') {
        throw new ApiError('invalid params');
      }
      const flags = userFlags(context.state.world, user._id).get(room) ?? [];
      const kept = flags.filter((flag) => flag[0] !== name);
      if (kept.length !== flags.length) {
        saveRoomFlags(context.state, user._id, room, kept);
      }
      return {};
    },
  },
  {
    method: 'POST',
    path: '/api/game/add-object-intent',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { state } = context;
      const { world } = state;
      const room = checkGameRoom(world, request.body['room'], context.now());
      const { _id: targetId, name, intent } = request.body;
      if (typeof name !== 'string' || typeof targetId !== 'string') {
        throw new ApiError('invalid params');
      }
      if (targetId === 'room') {
        queueManualIntents(state, room, user._id, 'room', {
          [name]: sanitizeRoomIntents(room, name, intent),
        });
      } else {
        const object = ownValue(world.roomObjects, targetId);
        if (!object || object.room !== room) {
          throw new ApiError('invalid object');
        }
        const owner = object.user ?? roomController(world, room)?.user;
        if (owner !== user._id) {
          throw new ApiError('not owner');
        }
        const sanitized = sanitizeObjectIntent(room, object._id, name, intent);
        if (name === 'activateSafeMode') {
          checkManualSafeMode(context, user._id, object);
        }
        queueManualIntents(state, room, user._id, object._id, sanitized);
      }
      activateRoom(world, room);
      return {};
    },
  },
  {
    method: 'POST',
    path: '/api/game/add-global-intent',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const name = request.body['name'];
      if (typeof name !== 'string') {
        throw new ApiError('invalid params');
      }
      const intents = sanitizeGlobalIntent(name, request.body['intent']);
      queueGlobalIntents(context.state, user._id, name, intents);
      return {};
    },
  },
  {
    method: 'POST',
    path: '/api/game/set-notify-when-attacked',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { world } = context.state;
      const object = ownValue(world.roomObjects, request.body['_id']);
      if (
        !object ||
        !(
          Object.hasOwn(CONSTRUCTION_COST, object.type) ||
          object.type === 'creep' ||
          object.type === 'powerCreep'
        )
      ) {
        throw new ApiError('invalid object');
      }
      if (object.user) {
        if (object.user !== user._id) {
          throw new ApiError('not owner');
        }
      } else if (roomController(world, object.room)?.user !== user._id) {
        throw new ApiError('not controller owner');
      }
      object.notifyWhenAttacked = !!request.body['enabled'];
      return {};
    },
  },
  {
    method: 'POST',
    path: '/api/game/create-invader',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { state } = context;
      const room = checkGameRoom(state.world, request.body['room'], context.now());
      const x = parseCoordinate(request.body['x']);
      const y = parseCoordinate(request.body['y']);
      const { size, type } = request.body;
      const body =
        typeof size === 'string' && typeof type === 'string'
          ? ownValue(INVADER_BODIES, size + type)
          : undefined;
      if (x === undefined || y === undefined || !body) {
        throw new ApiError('invalid params');
      }
      const creep = createInvader(state, room, user._id, {
        x,
        y,
        body,
        boosted: !!request.body['boosted'],
      });
      return { ...creep };
    },
  },
  {
    method: 'POST',
    path: '/api/game/remove-invader',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { world } = context.state;
      const object = ownValue(world.roomObjects, request.body['_id']);
      if (!object || object.type !== 'creep' || object.userSummoned !== user._id) {
        throw new ApiError('invalid object');
      }
      Reflect.deleteProperty(world.roomObjects, object._id);
      activateRoom(world, object.room);
      return {};
    },
  },
];
