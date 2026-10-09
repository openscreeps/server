# OpenScreeps server

A standalone Screeps-compatible server in strict TypeScript, built with NestJS and
its default Express adapter. Uses [OpenScreeps engine](https://github.com/openscreeps/engine)
for simulation and isolated player JavaScript. The official game client remains unchanged;
this repository does not implement or distribute a replacement client.

## Development

```sh
mise install
mise run install
npm run check
```

Node 24.21.0 is pinned in `mise.toml`. The engine dependency is pinned to a Git
revision and built during installation. `isolated-vm` needs a supported prebuilt
binary or a native build toolchain. Checks include strict TypeScript, type-aware
ESLint, Prettier, behavioral tests and declaration compilation.

## Run a world

```sh
npm run cli -- init --database data/world.sqlite --world-size 21 --seed 1
npm start -- --database data/world.sqlite
```

`init` creates a world and an admin token file beside the database, without
replacing existing files. The default world has 21 rooms per side. The server
listens on `127.0.0.1:21025`; use `--host 0.0.0.0` to expose it deliberately.
World data lives in SQLite, not in an external MongoDB or Redis service.

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
world replacement. SQLite enforces a single writer: two server processes cannot
own the same database.

## Official client and authentication

Connect the official Screeps client to the server address. Steam sign-in uses
Valve's `AuthenticateUserTicket` Web API for app 464350 and requires a valid
operator-provided `STEAM_KEY`. `/api/version` advertises Web API authentication,
not the legacy native encrypted-ticket scheme. Missing credentials and failed
verification reject login; there is no assumed Steam identity or bypass.

Local integration tools can use `POST /api/auth/signin` with
`{"email":"USERNAME_OR_EMAIL","password":"..."}`. Send the returned token in
`X-Token`; save the refreshed `X-Token` response header. Tokens expire after 60
seconds by default, matching the upstream standalone backend. Password changes
and account removal revoke tokens and authenticated socket sessions.

The live protocol is SockJS protocol 14 at `/socket`, including websocket,
XHR-streaming and XHR-polling transports, authentication, gzip framing, room
object diffs, map updates, console, memory, code and account-resource channels.
Private channels are restricted to their authenticated owner.

Terrain PNGs are generated from the current world at `/assets/map/ROOM.png` and
`/assets/map/zoom2/ROOM.png`. Optional additional assets come from `ASSET_DIR`;
path traversal and symlink escapes are rejected. Room history is available at
`/room-history?room=ROOM&time=TICK`.

## Embedding

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

`ServerKernel` is available without HTTP. All world operations must run inside
`read` or `mutate`; do not nest these calls. Mutations, ticks and commits are
serialized. Publications are delivered only after a durable commit. Failed
operations roll back; failed durable commits stop the kernel instead of serving
divergent state. Call `terrainChanged()` inside a mutation after changing terrain
or room accessibility. Never mutate the exposed state outside the lock.

Snapshots preserve world state, code, memory, segments, CPU buckets, queued
intents, credentials, scheduler metadata and history. Player JavaScript heaps
are not serialized: restarting or importing performs a global reset. Snapshot
files contain private player data and password hashes; protect them accordingly.
Nested server/runtime collections are checked before a snapshot is accepted;
imports are an administrator interface for this server's versioned format, not
an arbitrary upstream database migration service.

## Configuration

| Environment                          | Meaning                                         | Default                                   |
| ------------------------------------ | ----------------------------------------------- | ----------------------------------------- |
| `GAME_HOST`, `GAME_PORT`             | Listen address and port                         | `127.0.0.1`, `21025`                      |
| `SCREEPS_DATABASE`                   | SQLite file                                     | `data/world.sqlite`                       |
| `SCREEPS_WORLD_SIZE`, `SCREEPS_SEED` | New-world generation                            | `21`, `1`                                 |
| `SHARD_NAME`                         | New-world shard name                            | `shard0`                                  |
| `SCREEPS_TICK_DURATION`              | Minimum tick interval, milliseconds             | `1000`                                    |
| `SCREEPS_PAUSED`                     | Pause/resume override                           | `false` for a new world                   |
| `SCREEPS_HISTORY_TICKS`              | Room-history retention                          | `1000`                                    |
| `SCREEPS_ADMIN_TOKEN`                | Admin bearer credential, at least 32 characters | Disabled unless provided or loaded by CLI |
| `STEAM_KEY`                          | Steam Web API credential                        | Unconfigured                              |
| `SERVER_PASSWORD`                    | Optional shared game-server password            | Unconfigured                              |
| `ASSET_DIR`                          | Additional client assets                        | Unconfigured                              |

Persisted worlds retain their scheduler state. The CLI applies explicitly
requested pause/tick-duration overrides on start; programmatic hosting restores
the persisted state. `createServer` also accepts the exported `ServerConfig`
settings and a clock callback for controlled integration scenarios.

Maintenance includes room activation, invader raids, power banks, deposits,
strongholds and expansion, NPC market orders, market history, transaction
retention and power-creep deletion. Notification delivery is an embedding
callback (`deliverNotifications`); without a configured sink, notifications
remain in a persisted operator-visible outbox rather than being discarded.

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
restart persistence. Live Valve ticket verification and an interactive Steam
client session require operator credentials and are not established by these
checks.

Use a TLS reverse proxy for remote access, restrict the admin endpoint, and
contain the Node process when running hostile players. V8 isolate limits are
not an operating-system process boundary. CPU timing depends on hardware;
wall-clock policies and random/player timing inputs affect replay equivalence.
SQLite stores a complete versioned snapshot per commit: this favors atomicity
and an inspectable single-process server, not a claim of large-world throughput.
