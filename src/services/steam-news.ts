import { Inject, Injectable } from '@nestjs/common';
import { ApiError, type ApiContext } from '../contracts.ts';
import { STEAM_APP_ID } from '../api/auth.ts';
import { isRecord } from '../api/guards.ts';
import { SERVER_CONTEXT } from '../api/transport.ts';

const STEAM_NEWS_URL = 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/';
const STEAM_NEWS_TIMEOUT_MS = 10_000;
/** Matches the official client's polling interval: one upstream request serves every client. */
export const STEAM_NEWS_TTL_MS = 5 * 60 * 1000;

/**
 * Screeps announcements from Valve's public `ISteamNews/GetNewsForApp` Web API (no key required),
 * relayed like screeps.com's `GET /api/steam/news`: the latest item only, Steam's `appnews` object
 * unchanged. The client reads `appnews.newsitems[0].gid` to badge its News menu entry.
 */
@Injectable()
export class SteamNewsService {
  #cached: { appnews: Record<string, unknown>; expires: number } | undefined;
  #pending: Promise<Record<string, unknown>> | undefined;

  constructor(@Inject(SERVER_CONTEXT) readonly context: ApiContext) {}

  async news(): Promise<{ appnews: Record<string, unknown> }> {
    const cached = this.#cached;
    if (cached && this.context.now() < cached.expires) return { appnews: cached.appnews };
    this.#pending ??= this.#fetch().finally(() => {
      this.#pending = undefined;
    });
    return { appnews: await this.#pending };
  }

  async #fetch(): Promise<Record<string, unknown>> {
    const url = new URL(STEAM_NEWS_URL);
    url.searchParams.set('appid', String(STEAM_APP_ID));
    url.searchParams.set('count', '1');
    let body: unknown;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(STEAM_NEWS_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      body = await response.json();
    } catch {
      throw new ApiError('steam news unavailable', 502);
    }
    const appnews = isRecord(body) ? body.appnews : undefined;
    if (!isRecord(appnews) || !Array.isArray(appnews.newsitems)) {
      throw new ApiError('steam news unavailable', 502);
    }
    this.#cached = { appnews, expires: this.context.now() + STEAM_NEWS_TTL_MS };
    return appnews;
  }
}
