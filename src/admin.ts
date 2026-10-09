/*
 * Authenticated administrative API: `POST /admin` with `{action, ...arguments}` and a bearer
 * administrator token. Every world change runs as one serialized, durably committed kernel
 * mutation; inputs are validated before any mutation starts and never name server-side files.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Post,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { GameError } from '@openscreeps/game';
import type { Request, Response } from 'express';
import { ApiError, type ApiContext } from './contracts.ts';
import { SERVER_CONTEXT, secretsEqual } from './api/transport.ts';
import { AdminService, invalid } from './services/admin.service.ts';

/** Bearer administrator token only; player session tokens never grant access. Fails closed. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(SERVER_CONTEXT) readonly context: ApiContext) {}

  canActivate(execution: ExecutionContext): boolean {
    const expected = this.context.config.adminToken;
    if (expected === undefined || expected.length < 32) {
      throw new HttpException({ error: 'admin API disabled' }, HttpStatus.FORBIDDEN);
    }
    const http = execution.switchToHttp();
    const authorization = http.getRequest<Request>().get('Authorization');
    if (!authorization?.startsWith('Bearer ')) {
      http.getResponse<Response>().set('WWW-Authenticate', 'Bearer');
      throw new HttpException({ error: 'unauthorized' }, HttpStatus.UNAUTHORIZED);
    }
    if (!secretsEqual(authorization.slice(7), expected)) {
      throw new HttpException({ error: 'forbidden' }, HttpStatus.FORBIDDEN);
    }
    return true;
  }
}

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(@Inject(AdminService) readonly admin: AdminService) {}

  @Get('status')
  async status(): Promise<Record<string, unknown>> {
    return { ok: 1, ...(await adminErrors(() => this.admin.status())) };
  }

  @Post()
  @HttpCode(200)
  async command(@Body() body: unknown): Promise<Record<string, unknown>> {
    return { ok: 1, ...(await adminErrors(() => this.admin.execute(body))) };
  }
}

/**
 * Account helpers use protocol-style ApiErrors (status 200) and game operations GameErrors; the
 * admin API reports both as 400.
 */
async function adminErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GameError || (error instanceof ApiError && error.status < 400)) {
      throw invalid(error.message);
    }
    throw error;
  }
}
