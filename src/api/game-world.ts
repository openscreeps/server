import { constants as C } from '@openscreeps/engine';
import { ApiError, newId, type ServerState } from '../contracts.ts';
import {
  activateRoom,
  CONSTRUCTION_COST,
  CONTROLLER_STRUCTURES,
  hasTerrain,
  ownValue,
  roomController,
  roomObjects,
  type RoomObject,
  type World,
} from './gameplay-support.ts';

/** Structures upstream `checkConstructionSpot` refuses to share a tile with (except ramparts). */
const SPOT_BLOCKERS: Readonly<Record<string, true>> = {
  wall: true,
  constructedWall: true,
  spawn: true,
  extension: true,
  link: true,
  storage: true,
  tower: true,
  observer: true,
  powerSpawn: true,
};

/** Upstream create-invader bodies by `size + type`. */
export const INVADER_BODIES: Readonly<Record<string, readonly string[]>> = {
  bigHealer: [...Array<string>(24).fill('move'), ...Array<string>(25).fill('heal'), 'move'],
  bigRanged: [
    ...Array<string>(6).fill('tough'),
    ...Array<string>(24).fill('move'),
    ...Array<string>(18).fill('ranged_attack'),
    'work',
    'move',
  ],
  bigMelee: [
    ...Array<string>(16).fill('tough'),
    ...Array<string>(24).fill('move'),
    ...Array<string>(3).fill('ranged_attack'),
    ...Array<string>(4).fill('work'),
    'attack',
    'attack',
    'move',
  ],
  smallHealer: [...Array<string>(4).fill('move'), ...Array<string>(5).fill('heal'), 'move'],
  smallRanged: [
    'tough',
    'tough',
    'move',
    'move',
    'move',
    'move',
    'ranged_attack',
    'ranged_attack',
    'ranged_attack',
    'move',
  ],
  smallMelee: [
    'tough',
    'tough',
    'move',
    'move',
    'move',
    'move',
    'ranged_attack',
    'work',
    'attack',
    'move',
  ],
};

/** Boosts of boosted invaders by body part. */
const INVADER_BOOSTS: Readonly<Record<string, string>> = {
  heal: 'LO',
  ranged_attack: 'KO',
  work: 'ZH',
  attack: 'UH',
};

const INVADER_USER = '2';
const INVADER_LIMIT = 5;
const PLACE_SPAWN_SAFE_MODE = 20000;
const PLACE_SPAWN_RUIN_DECAY = 100000;
const PLACE_SPAWN_INVADER_GOAL = 1000000;
const PLACE_SPAWN_ACTIVE = 10000;

/**
 * Upstream `checkConstructionSpot`, combined with the engine's `checkConstructionSite` so that a
 * site the backend inserts directly is one the processor could also have created.
 */
export function checkConstructionSpot(
  world: World,
  room: string,
  structureType: string,
  x: number,
  y: number,
): void {
  if (x <= 0 || y <= 0 || x >= 49 || y >= 49) {
    throw new ApiError('invalid location');
  }
  const objects = roomObjects(world, room);
  const here = objects.filter((object) => object.x === x && object.y === y);
  if (structureType === 'extractor') {
    if (
      !here.some((object) => object.type === 'mineral') ||
      here.some((object) => object.type === 'extractor' || object.type === 'constructionSite')
    ) {
      throw new ApiError('invalid location');
    }
    return;
  }
  const terrain = world.terrain[room] ?? '';
  const blocked =
    here.some((object) => object.type === structureType || object.type === 'constructionSite') ||
    (structureType !== 'rampart' &&
      here.some(
        (object) =>
          Object.hasOwn(SPOT_BLOCKERS, object.type) ||
          (structureType !== 'road' &&
            object.type !== 'rampart' &&
            object.type !== 'road' &&
            Object.hasOwn(CONSTRUCTION_COST, object.type)),
      )) ||
    (structureType !== 'road' && hasTerrain(terrain, x, y, C.TERRAIN_MASK_WALL)) ||
    objects.some(
      (object) =>
        object.type === 'exit' && Math.abs(object.x - x) < 2 && Math.abs(object.y - y) < 2,
    );
  if (blocked) {
    throw new ApiError('invalid location');
  }
  if (structureType !== 'road' && structureType !== 'container') {
    let borderTiles: Array<[number, number]> = [];
    if (x === 1) {
      borderTiles = [
        [0, y - 1],
        [0, y],
        [0, y + 1],
      ];
    }
    if (x === 48) {
      borderTiles = [
        [49, y - 1],
        [49, y],
        [49, y + 1],
      ];
    }
    if (y === 1) {
      borderTiles = [
        [x - 1, 0],
        [x, 0],
        [x + 1, 0],
      ];
    }
    if (y === 48) {
      borderTiles = [
        [x - 1, 49],
        [x, 49],
        [x + 1, 49],
      ];
    }
    if (borderTiles.some(([bx, by]) => !hasTerrain(terrain, bx, by, C.TERRAIN_MASK_WALL))) {
      throw new ApiError('invalid location');
    }
  }
}

/** Upstream `checkController(room, 'construct')`: owner/reservation and the RCL structure limit. */
export function checkConstructionController(
  world: World,
  room: string,
  structureType: string,
  userId: string,
): void {
  const controller = roomController(world, room);
  if (
    controller &&
    ((controller.user && controller.user !== userId) ||
      (controller.reservation && controller.reservation.user !== userId))
  ) {
    throw new ApiError('not a controller owner');
  }
  const rcl = controller?.level && controller.user ? controller.level : 0;
  const count = roomObjects(world, room).filter(
    (object) =>
      object.type === structureType ||
      (object.type === 'constructionSite' && object.structureType === structureType),
  ).length;
  const available = ownValue(CONTROLLER_STRUCTURES, structureType)?.[rcl];
  if (available === undefined || count >= available) {
    throw new ApiError('RCL not enough');
  }
}

/** Upstream `checkController(room, 'spawn')`: a free, unreserved controller not bound to others. */
export function checkSpawnController(world: World, room: string, userId: string): void {
  const controller = roomController(world, room);
  if (!controller) {
    throw new ApiError('invalid room');
  }
  if (
    controller.user ||
    controller.reservation ||
    (controller.bindUser && controller.bindUser !== userId)
  ) {
    throw new ApiError('room busy');
  }
}

/**
 * Upstream `/place-spawn` world setup: other players' creeps and construction sites in the room are
 * removed, their structures become ruins, the controller is claimed at level 1 with safe mode, the
 * sources reset their invader counters and the first spawn is inserted.
 */
export function placeSpawn(
  state: ServerState,
  room: string,
  x: number,
  y: number,
  name: string,
  userId: string,
): RoomObject {
  const { world } = state;
  const gameTime = world.gameTime;
  for (const object of roomObjects(world, room)) {
    if (!object.user) {
      continue;
    }
    if (object.type === 'creep' || object.type === 'constructionSite') {
      Reflect.deleteProperty(world.roomObjects, object._id);
      continue;
    }
    if (Object.hasOwn(CONSTRUCTION_COST, object.type)) {
      const ruinId = newId(state);
      world.roomObjects[ruinId] = {
        _id: ruinId,
        type: 'ruin',
        user: object.user,
        room,
        x: object.x,
        y: object.y,
        structure: {
          id: object._id,
          type: object.type,
          hits: 0,
          hitsMax: object.hitsMax,
          user: object.user,
        },
        store: { ...object.store },
        destroyTime: gameTime,
        decayTime: gameTime + PLACE_SPAWN_RUIN_DECAY,
      };
      Reflect.deleteProperty(world.roomObjects, object._id);
    }
  }
  for (const object of roomObjects(world, room)) {
    if (object.type === 'controller' && !object.level) {
      Object.assign(object, {
        user: userId,
        level: 1,
        progress: 0,
        downgradeTime: null,
        safeMode: gameTime + PLACE_SPAWN_SAFE_MODE,
      });
    }
    if (object.type === 'source') {
      object.invaderHarvested = 0;
    }
  }
  const spawn: RoomObject = {
    _id: newId(state),
    type: 'spawn',
    room,
    x,
    y,
    name,
    user: userId,
    store: { energy: C.SPAWN_ENERGY_START },
    storeCapacityResource: { energy: C.SPAWN_ENERGY_CAPACITY },
    hits: C.SPAWN_HITS,
    hitsMax: C.SPAWN_HITS,
    spawning: null,
    notifyWhenAttacked: true,
  };
  world.roomObjects[spawn._id] = spawn;
  const info = world.rooms[room];
  if (info) {
    info.invaderGoal = PLACE_SPAWN_INVADER_GOAL;
  }
  activateRoom(world, room);
  const user = world.users[userId];
  if (user) {
    user.active = PLACE_SPAWN_ACTIVE;
  }
  return spawn;
}

/**
 * Upstream `/create-invader`: summons an NPC invader into a room the caller owns or reserves, at most
 * five at a time and only while no other player's creeps are present.
 */
export function createInvader(
  state: ServerState,
  room: string,
  userId: string,
  options: { x: number; y: number; body: readonly string[]; boosted: boolean },
): RoomObject {
  const { world } = state;
  const creeps = roomObjects(world, room).filter((object) => object.type === 'creep');
  if (creeps.filter((creep) => creep.user === INVADER_USER).length >= INVADER_LIMIT) {
    throw new ApiError('too many invaders exist');
  }
  if (creeps.some((creep) => creep.user !== INVADER_USER && creep.user !== userId)) {
    throw new ApiError('hostiles present');
  }
  const controller = roomController(world, room);
  if (!controller || (controller.user !== userId && controller.reservation?.user !== userId)) {
    throw new ApiError('not owned');
  }
  if (hasTerrain(world.terrain[room] ?? '', options.x, options.y, C.TERRAIN_MASK_WALL)) {
    throw new ApiError('invalid location');
  }
  const body = options.body.map((type) => {
    const boost = options.boosted ? ownValue(INVADER_BOOSTS, type) : undefined;
    return boost ? { type, hits: 100, boost } : { type, hits: 100 };
  });
  const creep: RoomObject = {
    _id: newId(state),
    type: 'creep',
    user: INVADER_USER,
    body,
    hits: body.length * 100,
    hitsMax: body.length * 100,
    ticksToLive: 1500,
    x: options.x,
    y: options.y,
    room,
    fatigue: 0,
    store: {},
    storeCapacity: 0,
    name: `invader_${room}_${String(Math.floor(Math.random() * 1000))}`,
    userSummoned: userId,
  };
  world.roomObjects[creep._id] = creep;
  activateRoom(world, room);
  return creep;
}
