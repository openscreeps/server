/*
 * Bot players and respawn, ported from screeps/backend `lib/cli/bots.js` and `lib/utils.js`
 * (loadBot, reloadBotUsers, respawnUser, getUserWorldStatus).
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { constants as C, type CodeModules, type WorldState } from '@openscreeps/engine';
import type { Badge } from '../api/badge.ts';
import { createUser, findUserByUsername } from '../api/users.ts';
import { newId, type ServerContext, type ServerState } from '../contracts.ts';
import { ensureSystemUser } from './generate.ts';
import { WorldRandom } from './random.ts';
import { activateRoom, insertObject, isWallAt, nextId } from './rooms.ts';

const BOY_NAMES = [
  'Jackson',
  'Aiden',
  'Liam',
  'Lucas',
  'Noah',
  'Mason',
  'Jayden',
  'Ethan',
  'Jacob',
  'Jack',
  'Caden',
  'Logan',
  'Benjamin',
  'Michael',
  'Caleb',
  'Ryan',
  'Alexander',
  'Elijah',
  'James',
  'William',
  'Oliver',
  'Connor',
  'Matthew',
  'Daniel',
  'Luke',
  'Brayden',
  'Jayce',
  'Henry',
  'Carter',
  'Dylan',
  'Gabriel',
  'Joshua',
  'Nicholas',
  'Isaac',
  'Owen',
  'Nathan',
  'Grayson',
  'Eli',
  'Landon',
  'Andrew',
  'Max',
  'Samuel',
  'Gavin',
  'Wyatt',
  'Christian',
  'Hunter',
  'Cameron',
  'Evan',
  'Charlie',
  'David',
  'Sebastian',
  'Joseph',
  'Dominic',
  'Anthony',
  'Colton',
  'John',
  'Tyler',
  'Zachary',
  'Thomas',
  'Julian',
  'Levi',
  'Adam',
  'Isaiah',
  'Alex',
  'Aaron',
  'Parker',
  'Cooper',
  'Miles',
  'Chase',
  'Muhammad',
  'Christopher',
  'Blake',
  'Austin',
  'Jordan',
  'Leo',
  'Jonathan',
  'Adrian',
  'Colin',
  'Hudson',
  'Ian',
  'Xavier',
  'Camden',
  'Tristan',
  'Carson',
  'Jason',
  'Nolan',
  'Riley',
  'Lincoln',
  'Brody',
  'Bentley',
  'Nathaniel',
  'Josiah',
  'Declan',
  'Jake',
  'Asher',
  'Jeremiah',
  'Cole',
  'Mateo',
  'Micah',
  'Elliot',
];
const GIRL_NAMES = [
  'Sophia',
  'Emma',
  'Olivia',
  'Isabella',
  'Mia',
  'Ava',
  'Lily',
  'Zoe',
  'Emily',
  'Chloe',
  'Layla',
  'Madison',
  'Madelyn',
  'Abigail',
  'Aubrey',
  'Charlotte',
  'Amelia',
  'Ella',
  'Kaylee',
  'Avery',
  'Aaliyah',
  'Hailey',
  'Hannah',
  'Addison',
  'Riley',
  'Harper',
  'Aria',
  'Arianna',
  'Mackenzie',
  'Lila',
  'Evelyn',
  'Adalyn',
  'Grace',
  'Brooklyn',
  'Ellie',
  'Anna',
  'Kaitlyn',
  'Isabelle',
  'Sophie',
  'Scarlett',
  'Natalie',
  'Leah',
  'Sarah',
  'Nora',
  'Mila',
  'Elizabeth',
  'Lillian',
  'Kylie',
  'Audrey',
  'Lucy',
  'Maya',
  'Annabelle',
  'Makayla',
  'Gabriella',
  'Elena',
  'Victoria',
  'Claire',
  'Savannah',
  'Peyton',
  'Maria',
  'Alaina',
  'Kennedy',
  'Stella',
  'Liliana',
  'Allison',
  'Samantha',
  'Keira',
  'Alyssa',
  'Reagan',
  'Molly',
  'Alexandra',
  'Violet',
  'Charlie',
  'Julia',
  'Sadie',
  'Ruby',
  'Eva',
  'Alice',
  'Eliana',
  'Taylor',
  'Callie',
  'Penelope',
  'Camilla',
  'Bailey',
  'Kaelyn',
  'Alexis',
  'Kayla',
  'Katherine',
  'Sydney',
  'Lauren',
  'Jasmine',
  'London',
  'Bella',
  'Adeline',
  'Caroline',
  'Vivian',
  'Juliana',
  'Gianna',
  'Skyler',
  'Jordyn',
];

/**
 * Upstream `utils.loadBot`: the `*.js` files of a bot AI directory as code modules (`main.js`
 * required). Module names keep their dots (`role.harvester.js` -> `role.harvester`).
 */
export function loadBotModules(directory: string): CodeModules {
  if (!statSync(directory).isDirectory()) {
    throw new Error(`"${directory}" is not a directory`);
  }
  statSync(resolve(directory, 'main.js'));
  const modules: CodeModules = {};
  for (const file of readdirSync(directory)) {
    const match = /^(.*)\.js$/.exec(file);
    if (match?.[1] !== undefined) {
      modules[match[1]] = readFileSync(resolve(directory, file), { encoding: 'utf8' });
    }
  }
  return modules;
}

function genRandomUserName(state: ServerState, random: WorldRandom): string {
  for (let c = 0; ; c++) {
    const list = random.next() > 0.5 ? BOY_NAMES : GIRL_NAMES;
    let name = list[random.index(list.length)] as string;
    if (c > 3) {
      name += list[random.index(list.length)] as string;
    }
    if (!findUserByUsername(state, `${name}Bot`)) {
      return `${name}Bot`;
    }
  }
}

function genRandomBadge(random: WorldRandom): Badge {
  const color = (): string => `#${Math.floor(random.next() * 0xffffff).toString(16)}`;
  return {
    type: random.index(24) + 1,
    color1: color(),
    color2: color(),
    color3: color(),
    flip: random.next() > 0.5,
    param: random.index(200) - 100,
  };
}

export interface SpawnBotOptions {
  /** Bot player name; default randomly generated `<Name>Bot`. */
  username?: string;
  /** CPU limit; default 100. */
  cpu?: number;
  /** Global Control Level; default 1. */
  gcl?: number;
  /** Spawn position; default random non-wall tile. */
  x?: number;
  y?: number;
}

/**
 * Upstream `bots.spawn`: create an NPC player running `modules` and give it a spawn and the
 * controller of an unowned room. Lock-held; returns the new user id and name.
 */
export function spawnBot(
  context: ServerContext,
  botAiName: string,
  modules: CodeModules,
  roomName: string,
  options: SpawnBotOptions = {},
): { userId: string; username: string } {
  const { state } = context;
  const world = state.world;
  const random = new WorldRandom(world);
  const controller = Object.values(world.roomObjects).find(
    (o) => o.room === roomName && o.type === 'controller',
  );
  if (!controller) {
    throw new Error(`Room controller not found in ${roomName}`);
  }
  if (controller.user) {
    throw new Error(`Room ${roomName} is already owned`);
  }
  const terrain = world.terrain[roomName];
  if (terrain === undefined) {
    throw new Error(`Room terrain not found in ${roomName}`);
  }
  if (options.username !== undefined && findUserByUsername(state, options.username)) {
    throw new Error(`User with the name "${options.username}" already exists`);
  }
  const occupied = (x: number, y: number): boolean =>
    isWallAt(terrain, x, y) ||
    Object.values(world.roomObjects).some((o) => o.room === roomName && o.x === x && o.y === y);
  for (const coord of [options.x, options.y]) {
    if (coord !== undefined && (!Number.isInteger(coord) || coord < 1 || coord > 48)) {
      throw new Error(`Invalid spawn position ${String(coord)}`);
    }
  }
  // upstream: the requested coordinates first, then random tiles in 3..48 until one is free
  let x = options.x ?? Math.floor(3 + random.next() * 46);
  let y = options.y ?? Math.floor(3 + random.next() * 46);
  for (let tries = 0; occupied(x, y); tries++) {
    if (tries > 10000) {
      throw new Error(`No free spawn position in ${roomName}`);
    }
    x = Math.floor(3 + random.next() * 46);
    y = Math.floor(3 + random.next() * 46);
  }

  const username = options.username ?? genRandomUserName(state, random);
  const user = createUser(context, {
    username,
    cpu: options.cpu || 100,
    gcl: options.gcl ? C.GCL_MULTIPLY * Math.pow(options.gcl - 1, C.GCL_POW) : 0,
    cpuAvailable: 0,
    bot: botAiName,
    active: 10000,
    badge: genRandomBadge(random),
    modules,
  });
  insertObject(world, {
    type: 'spawn',
    room: roomName,
    x,
    y,
    name: 'Spawn1',
    user: user._id,
    store: { energy: C.SPAWN_ENERGY_START },
    storeCapacityResource: { energy: C.SPAWN_ENERGY_CAPACITY },
    hits: C.SPAWN_HITS,
    hitsMax: C.SPAWN_HITS,
    spawning: null,
    notifyWhenAttacked: false,
  });
  controller.user = user._id;
  controller.level = 1;
  controller.progress = 0;
  controller.downgradeTime = null;
  controller.safeMode = world.gameTime + 20000;
  user.rooms = [roomName];
  const room = world.rooms[roomName];
  if (room) {
    room.invaderGoal = 1000000;
  }
  activateRoom(world, roomName);
  return { userId: user._id, username };
}

/**
 * Upstream `utils.reloadBotUsers`: every player of a bot AI gets a fresh `t<timestamp>` branch
 * with `modules` (active in world and simulation) replacing its other branches. Returns the
 * reloaded usernames.
 */
export function reloadBot(
  context: ServerContext,
  botAiName: string,
  modules: CodeModules,
): string[] {
  const { state } = context;
  const users = Object.values(state.world.users).filter((user) => user.bot === botAiName);
  const timestamp = context.now();
  const branch = `t${String(timestamp)}`;
  for (const user of users) {
    for (const [id, existing] of Object.entries(state.branches)) {
      if (existing.user === user._id) {
        Reflect.deleteProperty(state.branches, id);
      }
    }
    const id = newId(state);
    state.branches[id] = {
      _id: id,
      user: user._id,
      branch,
      modules: structuredClone(modules),
      activeWorld: true,
      activeSim: true,
      timestamp,
    };
    context.runtime.setCode(user._id, modules, branch);
  }
  return users.map((user) => user.username ?? user._id);
}

/** Upstream `bots.removeUser`: respawn a bot player and delete it with its code and memory. */
export function removeBot(context: ServerContext, username: string): void {
  const { state } = context;
  const user = findUserByUsername(state, username);
  if (!user) {
    throw new Error('User not found');
  }
  if (!user.bot) {
    throw new Error('User is not a bot');
  }
  respawnUser(state, user._id);
  Reflect.deleteProperty(state.world.users, user._id);
  Reflect.deleteProperty(state.profiles, user._id);
  for (const [id, branch] of Object.entries(state.branches)) {
    if (branch.user === user._id) {
      Reflect.deleteProperty(state.branches, id);
    }
  }
  for (const [hash, token] of Object.entries(state.tokens)) {
    if (token.userId === user._id) {
      Reflect.deleteProperty(state.tokens, hash);
    }
  }
  context.runtime.removeUser(user._id);
  context.publish('auth:revoked', { user: user._id });
}

/**
 * Upstream `utils.respawnUser`: remove the player's creeps, power creeps and construction sites,
 * turn its structures into ruins of the system user, release its controllers and flags.
 */
export function respawnUser(state: ServerState, userId: string): void {
  const world = state.world;
  const systemUserId = ensureSystemUser(world);
  const gameTime = world.gameTime;
  const touchedRooms = new Set<string>();
  const structureTypes = new Set<string>(Object.keys(C.CONSTRUCTION_COST));

  for (const [id, creep] of Object.entries(world.userPowerCreeps)) {
    if (creep.user === userId) {
      Reflect.deleteProperty(world.userPowerCreeps, id);
    }
  }
  const owned = Object.values(world.roomObjects).filter((o) => o.user === userId);
  for (const object of owned) {
    touchedRooms.add(object.room);
    if (object.type === 'controller') {
      continue;
    }
    if (object.type === 'ruin') {
      object.user = systemUserId;
      if (object.structure) {
        object.structure.user = systemUserId;
      }
      continue;
    }
    Reflect.deleteProperty(world.roomObjects, object._id);
    if (structureTypes.has(object.type)) {
      const ruin = {
        type: 'ruin',
        user: systemUserId,
        room: object.room,
        x: object.x,
        y: object.y,
        structure: {
          id: object._id,
          type: object.type,
          hits: 0,
          hitsMax: object.hitsMax,
          user: systemUserId,
        },
        store: object.store ?? {},
        destroyTime: gameTime,
        decayTime: gameTime + 500000,
      };
      const id = nextId(world, world.roomObjects);
      world.roomObjects[id] = { ...ruin, _id: id };
    }
  }
  for (const [id, flag] of Object.entries(world.flags)) {
    if (flag.user === userId) {
      Reflect.deleteProperty(world.flags, id);
    }
  }
  for (const controller of owned.filter((o) => o.type === 'controller')) {
    const room = world.rooms[controller.room];
    if (room) {
      room.status = 'normal';
    }
    Object.assign(controller, {
      level: 0,
      hits: 0,
      hitsMax: 0,
      progress: 0,
      progressTotal: 0,
      user: null,
      downgradeTime: null,
      safeMode: null,
      safeModeAvailable: 0,
      safeModeCooldown: null,
      isPowerEnabled: false,
    });
  }
  const user = world.users[userId];
  if (user) {
    user.rooms = [];
  }
  for (const room of touchedRooms) {
    activateRoom(world, room);
  }
}

/** Upstream `utils.getUserWorldStatus`. */
export function getUserWorldStatus(world: WorldState, userId: string): 'empty' | 'normal' | 'lost' {
  const objects = Object.values(world.roomObjects).filter((o) => o.user === userId);
  if (!objects.length) {
    return 'empty';
  }
  const spawns = objects.some(
    (spawn) =>
      spawn.type === 'spawn' &&
      objects.some(
        (o) => o.type === 'controller' && o.room === spawn.room && o.user === spawn.user,
      ),
  );
  return spawns ? 'normal' : 'lost';
}
