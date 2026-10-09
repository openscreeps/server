/*
 * Room object diffs that the official client applies exactly.
 *
 * The client keeps a list of room objects and applies each `objects` diff (socket `room:` events
 * and `/room-history` ticks alike) like this (build.min.js `U`/`N`):
 *
 *   null              -> remove the object
 *   unknown id        -> push `_.cloneDeep(diff)`
 *   known id          -> convert the top-level arrays of both the object and the diff into
 *                        index-keyed objects, then lodash 3 `_.merge(object, diff, customizer)`
 *                        where the customizer replaces an array that is merged into an array.
 *
 * `_.merge` cannot delete keys, so upstream `common.getDiff` silently left removed nested keys
 * and shrunk arrays behind. Diffs here are computed against a mirror of the client's state (the
 * mirror applies every diff with the client's algorithm), so the client converges on the
 * server's state:
 *
 *   - a removed key is sent as `null` (the client then holds `null`, which every reader treats
 *     like an absent value, the same convention upstream uses for removed top-level keys);
 *   - nested arrays are sent whole (the customizer replaces them);
 *   - when an object-valued element disappears from a top-level collection (an array, which the
 *     client holds index-keyed, e.g. a shrunk `effects`), a `null` element would break the
 *     renderer, so the whole top-level value is reset to `null` and resent in full next time.
 *
 * The client-side merge reproduces lodash 3.10.1 (`baseMerge`/`baseMergeDeep`), Copyright
 * 2012-2015 The Dojo Foundation, used under the MIT license (see THIRD_PARTY_NOTICES.md).
 */

import type { JsonObject, JsonValue } from '@openscreeps/game';
import { isRecord } from '../api/guards.ts';

type JsonContainer = JsonObject | JsonValue[];

/** One `objects` diff: object id -> full object (new), partial update (known) or `null` (removed). */
export type ObjectsDiff = Record<string, JsonObject | null>;

const RESET = Symbol('reset');
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

/** `JSON.parse(JSON.stringify(value))` without the string round trip (`undefined` when dropped). */
function toJson(value: unknown): JsonValue | undefined {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'object': {
      if (value === null) return null;
      if ('toJSON' in value && typeof value.toJSON === 'function') {
        return toJson(Reflect.apply(value.toJSON, value, []));
      }
      // `Array.from` visits holes, which JSON writes as `null`, so every array is dense.
      if (Array.isArray(value)) return Array.from(value, (item: unknown) => toJson(item) ?? null);
      const result: JsonObject = {};
      for (const [key, item] of Object.entries(value)) {
        const json = toJson(item);
        if (json !== undefined) result[key] = json;
      }
      return result;
    }
    case 'bigint':
      throw new TypeError('Do not know how to serialize a BigInt');
    default:
      return undefined;
  }
}

/** A copy as the client receives it: parsed JSON, so no subtree is shared. */
function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Client `N`: top-level arrays become index-keyed objects (`{ ...array }`; the arrays here are
 * dense JSON). Mutates and returns `object`.
 */
function indexTopLevelArrays(object: JsonObject): JsonObject {
  for (const [key, value] of Object.entries(object)) {
    if (Array.isArray(value)) object[key] = Object.fromEntries(value.entries());
  }
  return object;
}

function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => jsonEqual(item, b[index]))
    );
  }
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
  );
}

/*
 * Client-side application (lodash 3.10 `baseMerge`/`baseMergeDeep` restricted to JSON values,
 * where no value is `undefined`, `NaN` or a shared reference).
 */

function writeKey(container: JsonContainer, key: string | number, value: JsonValue): void {
  if (Array.isArray(container)) container[Number(key)] = value;
  else container[key] = value;
}

function mergeDeep(object: JsonContainer, key: string | number, source: JsonContainer): void {
  const value = Array.isArray(object) ? object[Number(key)] : object[key];
  if (Array.isArray(value) && Array.isArray(source)) {
    // The client's customizer: an array merged into an array replaces it.
    writeKey(object, key, cloneJson(source));
    return;
  }
  let result: JsonContainer;
  if (Array.isArray(source)) {
    // lodash `isArrayLike(value) ? arrayCopy(value) : []`: strings and records with a valid
    // integer `length` are copied index by index.
    result = [];
    const length =
      typeof value === 'string' ? value.length : isRecord(value) ? value.length : undefined;
    if (typeof length === 'number' && Number.isSafeInteger(length) && length >= 0) {
      for (let index = 0; index < length; index++) {
        result.push(
          (typeof value === 'string'
            ? value[index]
            : isRecord(value)
              ? value[String(index)]
              : null) ?? null,
        );
      }
    }
  } else {
    result = isRecord(value) ? value : {};
  }
  merge(result, source);
  writeKey(object, key, result);
}

function merge(object: JsonContainer, source: JsonContainer): void {
  const entries: Array<[string | number, JsonValue]> = Array.isArray(source)
    ? source.map((value, index) => [index, value])
    : Object.entries(source);
  for (const [key, value] of entries) {
    if (typeof value === 'object' && value !== null) mergeDeep(object, key, value);
    else writeKey(object, key, value);
  }
}

/*
 * Diff construction. `depth` is the nesting level of the record holding the key: 0 for the
 * properties of a room object, 1 for the entries of a top-level value, and so on.
 */

function diffValue(
  previous: JsonValue | undefined,
  next: JsonValue,
  depth: number,
): JsonValue | undefined | typeof RESET {
  if (next === null) return previous === undefined || previous === null ? undefined : null;
  if (typeof next !== 'object') return previous === next ? undefined : next;
  if (Array.isArray(next))
    return Array.isArray(previous) && jsonEqual(previous, next) ? undefined : next;
  if (!isRecord(previous)) return next;
  return diffRecord(previous, next, depth + 1);
}

function diffRecord(
  previous: JsonObject,
  next: JsonObject,
  depth: number,
): JsonObject | undefined | typeof RESET {
  const diff: JsonObject = {};
  let changed = false;
  for (const [key, value] of Object.entries(previous)) {
    if (value === null || Object.hasOwn(next, key)) continue;
    if (
      depth === 1 &&
      typeof value === 'object' &&
      Object.keys(previous).every((index) => ARRAY_INDEX.test(index))
    ) {
      return RESET;
    }
    diff[key] = null;
    changed = true;
  }
  for (const [key, value] of Object.entries(next)) {
    const change = diffValue(
      Object.hasOwn(previous, key) ? previous[key] : undefined,
      value,
      depth,
    );
    if (change === undefined) continue;
    if (change === RESET) {
      // Only a top-level value can be reset; deeper records hand the reset up to it.
      if (depth > 0) return RESET;
      diff[key] = null;
    } else {
      diff[key] = change;
    }
    changed = true;
  }
  return changed ? diff : undefined;
}

/**
 * The room objects one client holds. `update` returns the diff that brings the client to the
 * given objects and applies it to the mirror exactly as the client will.
 */
export class RoomObjectsMirror {
  readonly #objects = new Map<string, JsonObject>();

  /** `objects` must be JSON values (see `jsonObjects`) keyed by `_id`; they are not retained. */
  update(objects: ReadonlyMap<string, JsonObject>): ObjectsDiff {
    const diff: ObjectsDiff = {};
    for (const id of this.#objects.keys()) {
      if (!objects.has(id)) diff[id] = null;
    }
    for (const [id, object] of objects) {
      const current = this.#objects.get(id);
      if (!current) {
        diff[id] = object;
        continue;
      }
      const change = diffRecord(current, indexTopLevelArrays({ ...object }), 0);
      if (change !== undefined && change !== RESET) diff[id] = change;
    }
    this.#apply(diff);
    return diff;
  }

  /** The client's `U(list, diff)`. */
  #apply(diff: ObjectsDiff): void {
    for (const [id, change] of Object.entries(diff)) {
      const current = this.#objects.get(id);
      if (!current) {
        if (change) this.#objects.set(id, indexTopLevelArrays(cloneJson(change)));
      } else if (change === null) {
        this.#objects.delete(id);
      } else {
        merge(indexTopLevelArrays(current), indexTopLevelArrays(cloneJson(change)));
      }
    }
  }

  /** The client's current objects (top-level arrays index-keyed). */
  get objects(): ReadonlyMap<string, Readonly<JsonObject>> {
    return this.#objects;
  }
}

/** JSON room objects keyed by id, from a persisted frame or the live world. */
export function jsonObjects(
  objects: Iterable<readonly [string, unknown]>,
): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  for (const [id, object] of objects) {
    const json = toJson(object);
    if (isRecord(json)) result.set(id, json);
  }
  return result;
}

/**
 * `ticks` of a `/room-history` chunk (driver `history.upload`): the first frame in full, then
 * the diff of every following contiguous tick, stopping at the first missing tick. Frames must
 * be ordered by time and hold every object of the room keyed by id.
 */
export function historyTicks(
  frames: Iterable<{ readonly time: number; readonly objects: Readonly<Record<string, unknown>> }>,
): Record<string, ObjectsDiff> {
  const ticks: Record<string, ObjectsDiff> = {};
  const mirror = new RoomObjectsMirror();
  let expected: number | undefined;
  for (const frame of frames) {
    if (expected !== undefined && frame.time !== expected) break;
    ticks[String(frame.time)] = mirror.update(jsonObjects(Object.entries(frame.objects)));
    expected = frame.time + 1;
  }
  return ticks;
}
