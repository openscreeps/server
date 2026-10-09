# syntax=docker/dockerfile:1

# Debian bookworm (glibc) keeps the native modules compatible with the official Node binary and
# with the prebuilt isolated-vm/better-sqlite3 binaries; musl (Alpine) builds are not used.
ARG NODE_IMAGE=node:24.21.0-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app

# git + CA certificates fetch the pinned game dependency and its engine; their prepare scripts
# compile TypeScript sources. python3, make and g++ let node-gyp compile isolated-vm and
# better-sqlite3 when no prebuilt binary matches. None of these reach the runtime image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git g++ make python3 \
  && rm -rf /var/lib/apt/lists/*

# The lockfile records Git dependencies as git+ssh://git@github.com/...; fetch public repositories
# anonymously over HTTPS, since the build has no SSH credentials.
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

# Fail the install, instead of only warning, when a dependency's install or prepare script is not
# approved by `allowScripts` in package.json. The variable also reaches nested installs npm runs
# to prepare Git dependencies, which are checked against each package's own policy.
ENV npm_config_strict_allow_scripts=true

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# dist/ is never taken from the build context: compile it from source, then drop dev dependencies
# while keeping the native modules that were built for this platform.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime

# The C++ runtime used by Node and the native modules; no compiler toolchain is installed.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libstdc++6 \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
  GAME_HOST=0.0.0.0 \
  SCREEPS_DATABASE=/data/world.sqlite

WORKDIR /app
# Application files stay owned by root and are read-only for the unprivileged runtime user.
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY LICENSE THIRD_PARTY_NOTICES.md reference-versions.json ./

# World database, SQLite journals and the admin token file. A new named volume inherits this
# ownership, so the `node` user (uid 1000) can write it.
RUN install -d -o node -g node -m 0700 /data
VOLUME ["/data"]

USER node
EXPOSE 21025

# Node runs as PID 1 (exec form, no npm or shell wrapper) and receives SIGTERM directly; the CLI
# then closes sockets and commits the world before exiting. A second signal forces an exit.
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.GAME_PORT || '21025') + '/health', { signal: AbortSignal.timeout(4000) }).then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]

# isolated-vm requires --no-node-snapshot on Node 20 and later.
ENTRYPOINT ["node", "--no-node-snapshot", "dist/cli.js"]
CMD ["start"]
