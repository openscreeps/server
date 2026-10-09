import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, describe, it } from 'node:test';
import { BotRuntime, constants as C, type WorldState } from '@openscreeps/engine';
import { createConfig } from '../src/config.ts';
import type { ServerContext, ServerEvents, ServerState } from '../src/contracts.ts';
import {
  createPortalPair,
  createWorld,
  exitsOf,
  generateRoom,
  getUserWorldStatus,
  removeBot,
  removeRoom,
  runJob,
  runMaintenance,
  spawnBot,
  spawnStronghold,
} from '../src/world/index.ts';
import { roomNameFromXY, roomNameToXY } from '../src/world/rooms.ts';

const NOW = 1_700_000_000_000;
const base = createWorld({ size: 11, seed: 7, shardName: 'shard0' });
const runtimes: BotRuntime[] = [];
after(() => {
  for (const runtime of runtimes) runtime.dispose();
});

function objectsIn(
  world: WorldState,
  room: string,
  type?: string,
): Array<WorldState['roomObjects'][string]> {
  return Object.values(world.roomObjects).filter(
    (o) => o.room === room && (type === undefined || o.type === type),
  );
}

function stateOf(world: WorldState = structuredClone(base)): ServerState {
  const runtime = new BotRuntime({ now: () => NOW });
  runtimes.push(runtime);
  return {
    version: 1,
    world,
    runtime: runtime.snapshot(),
    profiles: {},
    branches: {},
    tokens: {},
    messages: {},
    history: {},
    statistics: [],
    leaderboard: {},
    jobs: {},
    notificationOutbox: [],
    pendingIntents: {},
    pendingGlobalIntents: {},
    paused: false,
    tickDuration: 1000,
  };
}

function contextOf(state: ServerState): ServerContext {
  const runtime = new BotRuntime({ now: () => NOW, snapshot: state.runtime });
  runtimes.push(runtime);
  return {
    config: createConfig({ database: ':memory:' }),
    state,
    runtime,
    events: new EventEmitter<ServerEvents>(),
    now: () => NOW,
    read: async <T>(operation: () => T | Promise<T>) => operation(),
    mutate: async <T>(operation: () => T | Promise<T>) => operation(),
    publish: () => undefined,
    terrainChanged: () => undefined,
    step: () => Promise.reject(new Error('not used')),
    setPaused: () => Promise.resolve(),
    setTickDuration: () => Promise.resolve(),
  };
}

const isWall = (terrain: string, x: number, y: number): boolean =>
  (Number(terrain.charAt(y * 50 + x)) & 1) > 0;

void describe('world generation', () => {
  void it('is deterministic per seed', () => {
    const again = createWorld({ size: 11, seed: 7, shardName: 'shard0' });
    assert.deepEqual(again.terrain, base.terrain);
    assert.deepEqual(again.roomObjects, base.roomObjects);
    const other = createWorld({ size: 3, seed: 8, shardName: 'shard0' });
    assert.notDeepEqual(other.terrain.W1N1, base.terrain.W1N1);
  });

  void it('lays out the official sector: highways, keeper rooms, center, controllers, NPC terminals', () => {
    assert.equal(Object.keys(base.rooms).length, 121);
    assert.equal(base.users['2']?.username, 'Invader');
    assert.equal(base.users['3']?.username, 'Source Keeper');
    assert.ok(Object.values(base.users).some((u) => u.username === C.SYSTEM_USERNAME));

    for (const name of Object.keys(base.rooms)) {
      const [x, y] = roomNameToXY(name);
      const highway = (x + 1) % 10 === 0 || (y + 1) % 10 === 0;
      const room = base.rooms[name];
      assert.ok(room);
      assert.equal(room.status, 'normal');
      assert.equal(base.terrain[name]?.length, 2500);
      if (highway) {
        assert.equal(room.bus, true, name);
        assert.ok(room.depositType, name);
        const crossroad = (x + 1) % 10 === 0 && (y + 1) % 10 === 0;
        const objects = objectsIn(base, name);
        assert.equal(objects.length, crossroad ? 1 : 0, name);
        if (crossroad) {
          assert.equal(objects[0]?.type, 'terminal');
          assert.equal(objects[0].user, undefined);
        }
      }
    }

    assert.equal(objectsIn(base, 'W5N5', 'controller').length, 0);
    assert.equal(objectsIn(base, 'W5N5', 'source').length, 3);
    assert.equal(objectsIn(base, 'W5N5', 'keeperLair').length, 0);
    assert.equal(objectsIn(base, 'W5N5', 'extractor').length, 1);
    for (const name of ['W4N4', 'W4N5', 'W4N6', 'W5N4', 'W5N6', 'W6N4', 'W6N5', 'W6N6']) {
      assert.equal(base.rooms[name]?.sourceKeepers, true, name);
      assert.equal(objectsIn(base, name, 'controller').length, 0, name);
      assert.equal(objectsIn(base, name, 'source').length, 3, name);
      assert.equal(objectsIn(base, name, 'keeperLair').length, 4, name);
      const [mineral] = objectsIn(base, name, 'mineral');
      const [extractor] = objectsIn(base, name, 'extractor');
      assert.ok(mineral && extractor);
      assert.deepEqual([extractor.x, extractor.y], [mineral.x, mineral.y]);
    }
    for (const name of ['W2N2', 'W8N3', 'W3N8']) {
      assert.equal(objectsIn(base, name, 'controller').length, 1, name);
      const sources = objectsIn(base, name, 'source').length;
      assert.ok(sources >= 1 && sources <= 2, name);
      assert.equal(objectsIn(base, name, 'mineral').length, 1, name);
      for (const object of objectsIn(base, name)) {
        assert.ok(
          isWall(base.terrain[name] as string, object.x, object.y),
          `${name} ${object.type} sits in a wall`,
        );
      }
    }
  });

  void it('matches exits between neighbors, walls the border and keeps every open tile reachable', () => {
    for (const name of Object.keys(base.rooms)) {
      const [x, y] = roomNameToXY(name);
      const terrain = base.terrain[name] as string;
      const right = base.terrain[roomNameFromXY(x + 1, y)];
      const below = base.terrain[roomNameFromXY(x, y + 1)];
      if (right === undefined) assert.deepEqual(exitsOf(terrain, 'right'), [], name);
      else {
        assert.ok(exitsOf(terrain, 'right').length > 0, name);
        assert.deepEqual(exitsOf(terrain, 'right'), exitsOf(right, 'left'), name);
      }
      if (below === undefined) assert.deepEqual(exitsOf(terrain, 'bottom'), [], name);
      else {
        assert.ok(exitsOf(terrain, 'bottom').length > 0, name);
        assert.deepEqual(exitsOf(terrain, 'bottom'), exitsOf(below, 'top'), name);
      }
      if (base.terrain[roomNameFromXY(x - 1, y)] === undefined)
        assert.deepEqual(exitsOf(terrain, 'left'), []);
      if (base.terrain[roomNameFromXY(x, y - 1)] === undefined)
        assert.deepEqual(exitsOf(terrain, 'top'), []);
    }

    // world-wide flood fill over open tiles, crossing room edges like creeps do
    let open = 0;
    for (const terrain of Object.values(base.terrain)) {
      for (let i = 0; i < 2500; i++) if (!(Number(terrain.charAt(i)) & 1)) open++;
    }
    const startTerrain = base.terrain.W2N2 as string;
    const start = Array.from(startTerrain).findIndex((c) => !(Number(c) & 1));
    const seen = new Set<string>([`W2N2:${String(start)}`]);
    const queue: Array<[string, number, number]> = [['W2N2', start % 50, Math.floor(start / 50)]];
    while (queue.length) {
      const [room, x, y] = queue.pop() as [string, number, number];
      const [rx, ry] = roomNameToXY(room);
      const next: Array<[string, number, number]> = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if ((dx || dy) && x + dx >= 0 && x + dx <= 49 && y + dy >= 0 && y + dy <= 49)
            next.push([room, x + dx, y + dy]);
        }
      }
      if (x === 0) next.push([roomNameFromXY(rx - 1, ry), 49, y]);
      if (x === 49) next.push([roomNameFromXY(rx + 1, ry), 0, y]);
      if (y === 0) next.push([roomNameFromXY(rx, ry - 1), x, 49]);
      if (y === 49) next.push([roomNameFromXY(rx, ry + 1), x, 0]);
      for (const [nRoom, nx, ny] of next) {
        const terrain = base.terrain[nRoom];
        const key = `${nRoom}:${String(ny * 50 + nx)}`;
        if (terrain !== undefined && !isWall(terrain, nx, ny) && !seen.has(key)) {
          seen.add(key);
          queue.push([nRoom, nx, ny]);
        }
      }
    }
    assert.equal(seen.size, open);
  });

  void it('links sector centers with portals landing next to the paired cluster', () => {
    const world = createWorld({ size: 21, seed: 3, shardName: 'shard0' });
    const centers = ['W5N5', 'W15N5', 'W5N15', 'W15N15'];
    for (const center of centers) {
      const portals = objectsIn(world, center, 'portal');
      assert.equal(portals.length, 8, center);
      assert.equal(objectsIn(world, center, 'constructedWall').length, 1);
      const target = portals[0]?.destination?.room as string;
      assert.ok(centers.includes(target) && target !== center);
      for (const portal of portals) {
        const destination = portal.destination;
        assert.ok(destination);
        assert.equal(destination.room, target);
        assert.ok(!isWall(world.terrain[target] as string, destination.x, destination.y));
        assert.equal(
          objectsIn(world, target).filter((o) => o.x === destination.x && o.y === destination.y)
            .length,
          0,
        );
      }
    }
  });

  void it('generates single rooms matching neighbors and removes them', () => {
    const world = structuredClone(base);
    assert.throws(() => {
      generateRoom(world, 'nowhere');
    }, /Invalid room name/);
    assert.throws(() => {
      generateRoom(world, 'W2N2');
    }, /already exists/);
    assert.throws(() => {
      generateRoom(world, 'W11N5', { exits: { right: [10, 11] } });
    }, /Exits in room W10N5 don't match/);
    generateRoom(world, 'W11N5');
    assert.deepEqual(
      exitsOf(world.terrain.W11N5 as string, 'right'),
      exitsOf(world.terrain.W10N5 as string, 'left'),
    );
    assert.equal(objectsIn(world, 'W11N5', 'controller').length, 1);

    generateRoom(world, 'E3S3', {
      sources: 2,
      mineral: 'X',
      controller: true,
      terrainType: 2,
      swampType: 3,
    });
    assert.equal(objectsIn(world, 'E3S3', 'source').length, 2);
    assert.equal(objectsIn(world, 'E3S3', 'mineral')[0]?.mineralType, 'X');
    assert.ok(world.activeRooms.includes('E3S3'));

    removeRoom(world, 'E3S3');
    assert.equal(world.rooms.E3S3, undefined);
    assert.equal(world.terrain.E3S3, undefined);
    assert.equal(objectsIn(world, 'E3S3').length, 0);
    assert.throws(() => {
      removeRoom(world, 'E3S3');
    }, /not found/);

    createPortalPair(world, 'W2N2', 'W8N8', { decayTime: 100 });
    assert.equal(objectsIn(world, 'W2N2', 'portal').length, 8);
    assert.equal(objectsIn(world, 'W8N8', 'portal')[0]?.destination?.room, 'W2N2');
  });
});

void describe('maintenance jobs', () => {
  void it('runs on persisted wall-clock intervals without replaying after restart', () => {
    const state = stateOf();
    const all = runMaintenance(state, NOW);
    assert.equal(all.ran.length, 11);
    assert.deepEqual(all.errors, []);
    assert.deepEqual(runMaintenance(state, NOW + 1000).ran, []);
    assert.deepEqual(runMaintenance(state, NOW + 20_001).ran, ['roomsForceUpdate']);
    // a restored state keeps its schedule
    const restored: ServerState = { ...state, jobs: structuredClone(state.jobs) };
    assert.deepEqual(runMaintenance(restored, NOW + 60_001).ran, [
      'sendNotifications',
      'roomsForceUpdate',
    ]);
    assert.throws(() => {
      runJob(state, 'nope', NOW);
    }, /Cronjob "nope" not found/);
  });

  void it('force-activates sleeping rooms except closed ones', () => {
    const state = stateOf();
    state.world.activeRooms = [];
    const closed = state.world.rooms.W2N2;
    assert.ok(closed);
    closed.status = 'out of borders';
    runJob(state, 'roomsForceUpdate', NOW);
    assert.equal(state.world.activeRooms.length, 120);
    assert.ok(!state.world.activeRooms.includes('W2N2'));
    const next = state.jobs['forceUpdate:W3N3'] as number;
    assert.ok(next >= state.world.gameTime + 90 && next < state.world.gameTime + 110);
    state.world.activeRooms = [];
    runJob(state, 'roomsForceUpdate', NOW);
    assert.deepEqual(state.world.activeRooms, []);
  });

  void it('schedules and spawns power banks in highway rooms', () => {
    const state = stateOf();
    const world = state.world;
    world.gameTime = 1000;
    runJob(state, 'genPowerBanks', NOW);
    const room = world.rooms.W10N5;
    assert.ok(room?.powerBankTime);
    assert.ok(room.powerBankTime >= 1000 + 37500 && room.powerBankTime <= 1000 + 62500);
    room.powerBankTime = 1000;
    world.activeRooms = [];
    runJob(state, 'genPowerBanks', NOW);
    const [bank] = objectsIn(world, 'W10N5', 'powerBank');
    assert.ok(bank);
    assert.equal(bank.hits, C.POWER_BANK_HITS);
    assert.equal(bank.decayTime, 1000 + C.POWER_BANK_DECAY);
    const power = bank.store?.power ?? 0;
    assert.ok(power >= C.POWER_BANK_CAPACITY_MIN && power < 2 * C.POWER_BANK_CAPACITY_MAX);
    assert.ok(isWall(world.terrain.W10N5 as string, bank.x, bank.y));
    assert.deepEqual(world.activeRooms, ['W10N5']);
  });

  void it('replenishes NPC terminal orders once per period', () => {
    const state = stateOf();
    runJob(state, 'recreateNpcOrders', NOW);
    const orders = Object.values(state.world.marketOrders);
    const rooms = new Set(orders.map((o) => o.roomName));
    assert.deepEqual([...rooms].sort(), ['W0N0', 'W0N10', 'W10N0', 'W10N10']);
    for (const order of orders) {
      assert.equal(order.user, undefined);
      assert.equal(order.active, true);
      assert.equal(order.createdTimestamp, NOW);
      assert.equal(order.remainingAmount, order.amount);
    }
    const sell = orders.find((o) => o.type === 'sell' && o.resourceType !== 'energy');
    assert.ok(sell);
    assert.equal(sell.amount, 200_000);
    const sellPrices: Record<string, number> = { H: 3000, O: 3000, X: 18000 };
    assert.equal(sell.price, sellPrices[sell.resourceType] ?? 6000);
    const ids = Object.keys(state.world.marketOrders).sort();
    runJob(state, 'recreateNpcOrders', NOW);
    assert.deepEqual(Object.keys(state.world.marketOrders).sort(), ids);
    state.world.gameTime = (state.jobs['npcOrders:W0N0'] as number) + 1;
    runJob(state, 'recreateNpcOrders', NOW);
    assert.notDeepEqual(Object.keys(state.world.marketOrders).sort(), ids);
  });

  void it('keeps the latest 100 transactions per sender and per recipient', () => {
    const state = stateOf();
    for (let i = 0; i < 150; i++) {
      const id = `t${String(i)}`;
      state.world.transactions[id] = {
        _id: id,
        time: i,
        sender: 'a',
        recipient: 'b',
        resourceType: 'H',
        amount: 1,
        from: 'W1N1',
        to: 'W2N2',
      };
    }
    state.world.transactions.unique = {
      _id: 'unique',
      time: 0,
      sender: 'a',
      recipient: 'c',
      resourceType: 'H',
      amount: 1,
      from: 'W1N1',
      to: 'W2N2',
    };
    runJob(state, 'purgeTransactions', NOW);
    const kept = Object.keys(state.world.transactions);
    assert.equal(kept.length, 101);
    assert.ok(kept.includes('unique'));
    assert.ok(kept.includes('t149') && kept.includes('t50') && !kept.includes('t49'));
  });

  void it('computes daily market statistics from the last 14 days of sales', () => {
    const state = stateOf();
    const sale = (
      id: string,
      date: number,
      amount: number,
      price: number,
      type = 'market.sell',
    ): void => {
      state.world.usersMoney[id] = {
        _id: id,
        date,
        tick: 1,
        user: 'u',
        type,
        balance: 0,
        change: amount * price,
        market: { resourceType: 'H', amount, price },
      };
    };
    sale('a', NOW - 1000, 10, 2);
    sale('b', NOW - 2000, 30, 4);
    sale('old', NOW - 15 * 24 * 3600 * 1000, 99, 99);
    sale('buy', NOW - 1000, 99, 99, 'market.buy');
    state.world.marketStats.stale = {
      _id: 'stale',
      resourceType: 'O',
      date: '2000-01-01',
      transactions: 1,
      volume: 1,
      avgPrice: 1,
      stddevPrice: 0,
    };
    runJob(state, 'calcMarketStats', NOW);
    const stats = Object.values(state.world.marketStats);
    assert.equal(stats.length, 1);
    const [stat] = stats;
    assert.ok(stat);
    assert.equal(stat.resourceType, 'H');
    assert.match(stat.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(stat.transactions, 2);
    assert.equal(stat.volume, 40);
    assert.equal(stat.avgPrice, 3.5);
    assert.equal(stat.stddevPrice, 0.866);
  });

  void it('deletes power creeps after their delete time and refunds one power level', () => {
    const state = stateOf();
    const world = state.world;
    world.users.p = { _id: 'p', username: 'P', power: 4000 };
    const creep = (id: string, deleteTime: number): void => {
      world.userPowerCreeps[id] = {
        _id: id,
        user: 'p',
        name: id,
        className: 'operator',
        level: 0,
        hitsMax: 1000,
        store: {},
        storeCapacity: 100,
        spawnCooldownTime: null,
        deleteTime,
        powers: {},
      };
    };
    creep('due', NOW - 1);
    creep('later', NOW + 1000);
    runJob(state, 'deletePowerCreeps', NOW);
    assert.deepEqual(Object.keys(world.userPowerCreeps), ['later']);
    assert.equal(world.users.p.power, 1000);
  });

  void it('batches notifications into the outbox respecting preferences and intervals', () => {
    const state = stateOf();
    const world = state.world;
    world.users.a = { _id: 'a', username: 'A' };
    world.users.b = { _id: 'b', username: 'B' };
    state.profiles.a = { registeredDate: 0, email: 'a@example.com' };
    state.profiles.b = {
      registeredDate: 0,
      notifyPrefs: { disabled: true },
      email: 'b@example.com',
    };
    const notify = (id: string, user: string, date: number): void => {
      world.notifications[id] = {
        _id: id,
        user,
        message: `msg ${id}`,
        date,
        type: 'msg',
        count: 2,
      };
    };
    notify('1', 'a', NOW - 10);
    notify('2', 'a', NOW - 5);
    notify('3', 'b', NOW - 5);
    notify('future', 'a', NOW + 10);
    runJob(state, 'sendNotifications', NOW);
    assert.equal(state.notificationOutbox.length, 1);
    assert.deepEqual(
      {
        userId: state.notificationOutbox[0]?.userId,
        email: state.notificationOutbox[0]?.email,
        messages: state.notificationOutbox[0]?.messages,
      },
      { userId: 'a', email: 'a@example.com', messages: ['msg 1\n[msg] (2)', 'msg 2\n[msg] (2)'] },
    );
    assert.deepEqual(Object.keys(world.notifications), ['future']);
    // the default interval is 60 minutes
    runJob(state, 'sendNotifications', NOW + 59 * 60_000);
    assert.equal(state.notificationOutbox.length, 1);
    runJob(state, 'sendNotifications', NOW + 61 * 60_000);
    assert.equal(state.notificationOutbox.length, 2);
  });

  void it('spawns strongholds, invader raids only in sectors with a core, and expands strongholds', () => {
    const state = stateOf();
    const world = state.world;
    world.gameTime = 100;
    const sources = objectsIn(world, 'W2N2', 'source');
    for (const source of sources) source.invaderHarvested = C.INVADERS_ENERGY_GOAL;
    world.activeRooms = [];
    runJob(state, 'genInvaders', NOW);
    assert.equal(Object.values(world.roomObjects).filter((o) => o.type === 'creep').length, 0);

    runJob(state, 'genStrongholds', NOW);
    const cores = Object.values(world.roomObjects).filter((o) => o.type === 'invaderCore');
    assert.equal(cores.length, 1);
    const [core] = cores;
    assert.ok(core);
    assert.ok(world.rooms[core.room]?.sourceKeepers, 'strongholds live in keeper rooms');
    assert.equal(core.deployTime, 100 + 5000);
    assert.equal(core.user, '2');
    assert.equal(core.strongholdId, `${core.room}_100`);
    assert.ok(
      Object.values(world.roomObjects).some(
        (o) => o.type === 'rampart' && o.strongholdId === core.strongholdId,
      ),
    );
    runJob(state, 'genStrongholds', NOW);
    assert.equal(
      Object.values(world.roomObjects).filter((o) => o.type === 'invaderCore').length,
      1,
    );

    world.activeRooms = [];
    runJob(state, 'genInvaders', NOW);
    const invaders = objectsIn(world, 'W2N2', 'creep');
    assert.ok(invaders.length >= 1);
    for (const invader of invaders) {
      assert.equal(invader.user, '2');
      assert.ok(invader.x === 0 || invader.x === 49 || invader.y === 0 || invader.y === 49);
      assert.match(invader.name ?? '', /^invader_W2N2_\d+$/);
    }
    assert.ok(sources.every((s) => s.invaderHarvested === 0));
    assert.ok(world.activeRooms.includes('W2N2'));

    core.deployTime = null;
    core.nextExpandTime = 50;
    runJob(state, 'expandStrongholds', NOW);
    const lesser = Object.values(world.roomObjects).filter(
      (o) => o.type === 'invaderCore' && o.level === 0,
    );
    assert.equal(lesser.length, 1);
    assert.equal(lesser[0]?.strongholdId, core.strongholdId);
    assert.equal(objectsIn(world, lesser[0].room, 'controller').length, 1);
    const expansionDelay = (C.INVADER_CORE_EXPAND_TIME as Record<number, number>)[core.level ?? 1];
    assert.ok(expansionDelay !== undefined);
    assert.equal(core.nextExpandTime, 100 + expansionDelay);

    assert.throws(() => {
      spawnStronghold(world, 'W5N5', { templateName: 'nope' });
    }, /invalid template/);
  });

  void it('generates deposits in free highway rooms of the sector', () => {
    const state = stateOf();
    state.world.gameTime = 10;
    runJob(state, 'genDeposits', NOW);
    const deposits = Object.values(state.world.roomObjects).filter((o) => o.type === 'deposit');
    assert.equal(deposits.length, 1);
    const [deposit] = deposits;
    assert.ok(deposit);
    assert.equal(deposit.depositType, state.world.rooms[deposit.room]?.depositType);
    assert.equal(deposit.decayTime, 10 + C.DEPOSIT_DECAY_TIME);
    assert.ok(state.world.rooms[deposit.room]?.bus);
  });
});

void describe('bot players', () => {
  void it('spawns, reports status and removes a bot leaving ruins', () => {
    const state = stateOf();
    const context = contextOf(state);
    const { userId, username } = spawnBot(
      context,
      'simplebot',
      { main: 'module.exports.loop = function () {};' },
      'W2N2',
      { gcl: 2 },
    );
    assert.match(username, /^[A-Za-z]+Bot$/);
    const user = state.world.users[userId];
    assert.equal(user?.bot, 'simplebot');
    assert.equal(user.gcl, C.GCL_MULTIPLY);
    const [controller] = objectsIn(state.world, 'W2N2', 'controller');
    assert.equal(controller?.user, userId);
    assert.equal(controller.level, 1);
    const [spawn] = objectsIn(state.world, 'W2N2', 'spawn');
    assert.ok(spawn && !isWall(state.world.terrain.W2N2 as string, spawn.x, spawn.y));
    assert.equal(getUserWorldStatus(state.world, userId), 'normal');
    assert.throws(() => {
      spawnBot(context, 'simplebot', {}, 'W2N2');
    }, /already owned/);

    removeBot(context, username);
    assert.equal(state.world.users[userId], undefined);
    assert.equal(controller.user, null);
    assert.equal(controller.level, 0);
    const [ruin] = objectsIn(state.world, 'W2N2', 'ruin');
    assert.equal(ruin?.structure?.type, 'spawn');
    assert.equal(state.world.users[ruin.user as string]?.username, C.SYSTEM_USERNAME);
    assert.ok(Object.values(state.branches).every((branch) => branch.user !== userId));
    assert.throws(() => {
      removeBot(context, username);
    }, /User not found/);
  });
});
