/*
 * Procedural room generation, ported from screeps/backend `lib/cli/map.js` (generateRoom, openRoom,
 * closeRoom, removeRoom), plus whole-world layout following the official sector rules.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { constants as C, createWorldState, type WorldState } from '@openscreeps/engine';
import { seedState, WorldRandom } from './random.ts';
import {
  activateRoom,
  insertObject,
  isBus,
  isCenter,
  isRoomName,
  isVeryCenter,
  isWallAt,
  nextId,
  OBSTACLE_TYPES,
  roomNameFromXY,
  roomNameToXY,
  roomObjectsOf,
  type RoomInfo,
  type RoomObject,
} from './rooms.ts';

export type ExitSide = 'top' | 'right' | 'bottom' | 'left';
export type RoomExits = Partial<Record<ExitSide, number[]>>;

export interface GenerateRoomOptions {
  /** Exit coordinates per side; omitted sides match existing neighbors or are random. `[]` = no exit. */
  exits?: RoomExits;
  /** Landscape type 1..28; default random 1..27. */
  terrainType?: number;
  /** Swamp configuration 0..14 (0 = none); default random 0..13. */
  swampType?: number;
  /** Number of sources; default randomly 1 or 2. */
  sources?: number;
  /** Mineral type, or `false` for no mineral; default random weighted type. */
  mineral?: string | false;
  /** Whether the room gets a controller; default true. */
  controller?: boolean;
  /** Source keeper lairs next to every source (and the mineral); default false. */
  keeperLairs?: boolean;
  /** Neutral extractor on the mineral (center and source keeper rooms); default false. */
  extractor?: boolean;
  /** Highway room flag (power banks, deposits); default false. */
  bus?: boolean;
  /** Deposit type harvested in this highway room. */
  depositType?: string;
}

const SIDES: readonly ExitSide[] = ['top', 'right', 'bottom', 'left'];

const WALL_TYPES: Readonly<Record<number, { fill: number; smooth: number; factor: number }>> = {
  1: { fill: 0.4, smooth: 10, factor: 5 },
  2: { fill: 0.2, smooth: 20, factor: 4 },
  3: { fill: 0.2, smooth: 20, factor: 4 },
  4: { fill: 0.3, smooth: 18, factor: 4 },
  5: { fill: 0.3, smooth: 10, factor: 4 },
  6: { fill: 0.3, smooth: 10, factor: 4 },
  7: { fill: 0.3, smooth: 10, factor: 4 },
  8: { fill: 0.35, smooth: 15, factor: 4 },
  9: { fill: 0.3, smooth: 2, factor: 4 },
  10: { fill: 0.35, smooth: 2, factor: 4 },
  11: { fill: 0.35, smooth: 5, factor: 4 },
  12: { fill: 0.35, smooth: 5, factor: 4 },
  13: { fill: 0.25, smooth: 5, factor: 4 },
  14: { fill: 0.4, smooth: 3, factor: 5 },
  15: { fill: 0.5, smooth: 3, factor: 5 },
  16: { fill: 0.45, smooth: 4, factor: 5 },
  17: { fill: 0.45, smooth: 6, factor: 5 },
  18: { fill: 0.45, smooth: 10, factor: 5 },
  19: { fill: 0.5, smooth: 10, factor: 5 },
  20: { fill: 0.4, smooth: 3, factor: 5 },
  21: { fill: 0.5, smooth: 2, factor: 5 },
  22: { fill: 0.45, smooth: 4, factor: 5 },
  23: { fill: 0.45, smooth: 6, factor: 5 },
  24: { fill: 0.45, smooth: 10, factor: 5 },
  25: { fill: 0.5, smooth: 10, factor: 5 },
  26: { fill: 0.45, smooth: 10, factor: 5 },
  27: { fill: 0.45, smooth: 6, factor: 5 },
  28: { fill: 0.2, smooth: 20, factor: 4 },
};

const SWAMP_TYPES: Readonly<Record<number, { fill: number; smooth: number; factor: number }>> = {
  1: { fill: 0.3, smooth: 3, factor: 5 },
  2: { fill: 0.35, smooth: 3, factor: 5 },
  3: { fill: 0.45, smooth: 3, factor: 5 },
  4: { fill: 0.25, smooth: 1, factor: 5 },
  5: { fill: 0.25, smooth: 30, factor: 4 },
  6: { fill: 0.52, smooth: 30, factor: 5 },
  7: { fill: 0.45, smooth: 3, factor: 5 },
  8: { fill: 0.3, smooth: 1, factor: 5 },
  9: { fill: 0.3, smooth: 1, factor: 4 },
  10: { fill: 0.3, smooth: 3, factor: 5 },
  11: { fill: 0.3, smooth: 3, factor: 5 },
  12: { fill: 0.3, smooth: 1, factor: 5 },
  13: { fill: 0.25, smooth: 1, factor: 5 },
  14: { fill: 0.35, smooth: 3, factor: 5 },
};

const MINERAL_TYPES = [
  'H',
  'H',
  'H',
  'H',
  'H',
  'H',
  'O',
  'O',
  'O',
  'O',
  'O',
  'O',
  'Z',
  'Z',
  'Z',
  'K',
  'K',
  'K',
  'U',
  'U',
  'U',
  'L',
  'L',
  'L',
  'X',
];
const DEPOSIT_TYPES = [C.RESOURCE_SILICON, C.RESOURCE_METAL, C.RESOURCE_BIOMASS, C.RESOURCE_MIST];
/** Mostly open landscapes, used for highway rooms like the official map. */
const OPEN_TERRAIN_TYPES = [2, 3, 4, 5, 6, 7, 9, 13, 28];

/** One generated room before it is encoded (upstream `roomData[y][x]` flags, row-major). */
interface Grid {
  wall: Uint8Array;
  swamp: Uint8Array;
  forceOpen: Uint8Array;
  source: Uint8Array;
  keeperLair: Uint8Array;
  controller: Uint8Array;
}

/** Restart generation with another random landscape (upstream recursive `_genTerrain` call). */
class RetryTerrain extends Error {}

function newGrid(): Grid {
  return {
    wall: new Uint8Array(2500),
    swamp: new Uint8Array(2500),
    forceOpen: new Uint8Array(2500),
    source: new Uint8Array(2500),
    keeperLair: new Uint8Array(2500),
    controller: new Uint8Array(2500),
  };
}

function inside(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x <= 49 && y <= 49;
}

/** Open tile among the 3x3 square (upstream `passNearby`/`hasSpot`). */
function hasOpenNeighbor(wall: Uint8Array, x: number, y: number): boolean {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (inside(x + dx, y + dy) && !wall[(y + dy) * 50 + x + dx]) {
        return true;
      }
    }
  }
  return false;
}

/** Non-wall tiles along an edge row/column of an encoded terrain (upstream `_exitsArray`). */
export function exitsOf(terrain: string, side: ExitSide): number[] {
  const exits: number[] = [];
  for (let i = 0; i < 50; i++) {
    const x = side === 'left' ? 0 : side === 'right' ? 49 : i;
    const y = side === 'top' ? 0 : side === 'bottom' ? 49 : i;
    if (!isWallAt(terrain, x, y)) {
      exits.push(i);
    }
  }
  return exits;
}

/** Upstream `_genExit`: a random exit made of up to three passages. */
function genExit(random: WorldRandom): number[] {
  const exitLength = random.index(43) + 1;
  const intervalsCnt = [0, 0, 1, 1, 2][random.index(5)] as number;
  const exitStart = random.index(46 - exitLength) + 2;
  const intervals: Array<{ start: number; length: number }> = [];
  let curStart = exitStart;
  for (let j = 0; j < intervalsCnt; j++) {
    curStart += Math.floor(random.next() * (exitLength / (intervalsCnt * 2))) + 5;
    let length = Math.floor(random.next() * (exitLength / (intervalsCnt * 2))) + 5;
    if (length + curStart >= exitStart + exitLength - 5) {
      length = exitStart + exitLength - curStart - 5;
    }
    intervals.push({ start: curStart, length });
    curStart += length + 1;
  }
  const exit: number[] = [];
  for (let x = exitStart; x <= exitStart + exitLength; x++) {
    if (intervals.some((i) => i.length > 0 && x >= i.start && x <= i.start + i.length)) {
      continue;
    }
    if (x < 2 || x > 47) {
      continue;
    }
    exit.push(x);
  }
  return exit;
}

/** Upstream `_smoothTerrain` (cellular automaton over one flag). */
function smooth(grid: Grid, key: 'wall' | 'swamp', factor: number): void {
  const source = grid[key];
  const result = new Uint8Array(2500);
  for (let y = 0; y < 50; y++) {
    for (let x = 0; x < 50; x++) {
      let cnt = 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (inside(x + dx, y + dy) ? source[(y + dy) * 50 + x + dx] : key === 'wall') {
            cnt++;
          }
        }
      }
      let value = cnt >= factor;
      if (key === 'wall') {
        if (x === 0 || x === 49 || y === 0 || y === 49) {
          value = true;
        }
        if (grid.forceOpen[y * 50 + x]) {
          value = false;
        }
      }
      result[y * 50 + x] = value ? 1 : 0;
    }
  }
  grid[key] = result;
}

/** Upstream `_checkFlood`: every open tile is reachable from every other one. */
function checkFlood(wall: Uint8Array): boolean {
  const start = wall.indexOf(0);
  if (start < 0) {
    return false;
  }
  const visited = new Uint8Array(2500);
  const list = [start];
  visited[start] = 1;
  let reached = 1;
  while (list.length) {
    const i = list.pop() as number;
    const x = i % 50;
    const y = (i - x) / 50;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const n = (y + dy) * 50 + x + dx;
        if ((dx || dy) && inside(x + dx, y + dy) && !wall[n] && !visited[n]) {
          visited[n] = 1;
          reached++;
          list.push(n);
        }
      }
    }
  }
  let open = 0;
  for (let i = 0; i < 2500; i++) {
    if (!wall[i]) open++;
  }
  return open === reached;
}

/**
 * Keeper lair spots near a wall-embedded object: walls 3..5 steps away through open tiles
 * (upstream lair search around sources).
 */
function lairSpots(grid: Grid, x: number, y: number): number[] {
  const spots: number[] = [];
  const visited = new Map<number, number>([[y * 50 + x, 0]]);
  const list = [y * 50 + x];
  while (list.length) {
    const c = list.pop() as number;
    const cx = c % 50;
    const cy = (c - cx) / 50;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const nx = cx + dx;
        const ny = cy + dy;
        const n = ny * 50 + nx;
        if ((!dx && !dy) || visited.has(n) || !inside(nx, ny)) {
          continue;
        }
        const distance = (visited.get(c) as number) + 1;
        visited.set(n, distance);
        if (
          distance >= 3 &&
          distance <= 5 &&
          grid.wall[n] &&
          !grid.source[n] &&
          !grid.keeperLair[n] &&
          nx > 0 &&
          nx < 49 &&
          ny > 0 &&
          ny < 49
        ) {
          spots.push(n);
        }
        if (!grid.wall[n] && distance < 5) {
          list.push(n);
        }
      }
    }
  }
  return spots;
}

function genTerrainOnce(
  random: WorldRandom,
  wallType: number,
  swampType: number,
  exits: Required<RoomExits>,
  sources: number,
  controller: boolean,
  keeperLair: boolean,
): Grid {
  const type = WALL_TYPES[wallType];
  if (!type) {
    throw new Error(`Invalid terrain type ${String(wallType)}`);
  }
  const swamp = swampType ? SWAMP_TYPES[swampType] : undefined;
  if (swampType && !swamp) {
    throw new Error(`Invalid swamp type ${String(swampType)}`);
  }
  let grid: Grid;
  let currentType = type;
  let tries = 0;
  do {
    grid = newGrid();
    tries++;
    if (tries > 100) {
      currentType = WALL_TYPES[random.index(27) + 1] as typeof type;
      tries = 0;
    }
    for (let y = 0; y < 50; y++) {
      for (let x = 0; x < 50; x++) {
        const i = y * 50 + x;
        if (y === 0 && exits.top.includes(x)) {
          grid.forceOpen[i] = grid.forceOpen[i + 50] = 1;
          continue;
        }
        if (y === 49 && exits.bottom.includes(x)) {
          grid.forceOpen[i] = grid.forceOpen[i - 50] = 1;
          continue;
        }
        if (x === 0 && exits.left.includes(y)) {
          grid.forceOpen[i] = grid.forceOpen[i + 1] = 1;
          continue;
        }
        if (x === 49 && exits.right.includes(y)) {
          grid.forceOpen[i] = grid.forceOpen[i - 1] = 1;
          continue;
        }
        grid.wall[i] = random.next() < currentType.fill ? 1 : 0;
        grid.swamp[i] = swamp && random.next() < swamp.fill ? 1 : 0;
      }
    }
    for (let i = 0; i < currentType.smooth; i++) {
      smooth(grid, 'wall', currentType.factor);
    }
  } while (!checkFlood(grid.wall));

  if (swamp) {
    for (let i = 0; i < swamp.smooth; i++) {
      smooth(grid, 'swamp', swamp.factor);
    }
  }

  for (let s = 0; s < sources; s++) {
    let x: number;
    let y: number;
    let attempts = 0;
    do {
      attempts++;
      x = random.index(44) + 3;
      y = random.index(44) + 3;
      if (attempts > 1000) {
        throw new RetryTerrain();
      }
    } while (
      !grid.wall[y * 50 + x] ||
      grid.source[y * 50 + x] ||
      grid.keeperLair[y * 50 + x] ||
      !hasOpenNeighbor(grid.wall, x, y)
    );
    grid.source[y * 50 + x] = 1;

    if (keeperLair) {
      const spots = lairSpots(grid, x, y);
      if (!spots.length) {
        throw new RetryTerrain();
      }
      grid.keeperLair[random.shuffle(spots)[0] as number] = 1;
    }
  }

  if (controller) {
    let x: number;
    let y: number;
    let attempts = 0;
    do {
      attempts++;
      x = random.index(40) + 5;
      y = random.index(40) + 5;
      if (attempts > 10000) {
        throw new RetryTerrain();
      }
    } while (
      !grid.wall[y * 50 + x] ||
      !hasOpenNeighbor(grid.wall, x, y) ||
      grid.source[y * 50 + x] ||
      grid.keeperLair[y * 50 + x]
    );
    grid.controller[y * 50 + x] = 1;
  }

  return grid;
}

/** Upstream `_genTerrain`, retrying with a random landscape whenever objects cannot be placed. */
function genTerrain(
  random: WorldRandom,
  wallType: number,
  swampType: number,
  exits: Required<RoomExits>,
  sources: number,
  controller: boolean,
  keeperLair: boolean,
): Grid {
  let type = wallType;
  for (;;) {
    try {
      return genTerrainOnce(random, type, swampType, exits, sources, controller, keeperLair);
    } catch (error) {
      if (!(error instanceof RetryTerrain)) {
        throw error;
      }
      type = random.index(27) + 1;
    }
  }
}

interface MineralSpot {
  x: number;
  y: number;
  /** Keeper lair tile index (`y * 50 + x`) guarding the mineral. */
  lair?: number;
}

/** Upstream mineral placement: a wall with an open neighbor, at least 5 tiles from sources/controller. */
function placeMineral(
  random: WorldRandom,
  grid: Grid,
  objects: ReadonlyArray<Pick<RoomObject, 'type' | 'x' | 'y'>>,
  keeperLair: boolean,
): MineralSpot | undefined {
  for (let attempts = 0; attempts < 10000; attempts++) {
    const mx = 4 + random.index(42);
    const my = 4 + random.index(42);
    const i = my * 50 + mx;
    if (!grid.wall[i] || !hasOpenNeighbor(grid.wall, mx, my)) continue;
    if (
      objects.some(
        (o) =>
          ((o.type === 'source' || o.type === 'controller') &&
            Math.abs(o.x - mx) < 5 &&
            Math.abs(o.y - my) < 5) ||
          (o.x === mx && o.y === my),
      )
    ) {
      continue;
    }
    if (!keeperLair) {
      return { x: mx, y: my };
    }
    const spots = lairSpots(grid, mx, my).filter((n) => !objects.some((o) => o.y * 50 + o.x === n));
    if (spots.length) {
      return { x: mx, y: my, lair: random.shuffle(spots)[0] as number };
    }
  }
  return undefined;
}

/**
 * Generate a new room (upstream `map.generateRoom`). Throws on an invalid name, an existing room
 * or exits that do not match existing neighbors. Writes `rooms`, `terrain` and room objects and
 * schedules the room for processing; the server must refresh terrain afterwards.
 */
export function generateRoom(
  world: WorldState,
  roomName: string,
  options: GenerateRoomOptions = {},
): void {
  if (!isRoomName(roomName)) {
    throw new Error('Invalid room name');
  }
  if (world.rooms[roomName]) {
    throw new Error('This room already exists');
  }
  const random = new WorldRandom(world);
  const [rx, ry] = roomNameToXY(roomName);
  const neighbors: Record<ExitSide, string> = {
    top: roomNameFromXY(rx, ry - 1),
    right: roomNameFromXY(rx + 1, ry),
    bottom: roomNameFromXY(rx, ry + 1),
    left: roomNameFromXY(rx - 1, ry),
  };
  const opposite: Record<ExitSide, ExitSide> = {
    top: 'bottom',
    right: 'left',
    bottom: 'top',
    left: 'right',
  };
  const requested = options.exits ?? {};
  const exits: Required<RoomExits> = { top: [], right: [], bottom: [], left: [] };
  for (const side of SIDES) {
    const neighborTerrain = world.terrain[neighbors[side]];
    const neighborExits =
      neighborTerrain === undefined ? undefined : exitsOf(neighborTerrain, opposite[side]);
    const wanted = requested[side];
    if (wanted) {
      if (
        neighborExits &&
        !(neighborExits.length === wanted.length && neighborExits.every((i) => wanted.includes(i)))
      ) {
        throw new Error(`Exits in room ${neighbors[side]} don't match`);
      }
      for (const i of wanted) {
        if (!Number.isInteger(i) || i < 1 || i > 48) {
          throw new Error(`Invalid ${side} exit coordinate ${String(i)}`);
        }
      }
      exits[side] = [...wanted];
    } else {
      exits[side] = neighborExits ?? genExit(random);
    }
  }

  const terrainType = options.terrainType ?? random.index(27) + 1;
  const swampType = options.swampType ?? random.index(14);
  const sources = options.sources ?? (random.next() > 0.5 ? 1 : 2);
  const controller = options.controller ?? true;
  const keeperLairs = options.keeperLairs ?? false;
  if (!Number.isInteger(sources) || sources < 0 || sources > 10) {
    throw new Error(`Invalid sources count ${String(sources)}`);
  }

  let grid = genTerrain(random, terrainType, swampType, exits, sources, controller, keeperLairs);
  const roomObjects: Array<Omit<RoomObject, '_id'>> = [];
  const mineral: string | false =
    options.mineral ?? (MINERAL_TYPES[random.index(MINERAL_TYPES.length)] as string);
  let placed: MineralSpot | undefined;
  let terrain: string;
  for (;;) {
    roomObjects.length = 0;
    terrain = '';
    for (let y = 0; y < 50; y++) {
      for (let x = 0; x < 50; x++) {
        const i = y * 50 + x;
        if (grid.source[i]) {
          roomObjects.push({
            room: roomName,
            type: 'source',
            x,
            y,
            energy: C.SOURCE_ENERGY_NEUTRAL_CAPACITY,
            energyCapacity: C.SOURCE_ENERGY_NEUTRAL_CAPACITY,
          });
        }
        if (grid.controller[i]) {
          roomObjects.push({ room: roomName, type: 'controller', x, y, level: 0 });
        }
        if (grid.keeperLair[i]) {
          roomObjects.push({ room: roomName, type: 'keeperLair', x, y });
        }
        // swamp is kept only next to open tiles (upstream)
        const swamp = grid.swamp[i] && hasOpenNeighbor(grid.wall, x, y);
        terrain += String(
          (grid.wall[i] ? C.TERRAIN_MASK_WALL : 0) | (swamp ? C.TERRAIN_MASK_SWAMP : 0),
        );
      }
    }
    if (!mineral) {
      placed = undefined;
      break;
    }
    placed = placeMineral(random, grid, roomObjects, keeperLairs);
    if (placed) {
      break;
    }
    grid = genTerrain(
      random,
      random.index(27) + 1,
      swampType,
      exits,
      sources,
      controller,
      keeperLairs,
    );
  }

  if (mineral && placed) {
    const r = random.next();
    let density: number = C.DENSITY_ULTRA;
    for (const [d, probability] of Object.entries(C.MINERAL_DENSITY_PROBABILITY)) {
      if (r <= probability) {
        density = Number(d);
        break;
      }
    }
    roomObjects.push({
      type: 'mineral',
      mineralType: mineral,
      density,
      mineralAmount: C.MINERAL_DENSITY[density as keyof typeof C.MINERAL_DENSITY],
      x: placed.x,
      y: placed.y,
      room: roomName,
    });
    if (placed.lair !== undefined) {
      roomObjects.push({
        room: roomName,
        type: 'keeperLair',
        x: placed.lair % 50,
        y: Math.floor(placed.lair / 50),
      });
    }
    if (options.extractor) {
      roomObjects.push({ type: 'extractor', x: placed.x, y: placed.y, room: roomName });
    }
  }

  const room: RoomInfo = {
    _id: roomName,
    status: 'normal',
    sourceKeepers: roomObjects.some((o) => o.type === 'keeperLair'),
  };
  if (options.bus) {
    room.bus = true;
  }
  if (options.depositType !== undefined) {
    room.depositType = options.depositType;
  }
  world.rooms[roomName] = room;
  world.terrain[roomName] = terrain;
  for (const object of roomObjects) {
    insertObject(world, object);
  }
  activateRoom(world, roomName);
}

/** Upstream `map.openRoom`: make a room available, optionally only from a future timestamp. */
export function openRoom(world: WorldState, roomName: string, timestamp?: number): void {
  const room = world.rooms[roomName];
  if (!room) {
    throw new Error(`The room ${roomName} is not found`);
  }
  room.status = 'normal';
  if (timestamp) {
    room.openTime = timestamp;
  }
  activateRoom(world, roomName);
}

/** Upstream `map.closeRoom`: a `normal` room becomes `out of borders`. */
export function closeRoom(world: WorldState, roomName: string): void {
  const room = world.rooms[roomName];
  if (!room) {
    throw new Error(`The room ${roomName} is not found`);
  }
  if (room.status === 'normal') {
    room.status = 'out of borders';
  }
}

/** Upstream `map.removeRoom`: delete the room with all its objects, flags and terrain. */
export function removeRoom(world: WorldState, roomName: string): void {
  if (!world.rooms[roomName]) {
    throw new Error(`The room ${roomName} is not found`);
  }
  Reflect.deleteProperty(world.rooms, roomName);
  Reflect.deleteProperty(world.terrain, roomName);
  Reflect.deleteProperty(world.mapViews, roomName);
  Reflect.deleteProperty(world.roomEventLogs, roomName);
  for (const [id, object] of Object.entries(world.roomObjects)) {
    if (object.room === roomName) {
      Reflect.deleteProperty(world.roomObjects, id);
    }
  }
  for (const [id, flag] of Object.entries(world.flags)) {
    if (flag.room === roomName) {
      Reflect.deleteProperty(world.flags, id);
    }
  }
  for (const user of Object.values(world.users)) {
    if (user.rooms?.includes(roomName)) {
      user.rooms = user.rooms.filter((name) => name !== roomName);
    }
  }
  world.activeRooms = world.activeRooms.filter((name) => name !== roomName);
}

/** Free tile with a free square of `distance` around it (upstream `utils.findFreePos`). */
export function findFreePos(
  world: WorldState,
  random: WorldRandom,
  roomName: string,
  distance: number,
  rect: { x1: number; x2: number; y1: number; y2: number } = { x1: 4, x2: 45, y1: 4, y2: 45 },
): { x: number; y: number } | undefined {
  const terrain = world.terrain[roomName];
  if (terrain === undefined) {
    return undefined;
  }
  const blockers = roomObjectsOf(world, roomName).filter(
    (i) => OBSTACLE_TYPES[i.type] === true || i.type === 'rampart' || i.type === 'portal',
  );
  for (let counter = 0; counter < 500; counter++) {
    const x = rect.x1 + random.index(rect.x2 - rect.x1);
    const y = rect.y1 + random.index(rect.y2 - rect.y1);
    let spot = true;
    for (let dx = -distance; dx <= distance && spot; dx++) {
      for (let dy = -distance; dy <= distance; dy++) {
        if (isWallAt(terrain, x + dx, y + dy)) {
          spot = false;
          break;
        }
      }
    }
    if (
      spot &&
      !blockers.some((i) => Math.abs(i.x - x) <= distance && Math.abs(i.y - y) <= distance)
    ) {
      return { x, y };
    }
  }
  return undefined;
}

/** Plain (non-wall, non-swamp) 5x5 square without objects, centered at the returned tile. */
function findPortalSpot(
  world: WorldState,
  random: WorldRandom,
  roomName: string,
): { x: number; y: number } | undefined {
  const terrain = world.terrain[roomName] as string;
  const objects = roomObjectsOf(world, roomName);
  const candidates: Array<{ x: number; y: number }> = [];
  for (let x = 8; x <= 41; x++) {
    for (let y = 8; y <= 41; y++) {
      let free = true;
      for (let dx = -2; dx <= 2 && free; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          if (terrain.charAt((y + dy) * 50 + x + dx) !== '0') {
            free = false;
            break;
          }
        }
      }
      if (free && !objects.some((o) => Math.abs(o.x - x) <= 2 && Math.abs(o.y - y) <= 2)) {
        candidates.push({ x, y });
      }
    }
  }
  return random.sample(candidates);
}

export interface PortalOptions {
  /** Wall-clock ms after which the portal becomes unstable and decays in `PORTAL_DECAY` ticks. */
  unstableDate?: number;
  /** Game tick after which the portal disappears. */
  decayTime?: number;
}

/**
 * Create a one-way portal cluster in `fromRoom` leading to `toRoom`: eight portals around an
 * indestructible wall, each leading to the tile two steps out from the matching side of the
 * destination cluster centered at `to`.
 */
export function createPortal(
  world: WorldState,
  fromRoom: string,
  to: { room: string; x: number; y: number },
  at: { x: number; y: number },
  options: PortalOptions = {},
): void {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) {
        insertObject(world, { type: 'constructedWall', room: fromRoom, x: at.x, y: at.y });
        continue;
      }
      const portal: Omit<RoomObject, '_id'> = {
        type: 'portal',
        room: fromRoom,
        x: at.x + dx,
        y: at.y + dy,
        destination: { room: to.room, x: to.x + 2 * dx, y: to.y + 2 * dy },
      };
      if (options.unstableDate !== undefined) {
        portal.unstableDate = options.unstableDate;
      }
      if (options.decayTime !== undefined) {
        portal.decayTime = options.decayTime;
      }
      insertObject(world, portal);
    }
  }
  activateRoom(world, fromRoom);
}

/**
 * Link two rooms with a pair of portal clusters (each one-way, landing beside the other cluster).
 * Throws when either room has no free plain 5x5 area.
 */
export function createPortalPair(
  world: WorldState,
  roomA: string,
  roomB: string,
  options: PortalOptions = {},
): void {
  const random = new WorldRandom(world);
  if (!world.rooms[roomA] || !world.rooms[roomB]) {
    throw new Error('Both portal rooms must exist');
  }
  const a = findPortalSpot(world, random, roomA);
  const b = roomA === roomB ? undefined : findPortalSpot(world, random, roomB);
  if (!a || !b) {
    throw new Error('No free area for a portal');
  }
  createPortal(world, roomA, { room: roomB, ...b }, a, options);
  createPortal(world, roomB, { room: roomA, ...a }, b, options);
}

/** Unowned, indestructible terminal used by NPC market orders. */
export function createNpcTerminal(world: WorldState, roomName: string): RoomObject {
  const random = new WorldRandom(world);
  const pos =
    findFreePos(world, random, roomName, 1, { x1: 15, x2: 35, y1: 15, y2: 35 }) ??
    findFreePos(world, random, roomName, 1);
  if (!pos) {
    throw new Error(`No free position for a terminal in ${roomName}`);
  }
  const terminal = insertObject(world, {
    type: 'terminal',
    room: roomName,
    x: pos.x,
    y: pos.y,
    store: {},
  });
  activateRoom(world, roomName);
  return terminal;
}

export interface CreateWorldOptions {
  /** Rooms per side: the world spans W(size-1)N(size-1)..W0N0 (11 = one sector, the default map). */
  size: number;
  seed: number;
  shardName: string;
}

/** Highway segment between two crossroads; all its rooms share a deposit type. */
function highwaySegment(x: number, y: number): string {
  const sector = (c: number): string =>
    c < 0 ? `-${String(Math.floor((-c - 1) / 10))}` : String(Math.floor(c / 10));
  if (isBus(x) && isBus(y)) {
    return `cross:${String(x)}:${String(y)}`;
  }
  return isBus(x) ? `v:${String(x)}:${sector(y)}` : `h:${String(y)}:${sector(x)}`;
}

function sectorOptions(x: number, y: number, depositType: string | undefined): GenerateRoomOptions {
  if (isBus(x) || isBus(y)) {
    const options: GenerateRoomOptions = {
      controller: false,
      sources: 0,
      mineral: false,
      bus: true,
    };
    if (depositType !== undefined) {
      options.depositType = depositType;
    }
    return options;
  }
  if (isVeryCenter(x, y)) {
    return { controller: false, sources: 3, keeperLairs: false, extractor: true };
  }
  if (isCenter(x, y)) {
    return { controller: false, sources: 3, keeperLairs: true, extractor: true };
  }
  return {};
}

/**
 * Generate a complete world following the official sector layout: highway rooms on every tenth
 * row/column (power banks and deposits, NPC terminals at crossroads), a 3x3 source keeper block
 * around every sector center, portals linking sector centers, and controller rooms elsewhere.
 * Room exits match on both sides, the world border is walled and every room is reachable.
 */
export function createWorld(options: CreateWorldOptions): WorldState {
  const { size, seed, shardName } = options;
  if (!Number.isInteger(size) || size < 1 || size > 200) {
    throw new Error(`Invalid world size ${String(size)}`);
  }
  const world = createWorldState({ shardName, rngState: seedState(seed) });
  const random = new WorldRandom(world);

  world.users['2'] = {
    _id: '2',
    username: 'Invader',
    usernameLower: 'invader',
    gcl: 0,
    cpu: 0,
    active: 1,
    cpuAvailable: 10000,
  };
  world.users['3'] = {
    _id: '3',
    username: 'Source Keeper',
    usernameLower: 'source keeper',
    gcl: 0,
    cpu: 0,
    active: 1,
    cpuAvailable: 10000,
  };
  ensureSystemUser(world);

  const min = -size;
  const max = -1;
  // exits of every internal edge, decided up front so both rooms agree and no edge is closed
  const horizontal = new Map<string, number[]>();
  const vertical = new Map<string, number[]>();
  const edgeExit = (): number[] => {
    for (;;) {
      const exit = genExit(random);
      if (exit.length) return exit;
    }
  };
  for (let x = min; x <= max; x++) {
    for (let y = min; y <= max; y++) {
      if (x < max) horizontal.set(`${String(x)},${String(y)}`, edgeExit());
      if (y < max) vertical.set(`${String(x)},${String(y)}`, edgeExit());
    }
  }
  const depositTypes = new Map<string, string>();
  const centers: string[] = [];
  const crossroads: string[] = [];

  for (let y = min; y <= max; y++) {
    for (let x = min; x <= max; x++) {
      const roomName = roomNameFromXY(x, y);
      let depositType: string | undefined;
      if (isBus(x) || isBus(y)) {
        const segment = highwaySegment(x, y);
        depositType = depositTypes.get(segment);
        if (depositType === undefined) {
          const selected = random.sample(DEPOSIT_TYPES);
          if (selected === undefined) throw new Error('No deposit types configured');
          depositType = selected;
          depositTypes.set(segment, depositType);
        }
      }
      const roomOptions = sectorOptions(x, y, depositType);
      roomOptions.exits = {
        top: y > min ? (vertical.get(`${String(x)},${String(y - 1)}`) as number[]) : [],
        bottom: y < max ? (vertical.get(`${String(x)},${String(y)}`) as number[]) : [],
        left: x > min ? (horizontal.get(`${String(x - 1)},${String(y)}`) as number[]) : [],
        right: x < max ? (horizontal.get(`${String(x)},${String(y)}`) as number[]) : [],
      };
      if (roomOptions.bus) {
        roomOptions.terrainType = random.sample(OPEN_TERRAIN_TYPES) as number;
      }
      const needsFeature = (isBus(x) && isBus(y)) || isVeryCenter(x, y);
      for (let attempt = 0; ; attempt++) {
        generateRoom(world, roomName, roomOptions);
        const ok =
          !needsFeature ||
          (isVeryCenter(x, y)
            ? findPortalSpot(world, random, roomName)
            : findFreePos(world, random, roomName, 1));
        if (ok || attempt >= 50) {
          if (!ok) {
            throw new Error(`Cannot lay out ${roomName}`);
          }
          break;
        }
        removeRoom(world, roomName);
        roomOptions.terrainType = random.sample(OPEN_TERRAIN_TYPES) as number;
      }
      if (isVeryCenter(x, y)) centers.push(roomName);
      if (isBus(x) && isBus(y)) crossroads.push(roomName);
    }
  }

  for (const roomName of crossroads) {
    createNpcTerminal(world, roomName);
  }
  if (centers.length > 1) {
    const order = random.shuffle(centers);
    const spots = new Map(
      order.map((room) => [room, findPortalSpot(world, random, room) as { x: number; y: number }]),
    );
    order.forEach((room, i) => {
      const target = order[(i + 1) % order.length] as string;
      createPortal(
        world,
        room,
        { room: target, ...(spots.get(target) as { x: number; y: number }) },
        spots.get(room) as { x: number; y: number },
      );
    });
  }
  return world;
}

/** The `Screeps` system user owning ruins of respawned players (created if absent). */
export function ensureSystemUser(world: WorldState): string {
  const existing = Object.values(world.users).find((user) => user.username === C.SYSTEM_USERNAME);
  if (existing) {
    return existing._id;
  }
  const id = nextId(world, world.users);
  world.users[id] = {
    _id: id,
    username: C.SYSTEM_USERNAME,
    usernameLower: C.SYSTEM_USERNAME.toLowerCase(),
    gcl: 0,
    cpu: 0,
    active: 0,
    cpuAvailable: 0,
    badge: {
      type: 12,
      color1: '#999999',
      color2: '#999999',
      color3: '#999999',
      flip: false,
      param: 26,
    },
  };
  return id;
}
