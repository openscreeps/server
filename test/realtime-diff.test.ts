import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import type { JsonObject, JsonValue } from '../src/contracts.ts';
import {
  historyTicks,
  jsonObjects,
  RoomObjectsMirror,
  type ObjectsDiff,
} from '../src/realtime/diff.ts';

// The official client bundles lodash 3.10.1; the engine installs the same release.
const lodash = createRequire(import.meta.url)('lodash') as {
  VERSION: string;
  merge(
    object: unknown,
    source: unknown,
    customizer: (value: unknown, source: unknown) => unknown,
  ): unknown;
};

type ClientObject = Record<string, unknown>;

/** The client's `N` (build.min.js): top-level arrays become index-keyed objects. */
function clientIndexArrays(object: ClientObject): void {
  for (const [key, value] of Object.entries(object)) {
    if (Array.isArray(value)) object[key] = Object.fromEntries((value as unknown[]).entries());
  }
}

/** The client's `U`. */
function clientApply(list: ClientObject[], diff: Record<string, unknown>): void {
  for (const id in diff) {
    const change = diff[id] as ClientObject | null;
    const object = list.find((item) => item._id === id);
    if (object) {
      if (change !== null) {
        clientIndexArrays(object);
        clientIndexArrays(change);
        lodash.merge(object, change, (value, source) =>
          Array.isArray(value) && Array.isArray(source) ? source : undefined,
        );
      } else {
        list.splice(list.indexOf(object), 1);
      }
    } else if (change) {
      list.push(structuredClone(change));
    }
  }
}

/** Server and client agree when equal after `N`, with `null` standing for an absent key. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map(normalize);
  if (typeof value !== 'object' || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (item !== null && item !== undefined) result[key] = normalize(item);
  }
  return result;
}

function normalizeObject(object: ClientObject): unknown {
  const indexed = { ...object };
  clientIndexArrays(indexed);
  return normalize(indexed);
}

function idOf(object: Readonly<Record<string, unknown>>): string {
  const id = object._id;
  assert.ok(typeof id === 'string');
  return id;
}

/** Objects keyed by id in the form both sides are compared in. */
function byId(objects: ReadonlyArray<Readonly<Record<string, unknown>>>): Record<string, unknown> {
  return Object.fromEntries(objects.map((object) => [idOf(object), normalizeObject(object)]));
}

class Scenario {
  readonly mirror = new RoomObjectsMirror();
  readonly client: ClientObject[] = [];

  /** Sends the diff to `objects` over JSON and returns it. */
  step(objects: JsonObject[]): ObjectsDiff {
    const diff = this.mirror.update(jsonObjects(objects.map((object) => [idOf(object), object])));
    clientApply(this.client, JSON.parse(JSON.stringify(diff)) as Record<string, unknown>);
    // The mirror holds exactly what the client holds.
    assert.deepEqual(byId([...this.mirror.objects.values()]), byId(this.client));
    return diff;
  }

  assertConverged(objects: JsonObject[]): void {
    assert.deepEqual(byId(this.client), byId(objects));
  }
}

function creep(overrides: JsonObject = {}): JsonObject {
  return {
    _id: 'c1',
    type: 'creep',
    room: 'W1N1',
    x: 10,
    y: 10,
    user: 'u1',
    body: [
      { type: 'work', hits: 100 },
      { type: 'move', hits: 100 },
    ],
    store: { energy: 50, H: 5 },
    actionLog: { harvest: null, say: { message: 'hi', isPublic: true } },
    effects: [
      { power: 1, level: 1, endTime: 100 },
      { power: 2, level: 1, endTime: 120 },
    ],
    spawning: { name: 'c1', spawnTime: 10, directions: [1, 2, 3] },
    ...overrides,
  };
}

void describe('room object diffs', () => {
  void it('runs against the client lodash release', () => {
    assert.equal(lodash.VERSION, '3.10.1');
  });

  void it('sends new objects whole, then only changed values and removals', () => {
    const scenario = new Scenario();
    const first = creep();
    assert.deepEqual(scenario.step([first]), { c1: first });
    const moved = creep({ x: 11, store: { energy: 50 } });
    assert.deepEqual(scenario.step([moved]), { c1: { x: 11, store: { H: null } } });
    scenario.assertConverged([moved]);
    assert.deepEqual(scenario.step([moved]), {});
    assert.deepEqual(scenario.step([]), { c1: null });
    assert.equal(scenario.client.length, 0);
  });

  void it('removes nested keys upstream getDiff left behind and replaces nested arrays', () => {
    const scenario = new Scenario();
    scenario.step([creep()]);
    const next = creep({
      actionLog: { harvest: { x: 1, y: 2 } },
      spawning: { name: 'c1', spawnTime: 10, directions: [4] },
      body: [
        { type: 'work', hits: 40 },
        { type: 'move', hits: 100, boost: 'ZO' },
      ],
    });
    assert.deepEqual(scenario.step([next]), {
      c1: {
        actionLog: { harvest: { x: 1, y: 2 }, say: null },
        spawning: { directions: [4] },
        body: { 0: { hits: 40 }, 1: { boost: 'ZO' } },
      },
    });
    scenario.assertConverged([next]);
    assert.deepEqual(scenario.step([next]), {});
  });

  void it('resets a shrunk top-level collection and resends it in full', () => {
    const scenario = new Scenario();
    scenario.step([creep()]);
    const shrunk = creep({ effects: [{ power: 2, level: 1, endTime: 120 }] });
    // An element cannot be deleted by `_.merge` and a `null` element breaks the renderer.
    assert.deepEqual(scenario.step([shrunk]), { c1: { effects: null } });
    assert.deepEqual(scenario.step([shrunk]), {
      c1: { effects: { 0: { power: 2, level: 1, endTime: 120 } } },
    });
    scenario.assertConverged([shrunk]);
    assert.deepEqual(scenario.step([shrunk]), {});
  });

  void it('handles values changing type in every direction', () => {
    const scenario = new Scenario();
    const objects: JsonObject[] = [
      { _id: 'a', type: 'x', room: 'R', x: 1, y: 1, v: 'text', w: { k: 1 }, z: [1, 2], q: null },
    ];
    scenario.step(objects);
    const changed: JsonObject[] = [
      { _id: 'a', type: 'x', room: 'R', x: 1, y: 1, v: { k: [1] }, w: 3, z: null, q: [1] },
    ];
    scenario.step(changed);
    scenario.assertConverged(changed);
    const back: JsonObject[] = [
      { _id: 'a', type: 'x', room: 'R', x: 1, y: 1, v: ['a'], w: { n: { m: 1 } }, z: { 0: 9 } },
    ];
    scenario.step(back);
    scenario.step(back);
    scenario.assertConverged(back);
    assert.deepEqual(scenario.step(back), {});
  });

  void it('converges on random mutations within one extra update', () => {
    // Deterministic xorshift so failures reproduce.
    let seed = 0x9e3779b9;
    const random = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const value = (depth: number): JsonValue => {
      const kind = random();
      if (depth > 2 || kind < 0.4) return pick([0, 1, 2, 'a', 'b', true, false, null]);
      if (kind < 0.7) {
        const record: JsonObject = {};
        for (let index = Math.floor(random() * 4); index > 0; index--)
          record[pick(['p', 'q', 'r', 's'])] = value(depth + 1);
        return record;
      }
      return Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1));
    };
    const scenario = new Scenario();
    let objects: JsonObject[] = [];
    for (let round = 0; round < 400; round++) {
      const next: JsonObject[] = [];
      for (const id of ['o1', 'o2', 'o3', 'o4']) {
        if (random() < 0.1) continue;
        const previous = objects.find((object) => object._id === id);
        const object: JsonObject = previous
          ? structuredClone(previous)
          : { _id: id, type: 't', room: 'R', x: 1, y: 1 };
        for (let edits = Math.floor(random() * 3); edits > 0; edits--) {
          const key = pick(['a', 'b', 'c', 'd']);
          if (random() < 0.25) Reflect.deleteProperty(object, key);
          else object[key] = value(0);
        }
        next.push(object);
      }
      objects = next;
      scenario.step(objects);
      scenario.step(objects);
      scenario.assertConverged(objects);
    }
  });
});

void describe('room history ticks', () => {
  void it('starts with the full base tick and stops at the first missing tick', () => {
    const ticks = historyTicks([
      { time: 20, objects: { c1: creep() } },
      { time: 21, objects: { c1: creep({ x: 12 }) } },
      { time: 22, objects: {} },
      { time: 24, objects: { c1: creep() } },
    ]);
    assert.deepEqual(Object.keys(ticks), ['20', '21', '22']);
    assert.deepEqual(ticks['20'], { c1: creep() });
    assert.deepEqual(ticks['21'], { c1: { x: 12 } });
    assert.deepEqual(ticks['22'], { c1: null });
  });

  void it('replays in the client to every recorded frame', () => {
    const frames = [
      { time: 40, objects: { c1: creep() } },
      { time: 41, objects: { c1: creep({ store: { energy: 1 } }) } },
      { time: 42, objects: { c1: creep({ effects: [] }) } },
      { time: 43, objects: { c1: creep({ effects: [] }), c2: creep({ _id: 'c2' }) } },
    ];
    const ticks = historyTicks(frames);
    const client: ClientObject[] = [];
    for (const frame of frames) {
      clientApply(
        client,
        JSON.parse(JSON.stringify(ticks[String(frame.time)])) as Record<string, unknown>,
      );
      if (frame.time === 42) continue; // the shrunk `effects` is reset here and resent next tick
      assert.deepEqual(byId(client), byId(Object.values(frame.objects)));
    }
  });
});
