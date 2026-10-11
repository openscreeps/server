import {
  applyDecorators,
  Catch,
  createParamDecorator,
  HttpCode,
  HttpException,
  Inject,
  Injectable,
  SetMetadata,
  StreamableFile,
  type ArgumentsHost,
  type CallHandler,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { defer, lastValueFrom, type Observable } from 'rxjs';
import { GameError } from '@openscreeps/game';
import { ApiError, RawResponse, type ApiContext, type ApiRequest } from '../contracts.ts';

export const SERVER_CONTEXT = Symbol('ServerContext');
const API_POLICY = Symbol('ApiPolicy');
const API_INPUT = Symbol('ApiInput');
type ApiHttpRequest = Request & { [API_INPUT]?: ApiRequest };

export type ApiPolicyOptions =
  | { auth?: boolean; write?: boolean; unlocked?: false }
  /** External verification runs outside the lock; the service owns its commit. */
  | { auth?: never; write?: never; unlocked: true };

/** Endpoint policy only; `ApiOperation` registers the contract route and applies this policy. */
export function ApiPolicy(options: ApiPolicyOptions = {}): MethodDecorator {
  return applyDecorators(SetMetadata(API_POLICY, options), HttpCode(200));
}

function policyOf(reflector: Reflector, execution: ExecutionContext): ApiPolicyOptions {
  return (
    reflector.getAllAndOverride<ApiPolicyOptions | undefined>(API_POLICY, [
      execution.getHandler(),
      execution.getClass(),
    ]) ?? {}
  );
}

function inputOf(execution: ExecutionContext): ApiRequest {
  const input = execution.switchToHttp().getRequest<ApiHttpRequest>()[API_INPUT];
  if (!input) throw new Error('API controller requires ApiGuard');
  return input;
}

/** Request data built by the guard, never an identity or prepared value supplied by JSON. */
export const ApiInput = createParamDecorator(
  (_data: unknown, execution: ExecutionContext): ApiRequest => inputOf(execution),
);

export function secretsEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(actual).digest(),
    createHash('sha256').update(expected).digest(),
  );
}

function requestToken(request: Request): string {
  const token = request.get('X-Token');
  if (token) return token;
  const authorization = request.get('Authorization');
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7);
  return new URL(request.originalUrl, 'http://server').searchParams.get('token') ?? '';
}

export function checkServerPassword(request: Request, context: ApiContext): void {
  const password = context.config.serverPassword;
  if (password && !secretsEqual(request.get('X-Server-Password') ?? '', password)) {
    throw new ApiError('incorrect server password');
  }
}

@Injectable()
export class ApiGuard implements CanActivate {
  constructor(
    @Inject(SERVER_CONTEXT) readonly context: ApiContext,
    @Inject(Reflector) readonly reflector: Reflector,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    const request = execution.switchToHttp().getRequest<ApiHttpRequest>();
    checkServerPassword(request, this.context);
    const body: unknown = request.body;
    if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body))) {
      throw new ApiError('invalid params', 400);
    }
    const input: ApiRequest = {
      query: new URL(request.originalUrl, 'http://server').searchParams,
      body: (body ?? {}) as Record<string, unknown>,
      headers: request.headers,
    };
    if (policyOf(this.reflector, execution).auth) {
      const userId = await this.context.read(() => this.context.auth.check(requestToken(request)));
      if (!userId) throw new ApiError('unauthorized', 401);
      input.userId = userId;
    }
    request[API_INPUT] = input;
    return true;
  }
}

/** Execute the real Nest handler under the world lock, then serialize its committed result. */
@Injectable()
export class ApiInterceptor implements NestInterceptor<unknown, unknown> {
  constructor(
    @Inject(SERVER_CONTEXT) readonly context: ApiContext,
    @Inject(Reflector) readonly reflector: Reflector,
  ) {}

  intercept(execution: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    return defer(async () => {
      const http = execution.switchToHttp();
      const request = http.getRequest<Request>();
      const response = http.getResponse<Response>();
      const policy = policyOf(this.reflector, execution);
      const input = inputOf(execution);
      let refreshedToken: string | undefined;
      const invoke = () => lastValueFrom(next.handle());
      const operation = async () => {
        // Recheck under the lock: a credential may be revoked after the guard's read.
        if (policy.auth) {
          const userId = this.context.auth.check(requestToken(request));
          if (!userId) throw new ApiError('unauthorized', 401);
          input.userId = userId;
          refreshedToken = this.context.auth.issue(userId);
          const profile = this.context.state.profiles[userId];
          if (profile) profile.lastOnline = this.context.now();
        }
        const result = await invoke();
        // A password change or account removal revokes every session, including this refresh.
        if (refreshedToken !== undefined && !this.context.auth.check(refreshedToken)) {
          refreshedToken = undefined;
        }
        return result;
      };
      const result = policy.unlocked
        ? await invoke()
        : await (policy.write || policy.auth
            ? this.context.mutate(operation)
            : this.context.read(operation));
      if (refreshedToken) response.set('X-Token', refreshedToken);
      if (result instanceof RawResponse) {
        response.status(result.status);
        return new StreamableFile(
          typeof result.body === 'string' ? Buffer.from(result.body) : result.body,
          { type: result.contentType },
        );
      }
      return typeof result === 'object' && result !== null && !Array.isArray(result)
        ? { ok: 1, ...result }
        : { ok: 1 };
    });
  }
}

/** Preserve the game's error envelope while allowing Nest to own response dispatch. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) return;
    if (error instanceof ApiError) {
      response.status(error.status).json({ error: error.message });
    } else if (error instanceof GameError) {
      // Rejected game operations use the protocol's status-200 error envelope.
      response.status(200).json({ error: error.message });
    } else if (error instanceof HttpException) {
      const body = error.getResponse();
      response
        .status(error.getStatus())
        .json(typeof body === 'object' && 'error' in body ? body : { error: error.message });
    } else if (
      error instanceof Error &&
      'status' in error &&
      typeof error.status === 'number' &&
      error.status >= 400 &&
      error.status < 500
    ) {
      response
        .status(error.status)
        .json({ error: error.status === 413 ? 'request too large' : 'invalid request' });
    } else {
      console.error(error);
      response.status(500).json({ error: 'internal server error' });
    }
  }
}
