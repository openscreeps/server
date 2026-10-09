import { constants as C } from '@openscreeps/engine';
import { ApiError, newId, requireUser, type ApiRoute, type User } from '../contracts.ts';
import { isRecord } from './guards.ts';
import { ownValue, type World } from './gameplay-support.ts';

type PowerCreepDoc = World['userPowerCreeps'][string];
type PowerLevels = PowerCreepDoc['powers'];

const POWER_INFO: Readonly<
  Record<string, { readonly className: string; readonly level: readonly number[] }>
> = C.POWER_INFO;
const POWER_CLASSES: readonly string[] = Object.values(C.POWER_CLASS);
const MAX_POWER_LEVEL = 5;
const EXPERIMENTATION_DURATION = 24 * 3600 * 1000;

function userPowerCreeps(world: World, userId: string): PowerCreepDoc[] {
  return Object.values(world.userPowerCreeps).filter((creep) => creep.user === userId);
}

/** Upstream `calcFreePowerLevels`: GPL minus one level per creep and every upgraded creep level. */
function freePowerLevels(user: User, creeps: readonly PowerCreepDoc[]): number {
  const level = Math.floor(
    Math.pow((user.power || 0) / C.POWER_LEVEL_MULTIPLY, 1 / C.POWER_LEVEL_POW),
  );
  return level - creeps.length - creeps.reduce((sum, creep) => sum + creep.level, 0);
}

/** A power creep of the caller, or `invalid id` (never reveals other players' creeps). */
function ownPowerCreep(world: World, userId: string, id: unknown): PowerCreepDoc {
  const creep = ownValue(world.userPowerCreeps, id);
  if (!creep || creep.user !== userId) {
    throw new ApiError('invalid id');
  }
  return creep;
}

/** Power creep names: upstream `("" + name).substring(0, 50)`, restricted to non-empty strings. */
function readName(value: unknown): string {
  if (typeof value !== 'string' || !value.length) {
    throw new ApiError('invalid name');
  }
  return value.substring(0, 50);
}

function isSpawned(creep: PowerCreepDoc): boolean {
  return creep.spawnCooldownTime === null || !!creep.shard;
}

/**
 * Upstream `powersAreValid`: the requested levels must be reachable by taking one power level at a
 * time, each only once the creep level reaches that power's level requirement.
 */
function powersAreValid(powers: Readonly<Record<string, number>>): boolean {
  const finalLevel = Object.values(powers).reduce((sum, value) => sum + value, 0);
  const levels: Record<string, number> = {};
  for (const power of Object.keys(POWER_INFO)) {
    levels[power] = 0;
  }
  let level = 0;
  while (level < finalLevel) {
    const power = Object.keys(powers).find((key) => {
      const current = levels[key] ?? 0;
      const required = POWER_INFO[key]?.level[current];
      return (
        current < MAX_POWER_LEVEL &&
        current < (powers[key] ?? 0) &&
        required !== undefined &&
        required <= level
      );
    });
    if (power === undefined) {
      return false;
    }
    levels[power] = (levels[power] ?? 0) + 1;
    level = Object.values(levels).reduce((sum, value) => sum + value, 0);
  }
  return true;
}

/** Validates an upgrade request exactly like upstream `/upgrade`, returning the new power levels. */
function readUpgrade(creep: PowerCreepDoc, input: unknown): Record<string, number> {
  if (!isRecord(input)) {
    throw new ApiError('invalid powers');
  }
  const powers: Record<string, number> = {};
  for (const [power, value] of Object.entries(input)) {
    const info = ownValue(POWER_INFO, power);
    if (!info) {
      throw new ApiError(`invalid power ${power}`);
    }
    if (info.className !== creep.className) {
      throw new ApiError(`invalid class for power ${power}`);
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new ApiError(`invalid value for power ${power}`);
    }
    if (value < (ownValue(creep.powers, power)?.level ?? 0)) {
      throw new ApiError(`cannot downgrade power ${power}`);
    }
    if (value > MAX_POWER_LEVEL) {
      throw new ApiError(`invalid max value for power ${power}`);
    }
    powers[power] = value;
  }
  for (const [power, info] of Object.entries(creep.powers)) {
    if ((ownValue(powers, power) ?? 0) < info.level) {
      throw new ApiError(`cannot downgrade power ${power}`);
    }
  }
  const newLevel = Object.values(powers).reduce((sum, value) => sum + value, 0);
  if (newLevel > C.POWER_CREEP_MAX_LEVEL) {
    throw new ApiError('max level');
  }
  for (const [power, value] of Object.entries(powers)) {
    const required = POWER_INFO[power]?.level[value - 1];
    if (value !== 0 && required !== undefined && newLevel < required) {
      throw new ApiError(`not enough level for power ${power}`);
    }
  }
  if (!powersAreValid(powers)) {
    throw new ApiError('powers set is not valid');
  }
  return powers;
}

/** Upstream `$merge` of `{level}` into each upgraded power (existing cooldowns are kept). */
function mergePowers(
  current: PowerLevels | undefined,
  powers: Readonly<Record<string, number>>,
): PowerLevels {
  const merged: PowerLevels = {};
  for (const [power, info] of Object.entries(current ?? {})) {
    merged[power] = { ...info };
  }
  for (const [power, level] of Object.entries(powers)) {
    if (level !== 0) {
      merged[power] = { ...ownValue(merged, power), level };
    }
  }
  return merged;
}

export const powerRoutes: readonly ApiRoute[] = [
  {
    method: 'GET',
    path: '/api/game/power-creeps/list',
    auth: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { world } = context.state;
      return {
        list: userPowerCreeps(world, user._id).map((creep) => {
          const object = ownValue(world.roomObjects, creep._id);
          return object?.type === 'powerCreep' && object.user === user._id
            ? { ...creep, ...object }
            : { ...creep };
        }),
      };
    },
  },
  {
    method: 'POST',
    path: '/api/game/power-creeps/create',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { state } = context;
      const creeps = userPowerCreeps(state.world, user._id);
      if (freePowerLevels(user, creeps) <= 0) {
        throw new ApiError('not enough power level');
      }
      const className = request.body['className'];
      if (typeof className !== 'string' || !POWER_CLASSES.includes(className)) {
        throw new ApiError('invalid class');
      }
      const name = readName(request.body['name']);
      if (creeps.some((creep) => creep.name === name)) {
        throw new ApiError('name already exists');
      }
      const creep: PowerCreepDoc = {
        _id: newId(state),
        name,
        className,
        user: user._id,
        level: 0,
        hitsMax: 1000,
        store: {},
        storeCapacity: 100,
        spawnCooldownTime: 0,
        powers: {},
      };
      state.world.userPowerCreeps[creep._id] = creep;
      return { ...creep };
    },
  },
  {
    method: 'POST',
    path: '/api/game/power-creeps/delete',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { world } = context.state;
      const creep = ownPowerCreep(world, user._id, request.body['id']);
      if (isSpawned(creep)) {
        throw new ApiError('spawned');
      }
      if (creep.deleteTime) {
        throw new ApiError('already being deleted');
      }
      const now = context.now();
      if ((user.powerExperimentationTime || 0) > now) {
        Reflect.deleteProperty(world.userPowerCreeps, creep._id);
      } else {
        creep.deleteTime = now + C.POWER_CREEP_DELETE_COOLDOWN;
      }
      return {};
    },
  },
  {
    method: 'POST',
    path: '/api/game/power-creeps/cancel-delete',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const creep = ownPowerCreep(context.state.world, user._id, request.body['id']);
      if (!creep.deleteTime) {
        throw new ApiError('not being deleted');
      }
      delete creep.deleteTime;
      return {};
    },
  },
  {
    method: 'POST',
    path: '/api/game/power-creeps/upgrade',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { world } = context.state;
      const creeps = userPowerCreeps(world, user._id);
      const creep = ownPowerCreep(world, user._id, request.body['id']);
      const powers = readUpgrade(creep, request.body['powers']);
      const level = Object.values(powers).reduce((sum, value) => sum + value, 0);
      if (freePowerLevels(user, creeps) < level - creep.level) {
        throw new ApiError('not enough power level');
      }
      const hitsMax = 1000 * (level + 1);
      const storeCapacity = 100 * (level + 1);
      Object.assign(creep, {
        powers: mergePowers(creep.powers, powers),
        level,
        hitsMax,
        storeCapacity,
      });
      const object = ownValue(world.roomObjects, creep._id);
      if (object?.type === 'powerCreep' && object.user === user._id) {
        Object.assign(object, {
          powers: mergePowers(object.powers, powers),
          level,
          hitsMax,
          storeCapacity,
        });
      }
      return {};
    },
  },
  {
    method: 'POST',
    path: '/api/game/power-creeps/rename',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { world } = context.state;
      const creep = ownPowerCreep(world, user._id, request.body['id']);
      if (isSpawned(creep)) {
        throw new ApiError('spawned');
      }
      const name = readName(request.body['name']);
      if (userPowerCreeps(world, user._id).some((other) => other.name === name)) {
        throw new ApiError('name already exists');
      }
      creep.name = name;
      return {};
    },
  },
  {
    method: 'POST',
    path: '/api/game/power-creeps/experimentation',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      if ((user.powerExperimentations || 0) <= 0) {
        throw new ApiError('no power resets');
      }
      user.powerExperimentations = (user.powerExperimentations || 0) - 1;
      user.powerExperimentationTime = context.now() + EXPERIMENTATION_DURATION;
      return {};
    },
  },
];
