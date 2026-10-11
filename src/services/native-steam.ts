/*
 * Steam sign-in modes of backend `api/auth.js` and `game/server.js`: the Steam Web API
 * (`AuthenticateUserTicket`) or the native encrypted-app-ticket scheme processed by the
 * Greenworks binding of the Steamworks SDK running next to a local Steam client.
 *
 * Portions derived from screeps/backend-local, Copyright (c) 2016, Artem Chivchalov
 * <contact@screeps.com>, used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { Inject, Injectable } from '@nestjs/common';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { ApiError, type ServerConfig } from '../contracts.ts';
import { STEAM_APP_ID, verifySteamTicket } from '../api/auth.ts';
import { SERVER_CONTEXT } from '../api/transport.ts';

/**
 * Screeps' encrypted-app-ticket key as published in the pinned backend (`api/auth.js`). Valve
 * encrypts every app ticket for app 464350 with it; integrity rests only on this symmetric key.
 */
const SCREEPS_APP_TICKET_KEY = Buffer.from(
  'ed66a45b50c848a0c463ec18e0eab308fe9b8d3edcb0484b2def7e52f7297e75',
  'hex',
);
/** Hex characters accepted per ticket (4 KiB of ticket bytes; real tickets are ~150 bytes). */
const MAX_TICKET_HEX_LENGTH = 8192;
const TICKET_PATTERN = /^(?:[0-9a-fA-F]{2})+$/;
const STEAM_ID_PATTERN = /^[1-9]\d{0,19}$/;
const INVALID_TICKET = 'invalid encrypted ticket';
const UNSUPPORTED = 'authentication method is not supported';

/** The Greenworks functions the native scheme calls (backend `server.js` and `api/auth.js`). */
const GREENWORKS_FUNCTIONS = [
  'isSteamRunning',
  'initAPI',
  'getAppId',
  'decryptAppTicket',
  'isTicketForApp',
  'getTicketSteamId',
] as const;

type Greenworks = Record<(typeof GREENWORKS_FUNCTIONS)[number], (...args: unknown[]) => unknown>;

/** Steam sign-in mode selected by configuration. */
export type SteamAuthMode = 'webapi' | 'native' | 'disabled';

/** Configuration consulted by {@link SteamAuthService}. */
export type SteamAuthConfig = Pick<ServerConfig, 'steamKey' | 'steamGreenworks'>;

/** The original layout is `greenworks/greenworks.js` with `lib/greenworks-<platform>.node`. */
function greenworksFile(path: string): string {
  const file = resolve(path);
  try {
    return statSync(file).isDirectory() ? join(file, 'greenworks.js') : file;
  } catch {
    return file; // Missing paths are reported when loading.
  }
}

function loadGreenworks(file: string): Greenworks {
  let loaded: unknown;
  try {
    loaded = createRequire(import.meta.url)(file);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot load the greenworks library from ${file}: ${reason}`, { cause: error });
  }
  if ((typeof loaded !== 'object' && typeof loaded !== 'function') || loaded === null) {
    throw new Error(`${file} does not export the greenworks API`);
  }
  const module = loaded as Record<string, unknown>;
  for (const name of GREENWORKS_FUNCTIONS) {
    if (typeof module[name] !== 'function') {
      throw new Error(`${file} does not provide greenworks.${name}()`);
    }
  }
  return module as Greenworks;
}

/**
 * Native encrypted-app-ticket verification through a loaded and initialized Greenworks module.
 * Steam's SDK can crash the process when handed bytes that did not come from a successful
 * decryption, so only `decryptAppTicket` ever sees request data.
 */
export class NativeSteamTickets {
  static readonly #loaded = new Map<string, NativeSteamTickets>();

  private constructor(private readonly greenworks: Greenworks) {}

  /**
   * Startup readiness of backend `server.js`: load Greenworks, require a running Steam client and
   * a successful `initAPI()` for app 464350. The Steam API is process-wide, so each module path is
   * initialized once per process. Throws with the reason when native mode is unusable.
   */
  static load(path: string): NativeSteamTickets {
    const file = greenworksFile(path);
    const cached = NativeSteamTickets.#loaded.get(file);
    if (cached) return cached;
    const greenworks = loadGreenworks(file);
    if (greenworks.isSteamRunning() !== true) throw new Error('Steam client is not running');
    // SteamAPI_Init identifies the app from `SteamAppId` or ./steam_appid.txt (the launcher
    // writes the latter); the environment variable keeps startup independent of the cwd.
    process.env.SteamAppId ??= String(STEAM_APP_ID);
    if (greenworks.initAPI() !== true) throw new Error('greenworks.initAPI() failure');
    const appId = greenworks.getAppId();
    if (appId !== STEAM_APP_ID) {
      throw new Error(
        `Steam reports app id ${String(appId)}; native Screeps authentication requires ${String(STEAM_APP_ID)}`,
      );
    }
    const tickets = new NativeSteamTickets(greenworks);
    NativeSteamTickets.#loaded.set(file, tickets);
    return tickets;
  }

  /** Backend `POST /api/auth/steam-ticket` with `useNativeAuth`: returns the ticket's SteamID. */
  verify(ticket: unknown): string {
    if (
      typeof ticket !== 'string' ||
      ticket.length > MAX_TICKET_HEX_LENGTH ||
      !TICKET_PATTERN.test(ticket)
    ) {
      throw new ApiError(INVALID_TICKET);
    }
    const { greenworks } = this;
    let steamId: unknown;
    try {
      const decrypted = greenworks.decryptAppTicket(
        Buffer.from(ticket, 'hex'),
        SCREEPS_APP_TICKET_KEY,
      );
      if (
        Buffer.isBuffer(decrypted) &&
        decrypted.length > 0 &&
        greenworks.isTicketForApp(decrypted, STEAM_APP_ID) === true
      ) {
        const id = greenworks.getTicketSteamId(decrypted) as {
          getRawSteamID?: () => unknown;
        } | null;
        if (typeof id?.getRawSteamID === 'function') steamId = id.getRawSteamID();
      }
    } catch {
      // Greenworks throws on malformed arguments; every failure is a rejected ticket.
    }
    if (typeof steamId !== 'string' || !STEAM_ID_PATTERN.test(steamId)) {
      throw new ApiError(INVALID_TICKET);
    }
    return steamId;
  }
}

/**
 * Steam ticket authentication for the configured mode. Native mode is strictly opt-in through
 * `steamGreenworks` and is validated when the application starts, so `/api/version` only
 * advertises `useNativeAuth` when encrypted tickets can actually be verified.
 */
@Injectable()
export class SteamAuthService {
  readonly mode: SteamAuthMode;
  readonly #steamKey: string | undefined;
  readonly #native: NativeSteamTickets | undefined;

  constructor(@Inject(SERVER_CONTEXT) context: { readonly config: SteamAuthConfig }) {
    const { steamKey, steamGreenworks } = context.config;
    if (steamKey && steamGreenworks) {
      throw new Error(
        'STEAM_KEY (Steam Web API) and STEAM_GREENWORKS (native tickets) are exclusive; configure one',
      );
    }
    this.#steamKey = steamKey || undefined;
    this.#native = steamGreenworks ? NativeSteamTickets.load(steamGreenworks) : undefined;
    this.mode = this.#native ? 'native' : this.#steamKey ? 'webapi' : 'disabled';
  }

  /** `useNativeAuth` of `GET /api/version`. */
  get useNativeAuth(): boolean {
    return this.mode === 'native';
  }

  /**
   * Verifies a `POST /api/auth/steam-ticket` body and returns the authenticated SteamID. A request
   * for the scheme the server does not run is rejected, as in the backend.
   */
  async authenticate(body: Record<string, unknown>): Promise<string> {
    const { ticket } = body;
    if (body.useNativeAuth) {
      if (!this.#native) throw new ApiError(UNSUPPORTED);
      return this.#native.verify(ticket);
    }
    if (this.#native) throw new ApiError(UNSUPPORTED);
    if (typeof ticket !== 'string') throw new ApiError('could not authenticate');
    return verifySteamTicket(ticket, this.#steamKey);
  }
}
