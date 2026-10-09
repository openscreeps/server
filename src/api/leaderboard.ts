import type { TickResult } from '@openscreeps/engine';
import { ApiError, type ApiRoute, type ServerState } from '../contracts.ts';
import { ownValue, parseInteger, publicUser, type PublicUser } from './gameplay-support.ts';

/**
 * Monthly rankings like the official game: `world` scores the control points a player upgraded in
 * the month (the `energyControl` room stat, equal to the GCL gained), `power` the power processed.
 */
type LeaderboardMode = 'world' | 'power';
type LeaderboardScores = ServerState['leaderboard'][string][string];

interface LeaderboardEntry {
  _id: string;
  season: string;
  user: string;
  score: number;
  rank: number;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const SEASON_ID = /^(\d{4})-(0[1-9]|1[0-2])$/;
const PAGE_LIMIT = 20;

function seasonOf(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

/**
 * Adds one tick's room statistics to the scores of the season containing `timestamp`. Called by the
 * tick commit with `TickResult.roomStats`; amounts of ids that are not registered users are ignored.
 */
export function recordLeaderboard(
  state: ServerState,
  roomStats: TickResult['roomStats'],
  timestamp: number,
): void {
  const season = seasonOf(timestamp);
  for (const byUser of Object.values(roomStats)) {
    for (const [userId, stats] of Object.entries(byUser)) {
      const world = stats['energyControl'] ?? 0;
      const power = stats['powerProcessed'] ?? 0;
      if ((world <= 0 && power <= 0) || !Object.hasOwn(state.world.users, userId)) {
        continue;
      }
      let scores = ownValue(state.leaderboard, season);
      if (!scores) {
        scores = {};
        state.leaderboard[season] = scores;
      }
      const previous: LeaderboardScores = ownValue(scores, userId) ?? { world: 0, power: 0 };
      scores[userId] = { world: previous.world + world, power: previous.power + power };
    }
  }
}

/** Seasons with recorded scores plus the current month, newest first (the client's current season). */
function seasonIds(state: ServerState, now: number): string[] {
  const ids = new Set(Object.keys(state.leaderboard).filter((id) => SEASON_ID.test(id)));
  ids.add(seasonOf(now));
  return [...ids].sort((a, b) => (a < b ? 1 : -1));
}

/** Ranked entries of one season: score descending, ties by user id, zero scores unranked. */
function seasonRanking(
  state: ServerState,
  season: string,
  mode: LeaderboardMode,
): LeaderboardEntry[] {
  const scores = ownValue(state.leaderboard, season) ?? {};
  return Object.entries(scores)
    .filter(([, score]) => score[mode] > 0)
    .sort(([userA, a], [userB, b]) => b[mode] - a[mode] || (userA < userB ? -1 : 1))
    .map(([user, score], rank) => ({
      _id: `${season}-${mode}-${user}`,
      season,
      user,
      score: score[mode],
      rank,
    }));
}

/** Modes this server ranks; the official arena/survival modes have no results here. */
function readMode(value: string | null): LeaderboardMode | undefined {
  if (value === null) {
    throw new ApiError('invalid params');
  }
  return value === 'world' || value === 'power' ? value : undefined;
}

function readSeason(value: string | null, now: number): string {
  if (value === null || value === '') {
    return seasonOf(now);
  }
  if (!SEASON_ID.test(value)) {
    throw new ApiError('invalid params');
  }
  return value;
}

export const leaderboardRoutes: readonly ApiRoute[] = [
  {
    method: 'GET',
    path: '/api/leaderboard/seasons',
    handle(_request, context) {
      return {
        seasons: seasonIds(context.state, context.now()).map((_id) => {
          const [, year = '', month = ''] = SEASON_ID.exec(_id) ?? [];
          return {
            _id,
            name: `${MONTHS[Number(month) - 1] ?? ''} ${year}`,
            date: new Date(Date.UTC(Number(year), Number(month) - 1, 1)).toISOString(),
          };
        }),
      };
    },
  },
  {
    method: 'GET',
    path: '/api/leaderboard/list',
    handle(request, context) {
      const { state } = context;
      const mode = readMode(request.query.get('mode'));
      const season = readSeason(request.query.get('season'), context.now());
      const offset = Math.max(0, parseInteger(request.query.get('offset')) || 0);
      const limit = Math.min(
        PAGE_LIMIT,
        Math.max(1, parseInteger(request.query.get('limit')) || 10),
      );
      const ranking = mode ? seasonRanking(state, season, mode) : [];
      const list = ranking.slice(offset, offset + limit);
      const users: Record<string, PublicUser & { gcl: number }> = {};
      for (const entry of list) {
        const user = publicUser(state.world, entry.user);
        if (user) {
          users[entry.user] = { ...user, gcl: state.world.users[entry.user]?.gcl ?? 0 };
        }
      }
      return { list, count: ranking.length, users };
    },
  },
  {
    method: 'GET',
    path: '/api/leaderboard/find',
    handle(request, context) {
      const { state } = context;
      const mode = readMode(request.query.get('mode'));
      const username = request.query.get('username')?.toLowerCase();
      const user = username
        ? Object.values(state.world.users).find(
            (candidate) =>
              (candidate.usernameLower ?? candidate.username?.toLowerCase()) === username,
          )
        : undefined;
      if (!user) {
        throw new ApiError('user not found');
      }
      const seasonParam = request.query.get('season');
      if (seasonParam) {
        const season = readSeason(seasonParam, context.now());
        const entry = mode
          ? seasonRanking(state, season, mode).find((item) => item.user === user._id)
          : undefined;
        if (!entry) {
          throw new ApiError('result not found');
        }
        return entry;
      }
      const list = mode
        ? seasonIds(state, context.now()).flatMap((season) =>
            seasonRanking(state, season, mode).filter((item) => item.user === user._id),
          )
        : [];
      return { list };
    },
  },
];
