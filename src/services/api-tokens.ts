/*
 * Persistent API tokens (official `GET`/`POST /api/user/auth-token`,
 * `POST /api/user/delete-auth-token` and `GET /api/auth/query-token`). Tokens have full access,
 * never expire and are never rotated; the server stores only their hash and first 8 characters.
 */

import { Inject, Injectable } from '@nestjs/common';
import { ApiError, requireUser, type ApiContext, type ApiRequest } from '../contracts.ts';
import { findApiToken, issueApiToken } from '../api/auth.ts';
import { SERVER_CONTEXT } from '../api/transport.ts';

/** Tokens one account may hold. */
const MAX_TOKENS_PER_USER = 100;
const MAX_DESCRIPTION_LENGTH = 100;

@Injectable()
export class ApiTokensService {
  constructor(@Inject(SERVER_CONTEXT) readonly context: ApiContext) {}

  list(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const tokens = Object.values(this.context.state.apiTokens)
      .filter((entry) => entry.userId === user._id)
      .sort((a, b) => a.created - b.created || a._id.localeCompare(b._id))
      .map((entry) => ({
        _id: entry._id,
        token: entry.prefix,
        full: true,
        description: entry.description,
      }));
    return { tokens };
  }

  create(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const { type, description } = request.body;
    // The official form posts `endpoints`, `websockets` and `memorySegments` with every request;
    // a full-access token ignores them.
    if (type !== undefined && type !== 'full') {
      throw new ApiError('restricted tokens are not supported');
    }
    if (
      description !== undefined &&
      description !== null &&
      (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LENGTH)
    ) {
      throw new ApiError('invalid params');
    }
    const owned = Object.values(this.context.state.apiTokens).filter(
      (entry) => entry.userId === user._id,
    ).length;
    if (owned >= MAX_TOKENS_PER_USER) throw new ApiError('too many tokens');
    return {
      token: issueApiToken(this.context, user._id, description ?? null),
    };
  }

  delete(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const { tokenId } = request.body;
    if (typeof tokenId !== 'string') throw new ApiError('invalid params');
    const { apiTokens } = this.context.state;
    const hash = Object.entries(apiTokens).find(
      ([, entry]) => entry._id === tokenId && entry.userId === user._id,
    )?.[0];
    if (hash === undefined) throw new ApiError('token not found');
    Reflect.deleteProperty(apiTokens, hash);
    // Delivered after the commit: closes the socket sessions authenticated with this token.
    this.context.publish('auth:revoked', { user: user._id, apiToken: tokenId });
    return {};
  }

  query(request: ApiRequest) {
    const token = request.query.get('token') ?? '';
    const entry = findApiToken(this.context.state, token);
    if (!entry || !this.context.state.world.users[entry.userId]) {
      throw new ApiError('token not found');
    }
    return {
      _id: entry._id,
      token: {
        full: true,
        token,
        ...(entry.description === null ? {} : { description: entry.description }),
      },
    };
  }
}
