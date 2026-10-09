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

/** HTTP adapter of the game's power creep account operations. */
@Injectable()
export class PowerService {
  constructor(@Inject(SERVER_CONTEXT) readonly context: ApiContext) {}

  list(request: ApiRequest): {
    list: Array<PowerCreepDoc | SpawnedPowerCreep>;
  } {
    const user = requireUser(request, this.context);
    return { list: listPowerCreeps(this.context.state.world, user._id) };
  }

  create(request: ApiRequest): PowerCreepDoc {
    const user = requireUser(request, this.context);
    return createPowerCreep(this.context.state, user._id, {
      className: stringParam(request.body['className']),
      name: request.body['name'],
    });
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
