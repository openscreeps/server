import { Inject, Injectable } from '@nestjs/common';
import {
  cancelPowerCreepDelete,
  createPowerCreep,
  deletePowerCreep,
  listPowerCreeps,
  renamePowerCreep,
  startPowerExperimentation,
  upgradePowerCreep,
  type PowerCreepDoc,
  type SpawnedPowerCreep,
} from '@openscreeps/game';
import { requireUser, type ApiContext, type ApiRequest } from '../contracts.ts';
import { stringParam } from '../api/gameplay-support.ts';
import { isRecord } from '../api/guards.ts';
import { SERVER_CONTEXT } from '../api/transport.ts';
import type { ApiOperationResult } from '../api/operations.ts';

/** Spawned room-object overlays must retain the account document's required public fields. */
function assertPowerView(
  creep: PowerCreepDoc | SpawnedPowerCreep,
): asserts creep is PowerCreepDoc & { className: 'operator' } {
  if (
    creep.className !== 'operator' ||
    typeof creep.user !== 'string' ||
    typeof creep.name !== 'string' ||
    typeof creep.level !== 'number' ||
    typeof creep.hitsMax !== 'number' ||
    creep.store === undefined ||
    typeof creep.storeCapacity !== 'number' ||
    (creep.spawnCooldownTime !== null && typeof creep.spawnCooldownTime !== 'number') ||
    creep.powers === undefined
  ) {
    throw new Error('Invalid power creep account projection');
  }
}

function assertPowerViews(
  creeps: Array<PowerCreepDoc | SpawnedPowerCreep>,
): asserts creeps is Array<PowerCreepDoc & { className: 'operator' }> {
  for (const creep of creeps) assertPowerView(creep);
}

/** HTTP adapter of the game's power creep account operations. */
@Injectable()
export class PowerService {
  constructor(@Inject(SERVER_CONTEXT) readonly context: ApiContext) {}

  list(request: ApiRequest): ApiOperationResult<'powerCreepsList'> {
    const user = requireUser(request, this.context);
    const list = listPowerCreeps(this.context.state.world, user._id);
    assertPowerViews(list);
    return { list };
  }

  create(request: ApiRequest): ApiOperationResult<'powerCreepsCreate'> {
    const user = requireUser(request, this.context);
    const creep = createPowerCreep(this.context.state, user._id, {
      className: stringParam(request.body['className']),
      name: request.body['name'],
    });
    assertPowerView(creep);
    return creep;
  }

  delete(request: ApiRequest) {
    const user = requireUser(request, this.context);
    deletePowerCreep(this.context, user._id, stringParam(request.body['id']));
    return {};
  }

  cancelDelete(request: ApiRequest) {
    const user = requireUser(request, this.context);
    cancelPowerCreepDelete(this.context.state, user._id, stringParam(request.body['id']));
    return {};
  }

  upgrade(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const powers = request.body['powers'];
    upgradePowerCreep(this.context.state, user._id, {
      id: stringParam(request.body['id']),
      powers: isRecord(powers) ? powers : undefined,
    });
    return {};
  }

  rename(request: ApiRequest) {
    const user = requireUser(request, this.context);
    renamePowerCreep(this.context.state, user._id, {
      id: stringParam(request.body['id']),
      name: request.body['name'],
    });
    return {};
  }

  experimentation(request: ApiRequest) {
    const user = requireUser(request, this.context);
    startPowerExperimentation(this.context, user._id);
    return {};
  }
}
