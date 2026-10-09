import { constants as C, type WorldState } from '@openscreeps/engine';

export type RoomObject = WorldState['roomObjects'][string];
export type RoomInfo = WorldState['rooms'][string];

const ROOM_NAME = /^([WE])(\d+)([NS])(\d+)$/;

/** Upstream `utils.roomNameToXY`: W0 is x=-1, E0 is x=0 (same for N/S). */
export function roomNameToXY(name: string): [number, number] {
  const match = ROOM_NAME.exec(name);
  if (!match) {
    throw new Error(`Invalid room name ${name}`);
  }
  const x = Number(match[2]);
  const y = Number(match[4]);
  return [match[1] === 'W' ? -x - 1 : x, match[3] === 'N' ? -y - 1 : y];
}

/** Upstream `utils.roomNameFromXY`. */
export function roomNameFromXY(x: number, y: number): string {
  const h = x < 0 ? `W${String(-x - 1)}` : `E${String(x)}`;
  const v = y < 0 ? `N${String(-y - 1)}` : `S${String(y)}`;
  return h + v;
}

export function isRoomName(name: string): boolean {
  return ROOM_NAME.test(name);
}

/** Distance of a coordinate from the sector's west/north highway, 0..9 (W0 and E0 are both 0). */
function sectorOffset(coord: number): number {
  return coord < 0 ? Math.abs(coord + 1) % 10 : coord % 10;
}

/** Room coordinate on a highway column/row (upstream `utils.isBus`). */
export function isBus(coord: number): boolean {
  return sectorOffset(coord) === 0;
}

/** Object types that block a tile (`OBSTACLE_OBJECT_TYPES`). */
export const OBSTACLE_TYPES: Readonly<Record<string, true>> = Object.fromEntries(
  C.OBSTACLE_OBJECT_TYPES.map((type) => [type, true] as const),
);

/** Upstream `utils.isCenter`: one of the 3x3 source keeper rooms around the sector center. */
export function isCenter(x: number, y: number): boolean {
  const ox = sectorOffset(x);
  const oy = sectorOffset(y);
  return ox >= 4 && ox <= 6 && oy >= 4 && oy <= 6;
}

/** Upstream `utils.isVeryCenter`: the sector center room. */
export function isVeryCenter(x: number, y: number): boolean {
  return sectorOffset(x) === 5 && sectorOffset(y) === 5;
}

/** Room name of the center (`xx5yy5`) of the sector containing a room. */
export function sectorCenterOf(roomName: string): string {
  const match = ROOM_NAME.exec(roomName);
  if (!match) {
    throw new Error(`Invalid room name ${roomName}`);
  }
  const [, h, x, v, y] = match as unknown as [string, string, string, string, string];
  return `${h}${x.slice(0, -1)}5${v}${y.slice(0, -1)}5`;
}

export function isSectorCenterName(roomName: string): boolean {
  return /^[WE]\d*5[NS]\d*5$/.test(roomName);
}

export function isWallAt(terrain: string, x: number, y: number): boolean {
  return (Number(terrain.charAt(y * 50 + x)) & C.TERRAIN_MASK_WALL) > 0;
}

/** Objects of one room, in insertion order. */
export function roomObjectsOf(world: WorldState, roomName: string): RoomObject[] {
  return Object.values(world.roomObjects).filter((object) => object.room === roomName);
}

/** Upstream `utils.activateRoom` (`env.sadd(ACTIVE_ROOMS)`). */
export function activateRoom(world: WorldState, roomName: string): void {
  if (!world.activeRooms.includes(roomName)) {
    world.activeRooms.push(roomName);
  }
}

/** Next document id, the same 24-hex-digit monotonic scheme the engine uses. */
export function nextId(world: WorldState, collection: Readonly<Record<string, unknown>>): string {
  for (;;) {
    world.idCounter++;
    const id = world.idCounter.toString(16).padStart(24, '0');
    if (!Object.hasOwn(collection, id)) {
      return id;
    }
  }
}

/** Insert a room object (without `_id`) and return the stored document. */
export function insertObject(world: WorldState, object: Omit<RoomObject, '_id'>): RoomObject {
  const doc = { ...object, _id: nextId(world, world.roomObjects) };
  world.roomObjects[doc._id] = doc;
  return doc;
}

/** Driver accessible rooms rule: status `normal` and already open. */
export function isAccessible(room: RoomInfo, now: number): boolean {
  return room.status === 'normal' && !(room.openTime && room.openTime >= now);
}
