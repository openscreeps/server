/*
 * Bearer tokens, local password credentials and Steam Web API ticket verification
 * (replacement for backend `authlib.js` and the passport token strategy of `api/auth.js`).
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { ApiError, type AuthService, type ServerContext } from '../contracts.ts';
import { isRecord } from './guards.ts';

/** Screeps Steam application id (backend `steamAppId`). */
export const STEAM_APP_ID = 464350;
const STEAM_AUTHENTICATE_URL =
  'https://api.steampowered.com/ISteamUserAuth/AuthenticateUserTicket/v1/';
const STEAM_TIMEOUT_MS = 10_000;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createAuthService(context: ServerContext): AuthService {
  return {
    check(token) {
      if (!TOKEN_PATTERN.test(token)) return undefined;
      const entry = context.state.tokens[hashToken(token)];
      if (!entry || entry.expires <= context.now()) return undefined;
      return context.state.world.users[entry.userId] ? entry.userId : undefined;
    },
    issue(userId) {
      const { tokens } = context.state;
      const now = context.now();
      for (const [hash, entry] of Object.entries(tokens)) {
        if (entry.expires <= now) Reflect.deleteProperty(tokens, hash);
      }
      const token = randomBytes(32).toString('hex');
      tokens[hashToken(token)] = { userId, expires: now + context.config.tokenLifetimeMs };
      return token;
    },
  };
}

/** `scrypt$N$r$p$salt$key` with base64 salt and derived key. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${String(SCRYPT_N)}$${String(SCRYPT_R)}$${String(SCRYPT_P)}$${salt.toString('base64')}$${key.toString('base64')}`;
}

let dummyHash: string | undefined;

/**
 * Constant-time password check. Pass `undefined` for an unknown account: a dummy hash is still
 * verified so response timing does not reveal which accounts exist.
 */
export function verifyPassword(password: string, stored: string | undefined): boolean {
  const encoded = stored ?? (dummyHash ??= hashPassword(randomBytes(16).toString('hex')));
  const [scheme, n, r, p, saltText, keyText] = encoded.split('$');
  if (scheme !== 'scrypt' || saltText === undefined || keyText === undefined) return false;
  const expected = Buffer.from(keyText, 'base64');
  const cost = Number(n);
  const blockSize = Number(r);
  const parallelization = Number(p);
  if (
    expected.length === 0 ||
    ![cost, blockSize, parallelization].every((value) => Number.isSafeInteger(value) && value > 0)
  ) {
    return false;
  }
  const actual = scryptSync(password, Buffer.from(saltText, 'base64'), expected.length, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: SCRYPT_MAXMEM,
  });
  return timingSafeEqual(actual, expected) && stored !== undefined;
}

/**
 * Verifies a Steam session ticket with the Steam Web API (`ISteamUserAuth/AuthenticateUserTicket`)
 * and returns the authenticated 64-bit SteamID. Every failure (no key configured, transport error,
 * non-OK result, malformed reply) rejects; there is no fallback identity.
 */
export async function verifySteamTicket(
  ticket: string,
  steamKey: string | undefined,
): Promise<string> {
  if (!steamKey) {
    throw new ApiError('authentication method is not supported');
  }
  if (!/^[0-9a-fA-F]+$/.test(ticket) || ticket.length > 8192) {
    throw new ApiError('could not authenticate');
  }
  const url = new URL(STEAM_AUTHENTICATE_URL);
  url.searchParams.set('key', steamKey);
  url.searchParams.set('appid', String(STEAM_APP_ID));
  url.searchParams.set('ticket', ticket);
  let body: unknown;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(STEAM_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    body = await response.json();
  } catch {
    throw new ApiError('could not authenticate');
  }
  const params = isRecord(body) && isRecord(body.response) ? body.response.params : undefined;
  if (!isRecord(params) || params.result !== 'OK') {
    throw new ApiError('could not authenticate');
  }
  const steamId = params.steamid;
  if (typeof steamId !== 'string' || !/^\d{1,20}$/.test(steamId)) {
    throw new ApiError('could not authenticate');
  }
  return steamId;
}
