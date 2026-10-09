/*
 * `/assets` of the official client (backend `app.use('/assets', express.static(ASSET_DIR))`).
 *
 * The client loads world map terrain from `/assets/map/<room>.png` (room view background and
 * map zoom 3) and `/assets/map/zoom2/<room>.png` (map zoom 2; private servers never use zoom 1).
 * Upstream rendered these files with `utils.writeTerrainToPng` whenever a room was generated
 * (`map.updateRoomImageAssets`); here they are rendered on demand from the committed world
 * terrain, so they can never be missing or stale. Other paths are served from the optional
 * operator asset directory (mod renderer resources use `{ASSETS_URL}`).
 */

import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { extname, join, relative, isAbsolute } from 'node:path';
import { constants as C } from '@openscreeps/game';
import { PNG } from 'pngjs';
import { roomNameFromXY, roomNameToXY } from '@openscreeps/game';
import type { ServerContext } from './contracts.ts';

export interface Asset {
  body: Buffer;
  contentType: string;
}

const ROOM_SIZE = 50;
/** Room images are drawn 3 pixels per tile (`writeTerrainToPng(..., zoomIn = true)`). */
const ROOM_IMAGE_SCALE = 3;
/** Zoom 2 images hold 4x4 rooms at one pixel per tile, named after the top-left room. */
const SECTOR_ROOMS = 4;
const ROOM_IMAGE = /^map\/([WE]\d+[NS]\d+)\.png$/;
const SECTOR_IMAGE = /^map\/zoom2\/([WE]\d+[NS]\d+)\.png$/;

/** `utils.createTerrainColorsMap`. */
const WALL_COLOR = [0, 0, 0] as const;
const SWAMP_COLOR = [35, 37, 19] as const;
const EXIT_COLOR = [50, 50, 50] as const;
const PLAIN_COLOR = [43, 43, 43] as const;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** Rendered images by path, valid while the terrain they were rendered from is unchanged. */
const rendered = new Map<string, { terrain: string; asset: Asset }>();

function paintRoom(image: PNG, terrain: string, left: number, top: number, scale: number): void {
  for (let y = 0; y < ROOM_SIZE; y++) {
    for (let x = 0; x < ROOM_SIZE; x++) {
      const code = Number.parseInt(terrain.charAt(y * ROOM_SIZE + x), 10);
      const color =
        code & C.TERRAIN_MASK_WALL
          ? WALL_COLOR
          : code & C.TERRAIN_MASK_SWAMP
            ? SWAMP_COLOR
            : x === 0 || y === 0 || x === ROOM_SIZE - 1 || y === ROOM_SIZE - 1
              ? EXIT_COLOR
              : PLAIN_COLOR;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const offset = ((top + y * scale + dy) * image.width + left + x * scale + dx) * 4;
          image.data[offset] = color[0];
          image.data[offset + 1] = color[1];
          image.data[offset + 2] = color[2];
          image.data[offset + 3] = 255;
        }
      }
    }
  }
}

/** `map/<room>.png`: the room at three pixels per tile (150x150). */
export function renderRoomImage(terrain: string): Buffer {
  const size = ROOM_SIZE * ROOM_IMAGE_SCALE;
  const image = new PNG({ width: size, height: size });
  paintRoom(image, terrain, 0, 0, ROOM_IMAGE_SCALE);
  return PNG.sync.write(image);
}

/** Names of the 4x4 block of rooms in a zoom 2 image, row by row, starting at its top-left room. */
function sectorRooms(firstRoom: string): string[] {
  const [x, y] = roomNameToXY(firstRoom);
  const rooms: string[] = [];
  for (let dy = 0; dy < SECTOR_ROOMS; dy++) {
    for (let dx = 0; dx < SECTOR_ROOMS; dx++) rooms.push(roomNameFromXY(x + dx, y + dy));
  }
  return rooms;
}

/** Top-left room of the zoom 2 image containing a room (`map.updateRoomImageAssets`). */
export function sectorImageRoom(roomName: string): string {
  const [x, y] = roomNameToXY(roomName);
  return roomNameFromXY(
    Math.floor(x / SECTOR_ROOMS) * SECTOR_ROOMS,
    Math.floor(y / SECTOR_ROOMS) * SECTOR_ROOMS,
  );
}

/**
 * `map/zoom2/<room>.png`: 4x4 rooms at one pixel per tile (200x200), transparent where a room
 * has no terrain. `terrains` follows `sectorRooms` order.
 */
export function renderSectorImage(terrains: ReadonlyArray<string | undefined>): Buffer {
  const size = ROOM_SIZE * SECTOR_ROOMS;
  const image = new PNG({ width: size, height: size });
  terrains.forEach((terrain, index) => {
    if (terrain === undefined) return;
    paintRoom(
      image,
      terrain,
      (index % SECTOR_ROOMS) * ROOM_SIZE,
      Math.floor(index / SECTOR_ROOMS) * ROOM_SIZE,
      1,
    );
  });
  return PNG.sync.write(image);
}

/** A rendered terrain image of the committed world, or `undefined` if no room it shows exists. */
async function terrainAsset(context: ServerContext, path: string): Promise<Asset | undefined> {
  let rooms: string[];
  const room = ROOM_IMAGE.exec(path)?.[1];
  if (room !== undefined) {
    rooms = [room];
  } else {
    // Only block-aligned names exist, like the files upstream wrote.
    const sector = SECTOR_IMAGE.exec(path)?.[1];
    if (sector === undefined || sectorImageRoom(sector) !== sector) return undefined;
    rooms = sectorRooms(sector);
  }
  const terrains = await context.read(() => rooms.map((name) => context.state.world.terrain[name]));
  if (terrains.every((terrain) => terrain === undefined)) return undefined;
  const key = terrains.map((terrain) => terrain ?? '').join('|');
  const cached = rendered.get(path);
  if (cached?.terrain === key) return cached.asset;
  const body = room === undefined ? renderSectorImage(terrains) : renderRoomImage(key);
  const asset: Asset = { body, contentType: 'image/png' };
  rendered.set(path, { terrain: key, asset });
  return asset;
}

/** A file below the operator asset directory, never following a path outside of it. */
async function directoryAsset(
  directory: string,
  segments: readonly string[],
): Promise<Asset | undefined> {
  try {
    const root = await realpath(directory);
    const target = await realpath(join(root, ...segments));
    const inside = relative(root, target);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) return undefined;
    if (!(await stat(target)).isFile()) return undefined;
    return {
      body: await readFile(target),
      contentType: CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
    };
  } catch {
    return undefined;
  }
}

/**
 * Resolve `GET /assets/<path>`. `path` is the decoded path below `/assets/`, without query.
 * `undefined` means not found. Call outside a context read/mutate callback.
 */
export async function getAsset(context: ServerContext, path: string): Promise<Asset | undefined> {
  const segments = path.split('/');
  // Like `express.static` (dotfiles ignored), and never a path a segment could redirect.
  if (segments.some((segment) => !segment || segment.startsWith('.') || /[\\:\0]/.test(segment))) {
    return undefined;
  }
  const generated = await terrainAsset(context, path);
  if (generated) return generated;
  const directory = context.config.assetDirectory;
  return directory === undefined ? undefined : directoryAsset(directory, segments);
}

/**
 * Write a room's terrain images into an asset directory (upstream `map.updateRoomImageAssets`):
 * `map/<room>.png` and the `map/zoom2/` image containing it.
 */
export async function writeRoomImageAssets(
  directory: string,
  terrain: Readonly<Record<string, string>>,
  roomName: string,
): Promise<void> {
  const roomTerrain = terrain[roomName];
  if (roomTerrain === undefined) throw new Error(`Room ${roomName} has no terrain`);
  const firstRoom = sectorImageRoom(roomName);
  await mkdir(join(directory, 'map', 'zoom2'), { recursive: true });
  await writeFile(join(directory, 'map', `${roomName}.png`), renderRoomImage(roomTerrain));
  await writeFile(
    join(directory, 'map', 'zoom2', `${firstRoom}.png`),
    renderSectorImage(sectorRooms(firstRoom).map((name) => terrain[name])),
  );
}
