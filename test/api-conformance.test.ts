/*
 * End-to-end contract conformance: a complete server (`createServer`, SQLite, real Nest HTTP
 * routing, guards, locking and transactions) is driven only through the generated OpenScreeps
 * client. Every response is validated against `api/openapi.json`, every composed operation must
 * be exercised, and every operation must succeed at least once.
 *
 * Outbound Steam Web API calls are answered by a local stub; nothing leaves the machine.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import { createClient, operationIds } from '../src/generated/api/index.ts';
import { createServer, type RunningServer } from '../src/server.ts';
import { ContractRecorder } from './contract-harness.ts';

const PASSWORD = 'conformance-password';
const STEAM_ID = '76561198000000001';

/** Answers the server's Steam Web API requests (ticket verification and the news feed). */
function steamStub(original: typeof fetch): typeof fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname !== 'api.steampowered.com') return original(input, init);
    if (url.pathname.startsWith('/ISteamUserAuth/AuthenticateUserTicket/')) {
      return Promise.resolve(
        Response.json({
          response: {
            params: {
              result: 'OK',
              steamid: STEAM_ID,
              ownersteamid: STEAM_ID,
              vacbanned: false,
              publisherbanned: false,
            },
          },
        }),
      );
    }
    if (url.pathname.startsWith('/ISteamNews/GetNewsForApp/')) {
      return Promise.resolve(
        Response.json({
          appnews: {
            appid: 464350,
            count: 1,
            newsitems: [
              {
                gid: '1',
                title: 'Conformance',
                url: 'https://store.steampowered.com/news/app/464350',
                is_external_url: false,
                author: 'Screeps',
                contents: 'Conformance news item',
                feedlabel: 'Community Announcements',
                date: 1_700_000_000,
                feedname: 'steam_community_announcements',
                feed_type: 1,
                appid: 464350,
              },
            ],
          },
        }),
      );
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };
}

interface SpawnSite {
  room: string;
  x: number;
  y: number;
}

/** A free 5x5 plain area (no objects, away from exits) in an unowned room with a controller. */
function findSpawnSite(server: RunningServer): Promise<SpawnSite> {
  const { context } = server;
  return context.read(() => {
    const { world } = context.state;
    for (const room of Object.keys(world.rooms).sort()) {
      const terrain = world.terrain[room];
      if (world.rooms[room]?.status !== 'normal' || terrain === undefined) continue;
      const objects = Object.values(world.roomObjects).filter((object) => object.room === room);
      const controller = objects.find((object) => object.type === 'controller');
      if (!controller || controller.user) continue;
      for (let y = 6; y <= 43; y++) {
        for (let x = 6; x <= 43; x++) {
          let free = true;
          for (let dy = -2; dy <= 2 && free; dy++) {
            for (let dx = -2; dx <= 2 && free; dx++) {
              free =
                terrain.charAt((y + dy) * 50 + x + dx) === '0' &&
                !objects.some((object) => object.x === x + dx && object.y === y + dy);
            }
          }
          if (free) return { room, x, y };
        }
      }
    }
    throw new Error('the generated world has no free controller room');
  });
}

void describe('HTTP contract conformance', () => {
  void it('serves every composed operation with contract-valid responses', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openscreeps-conformance-'));
    const realFetch = globalThis.fetch.bind(globalThis);
    const recorder = new ContractRecorder(realFetch);
    const adminToken = randomBytes(32).toString('hex');
    const server = await createServer({
      database: join(directory, 'world.sqlite'),
      host: '127.0.0.1',
      port: 0,
      worldSize: 3,
      paused: true,
      adminToken,
      steamKey: 'conformance-steam-key',
    });
    try {
      mock.method(globalThis, 'fetch', steamStub(realFetch));
      const baseUrl = `http://127.0.0.1:${String(server.address.port)}`;
      const anonymous = createClient({ baseUrl, fetch: recorder.fetch });
      const admin = createClient({
        baseUrl,
        credentials: { AdminToken: adminToken },
        fetch: recorder.fetch,
      });

      // --- public platform and world information ----------------------------------------
      assert.match(await anonymous.platformRoot({}), /OpenScreeps/);
      const version = await anonymous.platformVersion({});
      assert.equal(version.protocol, 14);
      // Clients identify an OpenScreeps server by this feature.
      assert.deepEqual(
        version.serverData.features.find((feature) => feature.name === 'openscreeps'),
        { name: 'openscreeps', version: 1 },
      );
      assert.equal((await anonymous.platformHealth({})).paused, true);
      await anonymous.gameTime({});
      await anonymous.gameTick({});
      await anonymous.gameWorldSize({});
      await anonymous.platformActivePromotion({});
      await anonymous.platformSteamNews({});
      await anonymous.leaderboardSeasons({});
      await anonymous.leaderboardList({ query: { mode: 'world' } });
      await anonymous.registerCheckEmail({ query: { email: 'free@example.com' } });
      await anonymous.registerCheckUsername({ query: { username: 'FreeName' } });
      await anonymous.registerSubmit({
        body: {
          username: 'Registered',
          email: 'registered@example.com',
          password: PASSWORD,
          modules: { main: 'module.exports.loop = function () {};' },
        },
      });
      const duplicate = await anonymous.send('registerSubmit', {
        body: { username: 'registered', email: 'other@example.com', password: PASSWORD },
      });
      assert.deepEqual(duplicate.body, { error: 'username already exists' });
      await anonymous.authSignin({ body: { email: 'registered@example.com', password: PASSWORD } });

      // --- administration ---------------------------------------------------------------
      assert.equal((await admin.adminStatus({})).paused, true);
      await admin.adminCommand({
        body: { action: 'user-create', username: 'Conformance', password: PASSWORD, cpu: 100 },
      });
      await admin.adminCommand({
        body: { action: 'user-create', username: 'Respondent', password: PASSWORD, cpu: 100 },
      });
      await admin.adminCommand({
        body: { action: 'user-update', username: 'Conformance', power: 4000 },
      });

      // --- Steam sign-in, username selection ------------------------------------------------
      const steam = await anonymous.authSteamTicket({ body: { ticket: 'ABCD' } });
      assert.equal(steam.steamid, STEAM_ID);
      const steamPlayer = createClient({
        baseUrl,
        credentials: { Token: steam.token },
        fetch: recorder.fetch,
      });
      const unnamed = await steamPlayer.send('userName', {});
      assert.deepEqual(unnamed.body, { error: 'username not set' });
      await steamPlayer.registerSetUsername({ body: { username: 'SteamPlayer' } });
      assert.equal((await steamPlayer.userName({})).username, 'SteamPlayer');

      // --- password sign-in ---------------------------------------------------------------
      const signin = await anonymous.authSignin({
        body: { email: 'Conformance', password: PASSWORD },
      });
      const player = createClient({
        baseUrl,
        credentials: { Token: signin.token },
        fetch: recorder.fetch,
      });
      const me = await player.authMe({});
      assert.equal(me.username, 'Conformance');
      const respondentSignin = await anonymous.authSignin({
        body: { email: 'Respondent', password: PASSWORD },
      });
      const respondent = createClient({
        baseUrl,
        credentials: { Token: respondentSignin.token },
        fetch: recorder.fetch,
      });
      const respondentMe = await respondent.authMe({});

      // --- account and code -----------------------------------------------------------------
      await player.userWorldStatus({});
      await player.userWorldStartRoom({});
      await player.userRespawnProhibitedRooms({});
      await player.userBranches({});
      await player.userCodeSet({
        body: { branch: 'default', modules: { main: 'module.exports.loop = function () {};' } },
      });
      await player.userCodeGet({ query: { branch: 'default' } });
      await player.userCloneBranch({ body: { branch: 'default', newName: 'conformance' } });
      await player.userSetActiveBranch({
        body: { branch: 'conformance', activeName: 'activeSim' },
      });
      await player.userCloneBranch({ body: { branch: 'default', newName: 'scratch' } });
      await player.userDeleteBranch({ body: { branch: 'scratch' } });
      await player.userMemorySet({ body: { path: 'conformance', value: { checked: true } } });
      await player.userMemoryGet({ query: { path: 'conformance' } });
      await player.userMemorySegmentSet({ body: { segment: 1, data: 'segment' } });
      await player.userMemorySegmentGet({ query: { segment: '1' } });
      await player.userConsole({ body: { expression: '1 + 1' } });
      await player.userFind({ query: { username: 'Conformance' } });
      await player.userBadgeSet({
        body: {
          badge: {
            type: 3,
            color1: '#112233',
            color2: '#445566',
            color3: '#778899',
            param: 10,
            flip: true,
          },
        },
      });
      assert.match(await anonymous.userBadgeSvg({ query: { username: 'Conformance' } }), /<svg/);
      const missingBadge = await anonymous.send('userBadgeSvg', { query: { username: 'Nobody' } });
      assert.equal(missingBadge.status, 404);
      await player.userNotifyPrefsSet({ body: { interval: 60 } });
      await player.userEmailSet({ body: { email: 'conformance@example.com' } });
      await player.userSetSteamVisible({ body: { visible: true } });
      await player.userTutorialDone({});
      await player.userMoneyHistory({});
      await player.userStats({ query: { id: me._id, interval: 8 } });
      await player.userOverview({ query: { interval: 8, statName: 'energyHarvested' } });
      await player.userDecorationsInventory({});
      await player.userDecorationsThemes({});

      // --- world and gameplay ---------------------------------------------------------------
      const { room, x, y } = await findSpawnSite(server);
      await anonymous.gameRoomTerrain({ query: { room } });
      await anonymous.gameRoomTerrain({ query: { room, encoded: '1' } });
      await anonymous.gameRooms({ body: { rooms: [room] } });
      await anonymous.gameRoomDecorations({ query: { room } });
      await player.gameRoomStatus({ query: { room } });
      await player.gameMapStats({ body: { rooms: [room], statName: 'owner0' } });
      await player.gameRoomOverview({ query: { room, interval: 8 } });
      await player.gameGenUniqueObjectName({ body: { type: 'spawn' } });
      await player.gameCheckUniqueObjectName({ body: { type: 'spawn', name: 'ConformanceSpawn' } });
      await player.gamePlaceSpawn({ body: { room, x, y, name: 'ConformanceSpawn' } });
      const roomObjects = await anonymous.gameRoomObjects({ query: { room } });
      const spawn = roomObjects.objects.find((object) => object.type === 'spawn');
      assert.ok(spawn, 'room-objects lists the placed spawn');
      assert.equal(spawn.user, me._id);
      assert.ok(Object.hasOwn(roomObjects.users, me._id));
      const found = await anonymous.gameFindObject({ query: { _id: spawn._id } });
      assert.equal(found.object?.room, room);
      // Exactly one active novice area room, whatever the generated world contained.
      const noviceEnd = server.context.now() + 24 * 3600 * 1000;
      await server.context.mutate(() => {
        for (const [name, info] of Object.entries(server.context.state.world.rooms)) {
          info.novice = name === room ? noviceEnd : null;
        }
      });
      const novice = await anonymous.gameRandomNoviceRoom({});
      assert.equal(novice.room, room);
      await server.context.mutate(() => {
        for (const info of Object.values(server.context.state.world.rooms)) info.novice = null;
      });
      assert.equal((await anonymous.gameRandomNoviceRoom({})).room, undefined);
      await player.userRooms({ query: { id: me._id } });
      await player.gameCreateConstruction({
        body: { room, x: x + 2, y, structureType: 'road' },
      });
      await player.gameCreateFlag({
        body: { room, x: x - 2, y, name: 'ConformanceFlag', color: 1, secondaryColor: 1 },
      });
      await player.gameGenUniqueFlagName({});
      await player.gameCheckUniqueFlagName({ body: { name: 'UnusedFlag' } });
      await player.gameChangeFlagColor({
        body: { room, name: 'ConformanceFlag', color: 2, secondaryColor: 3 },
      });
      await player.gameRemoveFlag({ body: { room, name: 'ConformanceFlag' } });
      await player.gameSetNotifyWhenAttacked({ body: { _id: spawn._id, enabled: false } });
      await player.gameAddObjectIntent({
        body: { room, _id: spawn._id, name: 'notifyWhenAttacked', intent: { enabled: true } },
      });
      await player.gameAddGlobalIntent({ body: { name: 'notAnIntent', intent: {} } });
      const invader = await player.gameCreateInvader({
        body: { room, x, y: y + 2, size: 'small', type: 'Melee' },
      });
      await player.gameRemoveInvader({ body: { _id: invader._id } });

      // --- power creeps ---------------------------------------------------------------------
      await player.powerCreepsList({});
      const powerCreep = await player.powerCreepsCreate({
        body: { className: 'operator', name: 'ConformanceOperator' },
      });
      await player.powerCreepsRename({ body: { id: powerCreep._id, name: 'RenamedOperator' } });
      await player.powerCreepsUpgrade({ body: { id: powerCreep._id, powers: { 1: 1 } } });
      await player.powerCreepsDelete({ body: { id: powerCreep._id } });
      await player.powerCreepsCancelDelete({ body: { id: powerCreep._id } });
      await player.powerCreepsExperimentation({});

      // --- market ---------------------------------------------------------------------------
      await player.marketOrdersIndex({});
      await player.marketOrders({ query: { resourceType: 'energy' } });
      await player.marketMyOrders({});
      await player.marketStats({ query: { resourceType: 'energy' } });

      // --- messages -------------------------------------------------------------------------
      await player.userMessagesSend({ body: { respondent: respondentMe._id, text: 'Hello' } });
      await respondent.userMessagesIndex({});
      assert.equal((await respondent.userMessagesUnreadCount({})).count, 1);
      const conversation = await respondent.userMessagesList({ query: { respondent: me._id } });
      const incoming = conversation.messages.find((message) => message.type === 'in');
      assert.ok(incoming);
      await respondent.userMessagesMarkRead({ body: { id: incoming._id } });

      // --- ticks, history, assets and leaderboard lookups -----------------------------------
      await admin.adminCommand({ body: { action: 'tick', count: 1 } });
      const historyTime = await server.context.read(
        () => server.context.state.history[room]?.[0]?.time,
      );
      assert.ok(historyTime !== undefined, `tick recorded history for ${room}`);
      const history = await anonymous.platformRoomHistory({ query: { room, time: historyTime } });
      assert.equal(history.base, historyTime);
      const image = await anonymous.platformAsset({ path: { path: `map/${room}.png` } });
      assert.ok(image.byteLength > 0);
      const missingAsset = await anonymous.send('platformAsset', {
        path: { path: 'map/missing.txt' },
      });
      assert.equal(missingAsset.status, 404);
      await anonymous.leaderboardFind({ query: { mode: 'world', username: 'Conformance' } });

      // --- respawn last: it removes the player's rooms ---------------------------------------
      await player.userRespawn({});
      assert.equal((await player.userWorldStatus({})).status, 'empty');
      const details = await player.userMoneyHistoryDetails({
        query: { tick: historyTime, roomName: room, targetRoomName: room },
      });
      assert.deepEqual(details.orders, []);

      // --- password change revokes every session ----------------------------------------------
      const wrongPassword = await respondent.send('userPasswordSet', {
        body: { oldPassword: 'not-the-password', password: 'replacement-password-1' },
      });
      assert.deepEqual(wrongPassword.body, { error: 'invalid password' });
      const changed = await player.send('userPasswordSet', {
        body: { oldPassword: PASSWORD, password: 'replacement-password-1' },
      });
      assert.deepEqual(changed.body, { ok: 1 });
      // The refresh issued for this request was revoked with every other session.
      assert.equal(changed.headers.get('X-Token'), null);
      assert.equal((await player.send('authMe', {})).status, 401);
      await anonymous.authSignin({
        body: { email: 'Conformance', password: 'replacement-password-1' },
      });

      assert.deepEqual(recorder.failures, []);
      assert.deepEqual(recorder.unexercised(), []);
      assert.deepEqual(recorder.unsuccessful(operationIds), []);
    } finally {
      mock.restoreAll();
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
