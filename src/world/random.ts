import type { WorldState } from '@openscreeps/engine';

/**
 * Deterministic replacement for every upstream `Math.random()` call in world generation and
 * maintenance. The generator state is `world.rngState` (mulberry32, the same stream the engine
 * simulation consumes), read and written on every draw so ticks and jobs share one sequence.
 */
export class WorldRandom {
  readonly #world: WorldState;

  constructor(world: WorldState) {
    this.#world = world;
  }

  /** Uniform number in `[0, 1)`. */
  next(): number {
    const state = (this.#world.rngState + 0x6d2b79f5) >>> 0;
    this.#world.rngState = state;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** `Math.floor(Math.random() * count)`. */
  index(count: number): number {
    return Math.floor(this.next() * count);
  }

  /** lodash `_.sample`; `undefined` for an empty list. */
  sample<T>(list: readonly T[]): T | undefined {
    return list.length ? list[this.index(list.length)] : undefined;
  }

  /** lodash `_.shuffle` (Fisher-Yates over a copy). */
  shuffle<T>(list: readonly T[]): T[] {
    const result = [...list];
    for (let i = 0; i < result.length; i++) {
      const j = i + this.index(result.length - i);
      const value = result[j] as T;
      result[j] = result[i] as T;
      result[i] = value;
    }
    return result;
  }
}

/** Seed a fresh world's generator from an operator-provided integer seed. */
export function seedState(seed: number): number {
  // splitmix-style scramble so nearby seeds produce unrelated worlds
  let x = Math.trunc(seed) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}
