# OpenScreeps server

A standalone Screeps-compatible server in strict TypeScript, built with NestJS and
its default Express adapter. Uses [OpenScreeps game](https://github.com/openscreeps/game)
for headless world lifecycle and gameplay, built on the OpenScreeps engine for
simulation and isolated player JavaScript. The official game client remains unchanged;
this repository does not implement or distribute a replacement client.

## Development

```sh
mise install
mise run install
npm run check
```

Node 24.21.0 is pinned in `mise.toml`. The server pins the game dependency to a Git
revision; the game pins and owns its engine dependency. `mise run install` runs
`npm ci` from this repository, fetching both packages and compiling their sources
through their `prepare` scripts. No sibling checkouts are required. Installation
needs Git and network access to GitHub and the npm registry.
`isolated-vm` needs a supported prebuilt binary or a native build toolchain.
Checks include the generated API contract staleness check, strict TypeScript,
type-aware ESLint, Prettier, behavioral and HTTP contract conformance tests and
declaration compilation.

All server tests and helpers are TypeScript, checked by `npm run typecheck` and
run directly with `tsx` by `npm test`, retaining Node's process-isolated parallel
runner. Database ownership tests use real SQLite locks with a test-scoped zero
busy timeout instead of waiting for retries; production lock timeouts are unchanged.

SQLite tests run by default. Set `SCREEPS_TEST_DATABASE_URL` to a dedicated PostgreSQL
test database to run both backends; PostgreSQL cases create and remove isolated schemas.
The test role needs permission to create schemas. CI also has a PostgreSQL service job.

## Nest architecture and persistence

Controllers in `src/api/`, `src/http.ts` and `src/admin.ts` declare real Nest routes
and delegate to injectable classes in `src/services/`. There is no catch-all API
dispatcher. Every route is bound to an operation of the generated HTTP contract
(see [HTTP API contract](#http-api-contract)). Guards validate credentials;
`ApiInterceptor` holds the world's read or mutation lock while invoking ordinary API
operations, then serializes the committed result. Steam verification runs outside
that lock and commits through its service. Admin operations own their transactions.
Nested reads join the current transaction; nested mutations join a mutation but are
rejected inside a read. Detached callbacks cannot retain a transaction after its
owning operation settles.

`ServerKernel` composes `@openscreeps/game`'s `GameSession` rather than implementing
another tick loop. World generation, NPC maintenance, players, code branches and
gameplay operations live in that package. Server services adapt HTTP inputs and
outputs; credentials, socket publication, ORM transactions and timers remain here.
The persisted server snapshot shape is unchanged: game fields and host metadata
are committed together.

The server imports game APIs only. ESLint rejects direct engine imports in both
server source and tests; engine build-script approval covers the transitive dependency.

`PersistenceModule` configures Nest's TypeORM integration. `StateStore` uses the
`WorldSnapshot` and `RoomHistoryFrame` entities and repository transactions;
versioned migrations adopt existing SQLite `server_snapshot` tables without
replacing their worlds. Production schema synchronization is disabled. Both
databases store one atomic, versioned world snapshot, not separate relational rows
for every game object. Room history is the exception: it only grows and expires,
so each frame is one `server_room_history` row and the snapshot holds an empty
`history`. A flush inserts the recorded frames and deletes the expired ones in
the same transaction as the snapshot, which is rewritten only when it changed.
This keeps simulation, player runtime and server metadata committed together.

Mutations and ticks change the world in memory; the kernel flushes it to the
database every `commitTicks` ticks (`SCREEPS_COMMIT_TICKS`, `--commit-ticks`;
default 10), when changes stayed pending for `commitTicks` tick durations without
a tick (for example while paused), on `ServerKernel.flush()` and on a graceful
close. A flush writes one consistent world between operations. A crash loses
the changes since the last flush: up to `commitTicks` ticks, or `commitTicks`
tick durations of API and admin changes whose events were already published.
Notification batches queued since are lost; batches delivered since are
delivered again. `commitTicks: 1` flushes after every tick.

The SQLite driver is pinned to `better-sqlite3` 13's N-API implementation: version
12's native statement cleanup crashes on the pinned Linux Node runtime. The scoped
TypeORM peer override selects this driver without disabling peer checks globally.
Keep the SQLite integration and container checks when updating either dependency.

When embedding under npm's strict install-script policy, the consumer's policy
must approve the local game/engine source paths and the used native drivers.
TypeORM may install its older SQLite peer because dependency-level overrides do
not propagate to consumers. That unused peer's build can be denied: the server
explicitly injects its own `better-sqlite3` 13 driver.

## HTTP API contract

The server's HTTP contract is composed, never hand-maintained. The pinned
[`@openscreeps/openapi`](https://github.com/openscreeps/openapi) package provides
the official Screeps World specification, its standalone compatibility profile and
the composer; this repository owns the OpenScreeps extensions in
`api/extensions.json` (root page, health, terrain assets and the administrator API).
`scripts/generate-api.mjs` composes them with `composeProfile` and writes:

- `api/openapi.json` and `api/openapi.yaml`: this server's complete contract. Each
  operation carries `x-profile` (`required`, `adapted`, `addition` or `extension`,
  with the reason for every standalone adaptation). Official operations the profile
  excludes — hosted screeps.com services such as seasons, decorations trading, PTR,
  shard CPU allocation, scoped API tokens and shard listings — are absent, and the
  server does not serve them.
- `src/generated/api/`: the generated TypeScript client, operation manifest and
  request/response types (`index.ts`, `schema.ts`). Never edit these files.

```sh
npm run generate:api   # regenerate after changing api/extensions.json or the contract pin
npm run check:api      # fail if any generated artifact is missing or stale (part of `npm run check`)
```

Routes come from the contract: `@ApiOperation('gameTime', policy)` (player API under
`ApiGuard`/`ApiInterceptor`) and `@Operation('platformHealth')` (handlers that write
the whole body) register the method and path from the generated manifest and
constrain the handler's return type to the operation's generated success body
(`ok: 1` is added by the interceptor). Request input stays untrusted: services
validate `ApiRequest` themselves.

Conformance tests run against real registrations and real HTTP:

- `test/api-contract.test.ts` compares the routes Express actually dispatches with
  the composed operations (no missing, extra or duplicate route), and keeps server-owned
  schema rules (administrator commands, bot modules, standalone Steam ownership).
- `test/contract-types.ts` checks that handler compatibility preserves required fields,
  literal discriminants and typed dictionary values.
- `test/api-conformance.test.ts` starts a complete server with SQLite and drives it
  only through the generated client. Every response is validated against
  `api/openapi.json` (declared status, media type and JSON schema); every composed
  operation must be exercised and succeed at least once, with no operation exemptions.
  JSON Schema validation runs in the test harness, not on live ticks. Services still
  validate untrusted input and narrow domain response projections.

The generated client is published as `@openscreeps/server/client`. It imports only
the contract runtime (`@openscreeps/openapi/client-runtime`), never Nest, the game
or `isolated-vm`, and runs in Node and browsers:

```ts
import { createClient } from '@openscreeps/server/client';

const client = createClient({ baseUrl: 'http://127.0.0.1:21025' });
const { token } = await client.authSignin({ body: { email: 'Player', password: '...' } });
const player = createClient({ baseUrl: 'http://127.0.0.1:21025', credentials: { Token: token } });
console.log((await player.authMe({})).username);
```

The client sends credentials only for the operation's declared security scheme
(administrator tokens never reach player operations), rotates refreshed `X-Token`
values, rejects redirects instead of following them and never retries. The composed
document is also exported as `@openscreeps/server/openapi.json` and `.yaml`.

The current composition has **91 operations**: 84 selected official operations, two
private-server compatibility additions and five server-owned extensions. All 91 pass
the real HTTP conformance scenario. A compiled-server smoke also verifies password
authentication, code persistence across a SQLite restart, committed manual ticks and
terrain PNG decoding through the generated client.

## Compatibility evidence and transport boundaries

The [game conformance suite](https://github.com/openscreeps/game/blob/main/CONFORMANCE.md)
compares game operations and semantic state against pinned original backend,
common and LokiJS storage revisions. Its reports distinguish matches, narrowly
asserted retained divergences and unexpected failures. These comparisons do not
exercise this server's Nest HTTP routing, guards, error/status envelopes, JSON
serialization, database transactions or live socket transports. They are not
proof of end-to-end HTTP compatibility or private-MMO parity. Server behavioral
tests use real Nest HTTP requests; persistence tests separately cover SQLite
and, with `SCREEPS_TEST_DATABASE_URL`, PostgreSQL durability.

Server adapters pass power-creep names unchanged to the game: omitted and numeric
names become `"undefined"` and `"12"` respectively, and names are truncated to
50 characters. Code branch listings preserve absent `timestamp`, `activeWorld`
and `activeSim` fields rather than inventing defaults. Room opening/closing is
a no-op for missing rooms; removal passes the complete game state so pending
room intents are removed too. Removal deliberately retains users' room lists,
active-room scheduling and prior room event logs, as the original does.

Message dates are projected to ISO strings on HTTP and socket responses without
changing their stored numeric dates. Room subscriptions are selected on each
update, with the original two-room limit per user across all connections.

### Retained divergence: atomic request rollback ([server#4](https://github.com/openscreeps/server/issues/4))

The server retains an atomic transaction boundary even where original backend
operations perform partial writes before an error. The boundary is one
authenticated or writing HTTP API request: `ApiInterceptor` runs the controller
inside one `ServerKernel.mutate` call, and a thrown error — including game
errors reported as status 200 `{error}` envelopes — restores the state after the
last successful operation and discards queued publications. Each world-changing
admin action is likewise its own mutation (`tick N` applies each tick
separately); the Steam ticket route verifies outside the lock and then applies
its change through one mutation.

In `gameplay.flags.limit` (step 6), a refused move deletes the old flag before
reporting `flags limit exceeded` in the original and in the direct game API.
Over HTTP the old flag survives, together with the request's token refresh and
`lastOnline` update. The same boundary rolls back a player's activity change when
saving code to a missing branch. Do not weaken rollback to reproduce those
partial-write side effects. Embedders calling game operations directly inside
their own `mutate` get the same rollback; outside the server they get the game's
original partial-write behavior.

`GET /api/user/money-history` converts numeric game log dates to ISO-8601 strings
at the wire boundary, matching the original processor's `Date` values after its
JSON storage RPC. The underlying game/engine dates remain numeric for maintenance
arithmetic; the response projection does not mutate those logs.

Public `/api/game/market/orders` responses retain order owner `user` IDs, matching
the pinned backend. Authentication is still required and `/my-orders` remains
filtered to the authenticated user. No private account data is added. The former
owner-hiding exception is removed; see
[game#16](https://github.com/openscreeps/game/issues/16).

The wire fixes are tracked in [server#1](https://github.com/openscreeps/server/issues/1)
(power names), [server#2](https://github.com/openscreeps/server/issues/2)
(room intents) and [server#3](https://github.com/openscreeps/server/issues/3)
(money dates). The retained atomic boundary is tracked in
[server#4](https://github.com/openscreeps/server/issues/4).

## Run a world

```sh
npm run cli -- init --database data/world.sqlite --world-size 21 --seed 1
npm start -- --database data/world.sqlite
```

`init` creates a world and an admin token file beside the database, without
replacing existing files. The default world has 21 rooms per side. The server
listens on `127.0.0.1:21025`; use `--host 0.0.0.0` to expose it deliberately.
World data lives in SQLite by default, or PostgreSQL when `SCREEPS_DATABASE_URL`
is set. No MongoDB or Redis service is required. The CLI also accepts
`--database-url`, but use the environment to keep credentials out of shell history.

For a local password account, add `--username NAME` to `init` and supply
`SCREEPS_INITIAL_PASSWORD` in the environment. Do not put production passwords
or tokens in shell history. The administrator can also create/update users with
the CLI. See `npm run cli -- --help` and command-specific `--help` for arguments.

```sh
npm run cli -- status
npm run cli -- pause
npm run cli -- tick 10
npm run cli -- tick-duration 1000
npm run cli -- resume
npm run cli -- snapshot export backup.json
```

Remote commands use the admin token file by default; `--database` selects its
location. `--url` selects another server. `SCREEPS_ADMIN_TOKEN` can supply a token
instead. The admin HTTP API is disabled when no token is configured. It accepts
structured actions under `/admin`, not arbitrary JavaScript evaluation.

The CLI also manages users, code, memory, rooms, NPC bots, strongholds,
maintenance jobs and snapshot imports. Import replaces the world atomically and
disconnects existing sockets. Keep an independent backup before intentional
world replacement. Both backends enforce one server owner per world: SQLite uses
an exclusive connection lock; PostgreSQL uses a session advisory lock. Revision
checks reject writes if another writer bypasses that ownership. PostgreSQL does
not enable multiple simulation processes to share a world.

## Original standalone installations

### World and configuration migration

Stop the original server or take a consistent backup of its LokiJS `db.json`.
Import into a new SQLite database (or a new PostgreSQL world):

```sh
npm run cli -- migrate-original /path/to/db.json --database data/imported.sqlite
npm run cli -- start --database data/imported.sqlite --paused
```

The source file is never modified. Original database upgrades through version 9
run before conversion. The import preserves rooms, terrain, objects and their
processing order, users/profiles, branches, memory/segments, CPU buckets, queued
intents, market data and stored history. Mod collections and noncanonical env
values are retained in the snapshot. Unsupported or malformed records reject
the import rather than silently losing data.

The report identifies upgrades, reset heaps, revoked original bearer tokens,
recomputed caches and retained compatibility data. Original process heaps and
cron timers cannot be imported. Unsupported password-hash formats are rejected;
Steam identities and this server's own password hashes are preserved.

`start --original-db FILE` also imports, but only when the target world is empty.
Once committed, restarts read the SQL world and no longer require the source.
The CLI reads `--config FILE`, or `./.screepsrc` when present. Original `db` means
a LokiJS input, never a SQLite file; its default destination is `db.json.sqlite`.
Paths resolve relative to the configuration file. Explicit flags override
environment variables, which override `.screepsrc`.

### Trusted mods and original JavaScript CLI

`--mods /path/to/mods.json` loads the original `{mods: [...], bots: {...}}` manifest.
CommonJS mods initialize synchronously with world-local configuration and module
state. The `@screeps/common` and `@screeps/driver` bindings expose canonical
collection/env/pubsub/queue storage, constants, driver reads and extension hooks.
There is no separate mod database competing with the live world.

Supported extension paths include HTTP pre/post configuration and `/api` routes,
socket module factories, welcome text, renderer/custom-object metadata, custom
prototypes and intents, processor events, per-tick `playerSandbox`, player
selection, room history, cron overrides, notification delivery and CLI sandbox
extensions. Bot modules from the manifest are reloaded at startup. With workers,
mods load separately in each process and use asynchronous IPC for canonical
storage; do not synchronously wait for host storage from a processing hook.

Enable the original TCP JavaScript administration interface explicitly:

```sh
npm run cli -- start --mods /path/to/mods.json --cli-port 21026
```

It exposes persistent per-connection JavaScript, `help()`, `storage`, `system`,
`map`, `bots` and `strongholds`, including mod-provided sandbox methods.
It defaults to loopback and has **no authentication or encryption**, like the
original. Never expose it to untrusted networks. Mods and CLI scripts have the
operator's privileges; neither is a sandbox for untrusted code. The authenticated
HTTP admin interface remains available.

### Supervised execution

```sh
npm run cli -- start --runners 2 --runner-threads 4 --processors 2 \
  --worker-restart-interval 3600 --log-directory logs
```

Runners retain one isolate per player and restart after crashes. Periodic recycling
drains outstanding work before replacement; zero disables it. Processor crashes
retry the affected room once. `--log-rotate-keep N` retains old worker logs;
`--log-console` also forwards them to the terminal. Shutdown drains work and closes
the processes before releasing the database.

Omitting the counts retains deterministic in-process execution. Parallel processors
read rooms at the start of the stage and apply their results before the global
stage. They use separate random streams: their random draws and within-tick
cross-room observations need not match sequential execution. SQL commits still
have one owner; this is not a distributed multi-writer database.

## Containers

`Dockerfile` builds a production image on `node:24.21.0-bookworm-slim` with this
server directory as its build context. `.dockerignore` admits only production build
inputs, excluding host dependencies, generated files, worlds and credentials.
The build stage installs Git to fetch the commit-pinned game and engine packages
over anonymous HTTPS, plus a C++ toolchain when native prebuilds are unavailable.
It runs `npm ci` with strict `allowScripts` enforcement (including the Git
dependencies' `prepare` builds), compiles the server and prunes development
dependencies. The runtime contains one server tree with game and engine installed
in `node_modules`; it includes `libstdc++6`, but no Git or compiler, and runs
`node --no-node-snapshot dist/cli.js start` as uid 1000 with state in `/data`.
Building needs Docker with BuildKit, Compose v2.17 or later, and network access to
GitHub and the npm registry; no GitHub credentials or sibling checkouts are needed.

```sh
docker compose build
docker compose run --rm server init
docker compose up -d
docker compose logs -f server
```

`init` creates the world at `/data/world.sqlite` and the admin token file
`/data/world.sqlite.admin-token` (owner-only) in the named `data` volume. Add
`--world-size N`, `--seed N` or `--shard NAME` to choose generation settings.
For an initial password account, pass the password through the environment
rather than the command line:

```sh
read -rs SCREEPS_INITIAL_PASSWORD && export SCREEPS_INITIAL_PASSWORD
docker compose run --rm -e SCREEPS_INITIAL_PASSWORD server init --username NAME
```

`start` also creates a missing world, but only `init` writes a token file. If
the server was started first, `init` refuses to replace the world; enable the
admin API with `SCREEPS_ADMIN_TOKEN` instead (below). Admin commands run inside
the container, which reaches the server on its loopback address and reads the
token file from the volume or `SCREEPS_ADMIN_TOKEN` from its environment:

```sh
docker compose exec server node dist/cli.js status
docker compose exec server node dist/cli.js pause
docker compose exec server node dist/cli.js --help
```

The world, token file and journals persist across `docker compose restart`,
`down`/`up` and image rebuilds (`docker compose build --pull && docker compose up -d`).
`docker compose down -v` deletes the volumes and therefore the world. On
SIGTERM the server closes sockets and flushes the world; Compose waits up to 30
seconds before killing it. The image health check polls `/health`, and the
service restarts unless stopped. The root filesystem is read-only, all Linux
capabilities are dropped and privilege escalation is disabled; only `/data` and
a `/tmp` tmpfs are writable.

Compose reads settings from the shell or a `.env` file beside `compose.yaml`
(ignored by Git and excluded from the image; restrict it with `chmod 600 .env`):

| Variable                       | Meaning                                                  | Default       |
| ------------------------------ | -------------------------------------------------------- | ------------- |
| `OPENSCREEPS_PUBLISH_ADDRESS`  | Host address of the published port                       | `127.0.0.1`   |
| `OPENSCREEPS_PUBLISH_PORT`     | Host port                                                | `21025`       |
| `STEAM_KEY`                    | Steam Web API credential                                 | Unset         |
| `SERVER_PASSWORD`              | Shared game-server password                              | Unset         |
| `SCREEPS_ADMIN_TOKEN`          | Admin token (at least 32 characters) instead of the file | Unset         |
| `POSTGRES_USER`, `POSTGRES_DB` | PostgreSQL role and database (override only)             | `openscreeps` |
| `POSTGRES_PASSWORD`            | PostgreSQL password (override only, required)            | None          |

The three server secrets are passed to the container only when set; an empty
`SCREEPS_ADMIN_TOKEN` is rejected at startup. Generate a token with
`openssl rand -hex 32`, then run `docker compose up -d` to recreate the
container. Values stay visible to `docker inspect` on the host. Other server
variables from [Configuration](#configuration) can be added under `environment`
in `compose.yaml`. Exposing the port beyond loopback also exposes `/admin`; use a
TLS reverse proxy that restricts it.

### PostgreSQL

`compose.postgres.yaml` adds a PostgreSQL 18 service with its own
`postgres-data` volume and a readiness health check, and points the server at it
with `SCREEPS_DATABASE_URL`, which takes precedence over the SQLite path.
PostgreSQL is not published to the host. The `data` volume stays mounted for the
admin token file. Choose a URL-safe password, since it is embedded in the
connection URL:

```sh
echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)" >> .env
docker compose -f compose.yaml -f compose.postgres.yaml build
docker compose -f compose.yaml -f compose.postgres.yaml run --rm server init
docker compose -f compose.yaml -f compose.postgres.yaml up -d
```

Pass both files to every command (`exec`, `logs`, `down`), or set
`COMPOSE_FILE=compose.yaml:compose.postgres.yaml` in `.env` (use `;` as the
separator on Windows). To move an existing SQLite world, which stays in the
`data` volume, export it before switching and import it into the new server.
If the token file already exists, skip `init`: `start` creates the PostgreSQL
world and the import replaces it.

```sh
docker compose exec server node dist/cli.js snapshot export /data/world-snapshot.json
docker compose -f compose.yaml -f compose.postgres.yaml up -d
docker compose -f compose.yaml -f compose.postgres.yaml exec server node dist/cli.js snapshot import /data/world-snapshot.json
docker compose -f compose.yaml -f compose.postgres.yaml exec server rm /data/world-snapshot.json
```

Running only `compose.yaml` again returns to the SQLite world.

### Backups

An online snapshot works with both databases (see the snapshot notes under
[Embedding](#embedding)); copy it out of the volume and delete the in-volume copy:

```sh
docker compose exec server node dist/cli.js snapshot export /data/backup.json
docker compose cp server:/data/backup.json ./backup.json
docker compose exec server rm /data/backup.json
```

For a file-level copy of the `data` volume, stop the server so SQLite is
checkpointed, then archive from a POSIX shell (restore with `-xf - < data.tar`
into an empty volume):

```sh
docker compose stop server
docker compose run --rm --no-deps -T --entrypoint tar server -C /data -cf - . > data.tar
docker compose start server
```

With PostgreSQL, also dump the database:

```sh
docker compose -f compose.yaml -f compose.postgres.yaml exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > world.dump
```

Backups contain password hashes, player code and the admin token; store them
accordingly.

## Official client and authentication

Connect the official Screeps client to the server address. The recommended Steam
sign-in mode uses Valve's `AuthenticateUserTicket` Web API for app 464350 and an
operator-provided `STEAM_KEY`. Missing credentials and failed verification reject
login; there is no assumed Steam identity or bypass.

Original native encrypted-ticket authentication is an explicit opt-in:
`--steam-greenworks /path/to/greenworks.js` (or `STEAM_GREENWORKS`). Supply a
compatible Greenworks/Steamworks binary and a running Steam client owning Screeps.
Startup checks the SDK and app id; `/api/version` then advertises
`useNativeAuth: true`. `STEAM_KEY` and native mode cannot be configured together.
The SDK is not bundled with this server.

**Native tickets use the symmetric key published in the original source. Anyone
with that key can forge identities. Use Web API authentication for untrusted
players; native mode preserves the original trust model, not secure public login.**

To exercise the installed SDK, set `OPENSCREEPS_GREENWORKS` and run:

```sh
node --import tsx --test --test-force-exit --test-timeout=30000 \
  --test-name-pattern="native Steam SDK round trip" test/native-steam.test.ts
```

`--test-force-exit` releases the SDK's process-lifetime handles after the test.

Local integration tools can use `POST /api/auth/signin` with
`{"email":"USERNAME_OR_EMAIL","password":"..."}`. Send the returned token in
`X-Token`; save the refreshed `X-Token` response header. Tokens expire after 60
seconds by default, matching the upstream standalone backend. Password changes
and account removal revoke tokens and authenticated socket sessions; the
response to the revoking request carries no refreshed `X-Token`.

The official account page changes passwords with `POST /api/user/password`
`{oldPassword, password}` (signed in). A wrong `oldPassword` answers the HTTP 200
`{"error":"invalid password"}` envelope. An account without a local password
(Steam sign-up) sets its first one with an empty `oldPassword`; local passwords
need a username. The market history page resolves deal counterparties with
`GET /api/user/money-history/details?tick=&roomName=&targetRoomName=`: the
`market.buy`/`market.sell` ledger entries of that deal (`{user, type}` only, never
other players' balances) with public profiles, and no entries for a deal the
caller did not take part in.

The live protocol is SockJS protocol 14 at `/socket`, including websocket,
XHR-streaming and XHR-polling transports, authentication, gzip framing, room
object diffs, map updates, console, memory, code and account-resource channels.
Private channels are restricted to their authenticated owner.

Terrain PNGs are generated from the current world at `/assets/map/ROOM.png` and
`/assets/map/zoom2/ROOM.png`. Optional additional assets come from `ASSET_DIR`;
path traversal and symlink escapes are rejected. Room history is available at
`/room-history?room=ROOM&time=TICK`.

### Summoned invaders

The room view's invader tool sends `POST /api/game/create-invader` with
`{room, x, y, size, type, boosted}`. The client only enables the tool in a room
whose controller you own, with fewer than five invaders and no other player's
creeps. It places invaders only on edge tiles (`x` or `y` is 0 or 49) that are
not walls; clicks on other tiles send no request. The server also accepts rooms
you reserve.

Summoned invaders follow the original engine's invader AI. Melee and Ranged
invaders hunt creeps and only break structures that block their path. If the
room has none of your creeps or power creeps (creeps still spawning do not
count), every spawn is reachable and the controller is claimed, a Melee or
Ranged invader suicides on its next tick and leaves a tombstone. To see one act,
keep a spawned creep in the room. A Healer follows and heals other invaders. It
suicides when there is no damaged invader and no non-Healer invader to follow,
so summon it together with another type. Safe mode blocks invader attacks,
ranged attacks, dismantling and healing in your room. A first spawn starts
20,000 ticks of safe mode, so invaders reach your creeps but do no damage until
it ends. An invader also dies as soon as another player's creep enters the
room. Select the invader to remove it (`POST /api/game/remove-invader`).

### Platform endpoints outside the standalone backend

The official client also calls screeps.com platform routes that the pinned
standalone backend does not serve. Their public or signed-in access matches
screeps.com:

- `GET /api/steam/news` relays Valve's public, keyless
  `ISteamNews/GetNewsForApp/v2` feed for app 464350 with `count=1`, returning
  `{"ok":1,"appnews":{...}}` exactly as Steam reports it. The client polls every
  five minutes and badges its News menu entry when `appnews.newsitems[0].gid`
  changes. One upstream request is shared per five-minute window outside the
  world lock; an unreachable or malformed feed answers HTTP 502
  `{"error":"steam news unavailable"}`, which the client ignores, and is not
  cached. The server needs outbound HTTPS to `api.steampowered.com` for news.
- `GET /api/xsolla/active-promotion` answers `{"ok":1}`, which is screeps.com's
  answer when no sale is running. screeps.com adds `discount` and `dateUntil`
  during an Xsolla item-shop sale, and the client then shows a sale badge and
  banner. This server sells nothing through Xsolla, so no promotion is ever
  active. It does not relay screeps.com's sales, because purchases there do not
  reach this server.
- Decorations are screeps.com inventory items. This server has none, and
  `/api/version` advertises no `inventory` feature, so the client keeps its
  inventory and Decorations panels hidden. The routes the client still calls
  report that nothing exists:
  - `GET /api/game/room-decorations?room=ROOM` (public) answers
    `{"ok":1,"decorations":[]}`, screeps.com's answer for an undecorated room.
    The `shard` parameter is ignored, as on the server's other single-world
    routes.
  - `GET /api/user/decorations/inventory` and `GET /api/user/decorations/themes`
    (signed in; otherwise HTTP 401 `{"error":"unauthorized"}`) answer
    `{"ok":1,"list":[]}`.
- `GET /api/game/room-objects?room=ROOM` answers screeps.com's
  `{"ok":1,"objects":[...],"users":{...}}`: every object document of the room
  (flags are separate documents and not included) and the public `_id`, `username`
  and `badge` of their owners. Like screeps.com it is public; a sent token is
  neither required nor refreshed. The live room socket channel, unlike this
  snapshot, still requires a signed-in session. `shard` is ignored.
- `GET /api/user/name` (signed in) answers `{"ok":1,"username":"..."}`. A
  Steam account that has not chosen a username yet receives the HTTP 200
  `{"error":"username not set"}` envelope.
- `GET /api/game/find-object?_id=ID` (public) answers `{"ok":1,"object":{...}}`
  with the room object document; the room view uses `object.room` to navigate.
  An unknown id answers the HTTP 200 `{"error":"object not found"}` envelope.
- `GET /api/game/random-novice-room` (public) answers
  `{"ok":1,"room":"ROOM","shard":"SHARD"}` with a random normal room whose novice
  area is still active, or `{"ok":1}` when the world has none, which the world
  map ignores.

Other official screeps.com operations — PTR activation, per-shard CPU and ticks,
decoration and store trading, seasons, arenas, survival and scoreboards, replays
and history sharing, scoped tokens, GitHub/e-mail account flows, experimental
PvP/nuke feeds, the server list and shard-addressed room history — belong to
hosted services. The standalone profile excludes them with reasons, so they are
absent from `api/openapi.json` and the generated client, and the server answers 404.

## Embedding

For a world without HTTP or a database, use `GameSession` and `createGameState`
from `@openscreeps/game` directly. World operations formerly exported through
the server's `world` namespace now come directly from `@openscreeps/game`; shared
game types also belong there. See the game package README for explicit ticks,
gameplay actions and credential-free snapshots.

After `npm run build`:

```ts
import { createServer, createUser } from './dist/index.js';

const server = await createServer({
  database: ':memory:',
  worldSize: 3,
  port: 0,
  paused: true,
});
try {
  await server.kernel.mutate(() => {
    createUser(server.context, { username: 'Alice', password: 'local-example-password' });
  });
  const tick = await server.kernel.step();
  console.log(server.address.port, tick.simulation.gameTime);
} finally {
  await server.close();
}
```

`ServerKernel` is available without HTTP through
`await ServerKernel.create(createConfig(options))`; close it with `await kernel.close()`.
Database initialization is asynchronous for both backends. All world operations
must run inside `read` or `mutate`; nested calls obey the transaction rules above.
Mutations, ticks and flushes are serialized. Publications follow successful
mutations; the world reaches the database with the next flush (`flush()` forces
one). Failed operations roll back; failed flushes stop the kernel instead of serving
divergent state. Call `terrainChanged()` inside a mutation after changing terrain
or room accessibility. Never mutate the exposed state outside the lock.

Room objects are processed in the original storage's write order, which the
snapshot records per object. Prefer `@openscreeps/game` operations, which record
their writes. Code that changes an existing room object directly inside a
mutation must call `recordRoomObjectWrite(world, id)` from `@openscreeps/game`
right after each logical write, in write order, or `recordRoomObjectWrites(world, ids)`
with the ids in write order (the last becomes the newest). Inserted and removed
objects need no call; inserts count as the newest writes in insertion order.
Both helpers throw for an id not in `world.roomObjects`. Never edit the ordering
metadata itself. The server's own services only read room objects and change
them through game operations.

Snapshots preserve world state, code, memory, segments, CPU buckets, queued
intents, credentials, scheduler metadata and history. Player JavaScript heaps
are not serialized: restarting or importing performs a global reset. Snapshot
files contain private player data and password hashes; protect them accordingly.
Nested server/runtime collections are checked before a snapshot is accepted.
Snapshot import accepts this server's versioned format; use `migrate-original`
for original LokiJS databases.

## Configuration

| Environment                          | Meaning                                         | Default                                   |
| ------------------------------------ | ----------------------------------------------- | ----------------------------------------- |
| `GAME_HOST`, `GAME_PORT`             | Listen address and port                         | `127.0.0.1`, `21025`                      |
| `SCREEPS_DATABASE`                   | SQLite file and local admin-token path anchor   | `data/world.sqlite`                       |
| `SCREEPS_DATABASE_URL`               | PostgreSQL URL; overrides SQLite storage        | Unset                                     |
| `SCREEPS_WORLD_SIZE`, `SCREEPS_SEED` | New-world generation                            | `21`, `1`                                 |
| `SHARD_NAME`                         | New-world shard name                            | `shard0`                                  |
| `SCREEPS_TICK_DURATION`              | Minimum tick interval, milliseconds             | `1000`                                    |
| `SCREEPS_PAUSED`                     | Pause/resume override                           | `false` for a new world                   |
| `SCREEPS_HISTORY_TICKS`              | Room-history retention                          | `1000`                                    |
| `SCREEPS_COMMIT_TICKS`               | Ticks between database flushes                  | `10`                                      |
| `SCREEPS_ADMIN_TOKEN`                | Admin bearer credential, at least 32 characters | Disabled unless provided or loaded by CLI |
| `STEAM_KEY`                          | Steam Web API credential                        | Unconfigured                              |
| `SERVER_PASSWORD`                    | Optional shared game-server password            | Unconfigured                              |
| `ASSET_DIR`                          | Additional client assets                        | Unconfigured                              |
| `STEAM_GREENWORKS`                   | Explicit native Steam SDK module path           | Disabled                                  |
| `MODFILE`                            | Original trusted mod manifest                   | Unset                                     |
| `DB_PATH`                            | Original LokiJS input for an empty world        | Unset                                     |
| `CLI_HOST`, `CLI_PORT`               | Original trusted JavaScript CLI                 | Loopback; disabled until a port is set    |
| `RUNNERS_CNT`, `RUNNER_THREADS`      | Runner processes and concurrency per runner     | In-process; 4 threads when enabled        |
| `PROCESSORS_CNT`                     | Concurrent room processor processes             | In-process                                |
| `SCREEPS_WORKER_RESTART_INTERVAL`    | Worker recycling interval, seconds              | `3600`; `0` disables                      |
| `SCREEPS_LOG_DIRECTORY`              | Worker log directory                            | Unset; output goes to the terminal        |
| `SCREEPS_LOG_ROTATE_KEEP`            | Rotated files retained per worker               | `5`                                       |

Persisted worlds retain their scheduler state. The CLI applies explicitly
requested pause/tick-duration overrides on start; programmatic hosting restores
the persisted state. `createServer` also accepts the exported `ServerConfig`
settings and a clock callback for controlled integration scenarios.

Maintenance includes room activation, invader raids, power banks, deposits,
strongholds and expansion, NPC market orders, market history, transaction
retention and power-creep deletion. A separate one-second wall-clock scheduler
runs due jobs even while ticks are paused. Jobs and ticks share the mutation lock.
Notification delivery uses `deliverNotifications` or original
`sendUserNotifications` mod listeners, outside that lock. Batches are queued in
the world, acknowledged after success and retried after failure. Delivery is
at-least-once: sinks should deduplicate by batch id. Without a sink, batches remain
in the persisted operator-visible outbox.

## Compatibility and security boundaries

The source reference is the pinned public standalone backend, launcher and
storage implementation recorded in `reference-versions.json`. This is not a
claim of equivalence to private MMO infrastructure or all deployed server mods.
The HTTP API, live protocol and world-maintenance behavior derive from those
sources. Legacy authorization flaws are not preserved: inherited object keys
cannot act as users, cross-user subscriptions are rejected, and credential
revocation reaches live sockets.

Behavioral coverage includes account/code/memory operations, gameplay APIs,
world generation and maintenance, real admin HTTP requests, SockJS transports,
client-style Lodash diff application, image pixels, durable restart and rejected
mutations/imports. A real-server smoke exercised login, code upload, spawn
placement, bot harvesting, console, live room updates, history, images and
restart persistence. Original-mod smoke checks additionally exercised custom
HTTP/socket channels, TCP CLI methods, renderer metadata, custom intents over
multiple ticks, worker storage IPC and runner replacement. The shipped 121-room
original world was imported, ticked and reopened without its input file changing.
Live SDK verification and native HTTP login were exercised with a fresh Steam
ticket; paused wall-clock notification delivery was also exercised. These checks
do not establish an interactive official-client session or live Web API validation.

Use a TLS reverse proxy for remote access, restrict the admin endpoint, and
contain the Node process when running hostile players. V8 isolate limits are
not an operating-system process boundary. CPU timing depends on hardware;
wall-clock policies and random/player timing inputs affect replay equivalence.
TypeORM stores a complete versioned snapshot per flush, plus the room history
frames since the last one: this favors atomicity and an inspectable single-owner
server, not a claim of large-world throughput.
