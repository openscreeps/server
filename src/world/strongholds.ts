/*
 * NPC Strongholds, ported from screeps/backend `lib/strongholds.js` and `lib/cli/strongholds.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { constants as C, strongholds, type WorldState } from '@openscreeps/engine';
import { findFreePos } from './generate.ts';
import { WorldRandom } from './random.ts';
import {
  activateRoom,
  insertObject,
  isAccessible,
  isBus,
  isCenter,
  isSectorCenterName,
  isVeryCenter,
  isWallAt,
  OBSTACLE_TYPES,
  roomNameFromXY,
  roomNameToXY,
  roomObjectsOf,
  sectorCenterOf,
  type RoomObject,
} from './rooms.ts';

/** Ticks of invulnerability before a newly generated stronghold deploys. */
export const STRONGHOLD_DEPLOY_TIME = 5000;

export type StrongholdTemplateName = keyof typeof strongholds.templates;

export interface SpawnStrongholdOptions {
  /** Template to spawn; default random among those that fit. */
  templateName?: string;
  /** Core position; used together with `templateName`. */
  x?: number;
  y?: number;
  /** Owner of the stronghold structures; default `'2'` (Invader). */
  user?: string;
  /** Delay in ticks until the stronghold deploys; default 1. */
  deployTime?: number;
}

function isTemplateName(name: string): name is StrongholdTemplateName {
  return Object.hasOwn(strongholds.templates, name);
}

/** Stronghold template names with descriptions (CLI help). */
export function strongholdTemplates(): Array<{ name: string; description: string }> {
  return Object.entries(strongholds.templates).map(([name, template]) => ({
    name,
    description: template.description,
  }));
}

/**
 * Upstream `spawnStronghold`: place an invulnerable invader core with its ramparts; the core builds
 * the rest of the template when it deploys. Throws when the room is occupied or nothing fits.
 */
export function spawnStronghold(
  world: WorldState,
  roomName: string,
  options: SpawnStrongholdOptions = {},
): void {
  const random = new WorldRandom(world);
  const deployDelay = options.deployTime || 1;
  if (!roomName || !world.rooms[roomName]) {
    throw new Error('invalid room');
  }
  const terrain = world.terrain[roomName];
  if (terrain === undefined) {
    throw new Error('invalid room');
  }
  if (options.templateName !== undefined && !isTemplateName(options.templateName)) {
    throw new Error('invalid template');
  }
  const user = options.user ?? '2';
  const gameTime = world.gameTime;
  const objects = roomObjectsOf(world, roomName).filter(
    (o) => o.type === C.STRUCTURE_RAMPART || OBSTACLE_TYPES[o.type] === true,
  );
  const templateNames: StrongholdTemplateName[] =
    options.templateName !== undefined && isTemplateName(options.templateName)
      ? [options.templateName]
      : (Object.keys(strongholds.templates) as StrongholdTemplateName[]);

  const controller = objects.find((o) => o.type === C.STRUCTURE_CONTROLLER);
  if (
    controller &&
    (controller.user || (controller.reservation && controller.reservation.user !== user))
  ) {
    throw new Error('room occupied');
  }

  const fits = (name: StrongholdTemplateName, x: number, y: number): boolean =>
    strongholds.templates[name].structures.every(
      (s) =>
        x + s.dx >= 0 &&
        x + s.dx <= 49 &&
        y + s.dy >= 0 &&
        y + s.dy <= 49 &&
        !isWallAt(terrain, x + s.dx, y + s.dy) &&
        !objects.some((o) => o.x === x + s.dx && o.y === y + s.dy),
    );

  const spots = new Map<StrongholdTemplateName, Array<{ x: number; y: number }>>();
  if (options.templateName !== undefined && options.x !== undefined && options.y !== undefined) {
    const name = templateNames[0] as StrongholdTemplateName;
    if (!fits(name, options.x, options.y)) {
      throw new Error('No spots');
    }
    spots.set(name, [{ x: options.x, y: options.y }]);
  } else {
    for (let x = 4; x < 45; x++) {
      for (let y = 4; y < 45; y++) {
        for (const name of templateNames) {
          if (fits(name, x, y)) {
            let list = spots.get(name);
            if (!list) {
              list = [];
              spots.set(name, list);
            }
            list.push({ x, y });
          }
        }
      }
    }
  }
  if (!spots.size) {
    throw new Error('No spots');
  }

  const selectedTemplateName = random.sample([...spots.keys()]) as StrongholdTemplateName;
  const selectedTemplate = strongholds.templates[selectedTemplateName];
  const spot = random.sample(
    spots.get(selectedTemplateName) as Array<{ x: number; y: number }>,
  ) as { x: number; y: number };
  const depositType = random.sample(Object.keys(strongholds.coreRewards)) as string;
  const deployTime = gameTime + deployDelay;
  const strongholdId = `${roomName}_${String(gameTime)}`;
  const invulnerability = (): NonNullable<RoomObject['effects']> => [
    {
      effect: C.EFFECT_INVULNERABILITY,
      power: C.EFFECT_INVULNERABILITY,
      endTime: deployTime,
      duration: STRONGHOLD_DEPLOY_TIME,
    },
  ];

  const structures: Array<Omit<RoomObject, '_id'>> = [];
  for (const s of selectedTemplate.structures) {
    if (s.type === C.STRUCTURE_INVADER_CORE && 'level' in s) {
      structures.push({
        type: s.type,
        level: s.level,
        strongholdBehavior: s.strongholdBehavior,
        room: roomName,
        x: spot.x + s.dx,
        y: spot.y + s.dy,
        user,
        templateName: selectedTemplateName,
        hits: C.INVADER_CORE_HITS,
        hitsMax: C.INVADER_CORE_HITS,
        nextExpandTime: deployTime + C.INVADER_CORE_EXPAND_TIME[s.level],
        depositType,
        deployTime,
        strongholdId,
        effects: invulnerability(),
      });
    }
    if (s.type === C.STRUCTURE_RAMPART) {
      structures.push({
        type: C.STRUCTURE_RAMPART,
        room: roomName,
        x: spot.x + s.dx,
        y: spot.y + s.dy,
        user,
        hits: 1,
        hitsMax: 1,
        isPublic: true,
        strongholdId,
        nextDecayTime: deployTime,
      });
    }
  }

  if (controller) {
    controller.user = user;
    controller.level = 8;
    controller.progress = 0;
    controller.downgradeTime = deployTime;
    controller.effects = invulnerability();
  }
  for (const structure of structures) {
    insertObject(world, structure);
  }
  activateRoom(world, roomName);
}

/** Rooms of the sector whose center is `centerName` (upstream regex `^W\dN\d$` on the name digits). */
function sectorRoomNames(world: WorldState, centerName: string): string[] {
  return Object.keys(world.rooms).filter((name) => sectorCenterOf(name) === centerName);
}

/**
 * Upstream `selectRoom`: spawn a stronghold in a free source keeper room of the sector (not the
 * center room, not a highway, no owner/reservation/claimer). Returns the chosen room.
 */
export function selectStrongholdRoom(world: WorldState, centerName: string): string | undefined {
  const random = new WorldRandom(world);
  const sectorRooms = new Set(sectorRoomNames(world, centerName));
  const sectorObjects = Object.values(world.roomObjects).filter(
    (o) => sectorRooms.has(o.room) && (o.type === 'creep' || o.type === 'controller'),
  );
  const possibleRooms = [...sectorRooms].filter((roomName) => {
    const room = world.rooms[roomName];
    const [x, y] = roomNameToXY(roomName);
    if (room?.bus || !isCenter(x, y) || isVeryCenter(x, y) || isBus(x) || isBus(y)) {
      return false;
    }
    const controller = sectorObjects.find((o) => o.type === 'controller' && o.room === roomName);
    if (!controller) {
      return true;
    }
    if (controller.user || controller.reservation) {
      return false;
    }
    return !sectorObjects.some(
      (o) =>
        o.room === roomName &&
        o.type === 'creep' &&
        (o.body ?? []).some((part) => part.type === C.CLAIM),
    );
  });
  const roomName = random.sample(possibleRooms);
  if (roomName !== undefined) {
    spawnStronghold(world, roomName, { deployTime: STRONGHOLD_DEPLOY_TIME });
  }
  return roomName;
}

/** Upstream `genStrongholds`: every sector without a core (alive or ruined) gets a new stronghold. */
export function genStrongholds(world: WorldState): void {
  const centers = Object.values(world.rooms).filter(
    (room) => isSectorCenterName(room._id) && room.status !== 'out of borders',
  );
  const cores = Object.values(world.roomObjects).filter(
    (o) => o.type === 'invaderCore' || (o.type === 'ruin' && o.structure?.type === 'invaderCore'),
  );
  for (const center of centers) {
    if (cores.some((core) => sectorCenterOf(core.room) === center._id)) {
      continue;
    }
    try {
      selectStrongholdRoom(world, center._id);
    } catch {
      // upstream logs the rejection (e.g. no spots) and keeps processing other sectors
    }
  }
}

/** Exit counts per side of one room; sides without plain exit tiles are absent. */
export type RoomExitCounts = Partial<Record<'t' | 'r' | 'b' | 'l', number>>;
/** Accessible rooms keyed `x,y` (upstream `buildMapGrid`). */
export type MapGrid = Map<string, RoomExitCounts>;

/** Exit counts per side (`t`/`r`/`b`/`l`) of every accessible room (upstream `buildMapGrid`). */
export function buildMapGrid(world: WorldState, now: number): MapGrid {
  const dirs = {
    t: { startx: 0, starty: 0, dx: 1, dy: 0 },
    r: { startx: 49, starty: 0, dx: 0, dy: 1 },
    b: { startx: 0, starty: 49, dx: 1, dy: 0 },
    l: { startx: 0, starty: 0, dx: 0, dy: 1 },
  } as const;
  const grid: MapGrid = new Map();
  for (const room of Object.values(world.rooms)) {
    const terrain = world.terrain[room._id];
    if (!isAccessible(room, now) || terrain === undefined) {
      continue;
    }
    const [x, y] = roomNameToXY(room._id);
    const roomData: RoomExitCounts = {};
    for (const dirName of ['t', 'r', 'b', 'l'] as const) {
      const { startx, starty, dx, dy } = dirs[dirName];
      let numExits = 0;
      for (let i = 0; i < 50; i++) {
        // plain tiles only, exactly like upstream's `terrain[i] == 0`
        if (terrain.charAt((starty + dy * i) * 50 + startx + dx * i) === '0') {
          numExits++;
        }
      }
      if (numExits > 0) {
        roomData[dirName] = numExits;
      }
    }
    grid.set(`${String(x)},${String(y)}`, roomData);
  }
  return grid;
}

/**
 * Upstream `expandStronghold`: search nearby non-highway rooms through exits for an unowned
 * controller room without a core and place a level 0 invader core near its controller.
 */
export function expandStronghold(
  world: WorldState,
  invaderCore: RoomObject,
  now: number,
  mapGrid?: MapGrid,
): boolean {
  const random = new WorldRandom(world);
  const grid = mapGrid ?? buildMapGrid(world, now);
  const gameTime = world.gameTime;
  const roomInfo = world.rooms[invaderCore.room];
  if (!roomInfo || (roomInfo.novice ?? 0) > now || (roomInfo.respawnArea ?? 0) > now) {
    return false;
  }
  const level = invaderCore.level as keyof typeof C.INVADER_CORE_EXPAND_TIME;
  invaderCore.nextExpandTime = gameTime + C.INVADER_CORE_EXPAND_TIME[level];

  const openList = [invaderCore.room];
  const closedList: string[] = [];
  let found: { room: string; controller: RoomObject } | undefined;
  do {
    const room = openList.shift() as string;
    closedList.push(room);
    const [x, y] = roomNameToXY(room);
    const exits = random.shuffle(Object.keys(grid.get(`${String(x)},${String(y)}`) ?? {}));
    for (const dir of exits) {
      const dx = dir === 'l' ? -1 : dir === 'r' ? 1 : 0;
      const dy = dir === 't' ? -1 : dir === 'b' ? 1 : 0;
      if (!grid.has(`${String(x + dx)},${String(y + dy)}`)) {
        continue;
      }
      const nextRoom = roomNameFromXY(x + dx, y + dy);
      if (isBus(x + dx) || isBus(y + dy)) {
        continue;
      }
      const nextRoomInfo = world.rooms[nextRoom];
      if (
        !nextRoomInfo ||
        (nextRoomInfo.novice ?? 0) > now ||
        (nextRoomInfo.respawnArea ?? 0) > now
      ) {
        continue;
      }
      const nextObjects = roomObjectsOf(world, nextRoom);
      const controller = nextObjects.find((o) => o.type === 'controller');
      const hasCore = nextObjects.some((o) => o.type === 'invaderCore');
      if (controller && !controller.user && !hasCore) {
        found = { room: nextRoom, controller };
        break;
      }
      if (
        (!controller || hasCore) &&
        !openList.includes(nextRoom) &&
        !closedList.includes(nextRoom)
      ) {
        openList.push(nextRoom);
      }
    }
  } while (!found && openList.length > 0);

  if (!found) {
    return false;
  }
  const pos = findFreePos(world, random, found.room, 1, {
    x1: Math.max(1, found.controller.x - 5),
    x2: Math.min(48, found.controller.x + 5),
    y1: Math.max(1, found.controller.y - 5),
    y2: Math.min(48, found.controller.y + 5),
  });
  if (!pos) {
    return false;
  }
  const core: Omit<RoomObject, '_id'> = {
    type: 'invaderCore',
    level: 0,
    room: found.room,
    x: pos.x,
    y: pos.y,
    user: '2',
    hits: C.INVADER_CORE_HITS,
    hitsMax: C.INVADER_CORE_HITS,
  };
  if (invaderCore.strongholdId !== undefined) {
    core.strongholdId = invaderCore.strongholdId;
  }
  if (invaderCore.effects !== undefined) {
    core.effects = structuredClone(invaderCore.effects);
  }
  insertObject(world, core);
  activateRoom(world, found.room);
  return true;
}

/** Upstream `expandStrongholds`: deployed cores whose expansion time passed spawn a lesser core. */
export function expandStrongholds(world: WorldState, now: number): void {
  const mapGrid = buildMapGrid(world, now);
  const gameTime = world.gameTime;
  const cores = Object.values(world.roomObjects).filter(
    (o) =>
      o.type === 'invaderCore' &&
      (o.deployTime === null || o.deployTime === undefined) &&
      (o.level ?? 0) > 0 &&
      (o.nextExpandTime ?? Infinity) < gameTime,
  );
  for (const core of cores) {
    expandStronghold(world, core, now, mapGrid);
  }
}

/** Upstream CLI `strongholds.expand(roomName)`. */
export function expandStrongholdInRoom(world: WorldState, roomName: string, now: number): void {
  const core = Object.values(world.roomObjects).find(
    (o) => o.type === 'invaderCore' && (o.level ?? 0) > 0 && o.room === roomName,
  );
  if (!core) {
    throw new Error('There is no NPC Stronghold in this room');
  }
  if (!expandStronghold(world, core, now)) {
    throw new Error('Could not expand this NPC Stronghold');
  }
}
