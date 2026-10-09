import type { StatisticsSample } from '../contracts.ts';

/** Room statistics the engine records per room and user (`stats.inc`). */
export const ROOM_STAT_NAMES = [
  'energyHarvested',
  'energyConstruction',
  'energyCreeps',
  'energyControl',
  'creepsProduced',
  'creepsLost',
  'powerProcessed',
] as const;
export type RoomStatName = (typeof ROOM_STAT_NAMES)[number];

/** Graph points per interval (upstream `{8: 8, 180: 8, 1440: 7}`); the interval is in minutes. */
const INTERVAL_POINTS: Readonly<Record<string, number>> = { 8: 8, 180: 8, 1440: 7 };
const MINUTE = 60_000;

export interface StatPoint {
  value: number;
  endTime: number;
}

/**
 * Time window of one stat interval: points are numbered by their end in interval units
 * (`endTime = Math.ceil(now / interval)` for the current point, like upstream `user/overview`).
 */
export interface StatWindow {
  interval: number;
  firstEnd: number;
  lastEnd: number;
}

export function isRoomStatName(name: string): name is RoomStatName {
  return (ROOM_STAT_NAMES as readonly string[]).includes(name);
}

export function statWindow(interval: number, now: number): StatWindow | undefined {
  const points = INTERVAL_POINTS[interval];
  if (points === undefined) {
    return undefined;
  }
  const lastEnd = Math.ceil(now / (interval * MINUTE));
  return { interval, firstEnd: lastEnd - points + 1, lastEnd };
}

/**
 * Visits the samples inside a window with the point they belong to: a minute sample lies wholly in
 * point `Math.ceil((time + 1 minute) / interval)` because intervals are whole minutes.
 */
function forEachSample(
  samples: readonly StatisticsSample[],
  window: StatWindow,
  visit: (sample: StatisticsSample, endTime: number) => void,
): void {
  const intervalMs = window.interval * MINUTE;
  for (const sample of samples) {
    const endTime = Math.ceil((sample.time + MINUTE) / intervalMs);
    if (endTime >= window.firstEnd && endTime <= window.lastEnd) {
      visit(sample, endTime);
    }
  }
}

export interface RoomOverviewStats {
  stats: Record<RoomStatName, StatPoint[]>;
  statsMax: Record<string, number>;
  totals: Record<RoomStatName, number>;
}

/**
 * Room overview graphs: per point the stat summed over every player active in the room, oldest point
 * first, plus window totals and each stat's largest point (`statsMax[stat + interval]`) for scaling.
 */
export function roomOverviewStats(
  samples: readonly StatisticsSample[],
  room: string,
  window: StatWindow,
  isUser: (userId: string) => boolean,
): RoomOverviewStats {
  const pointCount = window.lastEnd - window.firstEnd + 1;
  const stats = {} as Record<RoomStatName, StatPoint[]>;
  const totals = {} as Record<RoomStatName, number>;
  for (const name of ROOM_STAT_NAMES) {
    stats[name] = Array.from({ length: pointCount }, (_unused, index) => ({
      value: 0,
      endTime: window.firstEnd + index,
    }));
    totals[name] = 0;
  }
  forEachSample(samples, window, (sample, endTime) => {
    const byUser = Object.hasOwn(sample.rooms, room) ? sample.rooms[room] : undefined;
    for (const [userId, values] of Object.entries(byUser ?? {})) {
      if (!isUser(userId)) {
        continue;
      }
      for (const name of ROOM_STAT_NAMES) {
        const value = values[name];
        const point = stats[name][endTime - window.firstEnd];
        if (value !== undefined && point) {
          point.value += value;
          totals[name] += value;
        }
      }
    }
  });
  const statsMax: Record<string, number> = {};
  for (const name of ROOM_STAT_NAMES) {
    // A zero maximum would make the client scale circles by 0/0.
    statsMax[`${name}${String(window.interval)}`] = Math.max(
      1,
      ...stats[name].map((point) => point.value),
    );
  }
  return { stats, statsMax, totals };
}

/** One stat summed over a window for every room: room -> user -> amount. */
export function roomStatTotals(
  samples: readonly StatisticsSample[],
  stat: RoomStatName,
  window: StatWindow,
  isUser: (userId: string) => boolean,
): Map<string, Map<string, number>> {
  const totals = new Map<string, Map<string, number>>();
  forEachSample(samples, window, (sample) => {
    for (const [room, byUser] of Object.entries(sample.rooms)) {
      for (const [userId, values] of Object.entries(byUser)) {
        const value = values[stat];
        if (!value || !isUser(userId)) {
          continue;
        }
        let roomTotals = totals.get(room);
        if (!roomTotals) {
          roomTotals = new Map();
          totals.set(room, roomTotals);
        }
        roomTotals.set(userId, (roomTotals.get(userId) ?? 0) + value);
      }
    }
  });
  return totals;
}
