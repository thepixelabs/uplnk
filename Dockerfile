# ─── Stage 1: builder ─────────────────────────────────────────────────────────
# Compiles TypeScript with tsup and builds the better-sqlite3 native addon
# against the exact Node/musl/Alpine ABI used by the runner stage.
FROM node:20-alpine AS builder

# Native build deps for better-sqlite3
RUN apk add --no-cache python3 make g++

# Install pnpm via corepack (matches the packageManager field in package.json)
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /build

# Copy manifests first so pnpm install is cache-efficient
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/app/package.json   ./packages/app/
COPY packages/db/package.json    ./packages/db/
COPY packages/shared/package.json ./packages/shared/

# Install all workspace deps (includes native compilation of better-sqlite3)
RUN pnpm install --frozen-lockfile

# Copy full source
COPY packages/ ./packages/

# Build pylon-app (tsup bundles pylon-db + pylon-shared inline;
# better-sqlite3 stays external as a native .node module)
RUN pnpm --filter pylon-dev build

# Copy migrations into the dist tree so import.meta.url-relative lookup works.
# When tsup bundles migrate.ts into dist/bin/pylon.js, import.meta.url points
# to dist/bin/pylon.js, so join(dirname, '../migrations') = dist/migrations/.
RUN cp -r /build/packages/db/migrations /build/packages/app/dist/migrations


# ─── Stage 2: runner ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

# Create a non-root user. DB and config land in /home/pylon/.pylon/
# Mount the host directory with:  -v ~/.pylon:/home/pylon/.pylon
RUN addgroup -S pylon && adduser -S pylon -G pylon

WORKDIR /app

# Copy the compiled app bundle
COPY --from=builder /build/packages/app/dist/ ./packages/app/dist/

# Copy better-sqlite3 native module (pre-built in builder against this ABI).
# pnpm hoists it to the root node_modules.
COPY --from=builder /build/node_modules/better-sqlite3/ ./node_modules/better-sqlite3/
# better-sqlite3 depends on bindings + file-uri-to-path at runtime
COPY --from=builder /build/node_modules/bindings/        ./node_modules/bindings/
COPY --from=builder /build/node_modules/file-uri-to-path/ ./node_modules/file-uri-to-path/

# Migrations were staged into dist/migrations/ by the cp step above.
# The dist/ COPY on line 46 already includes them — this line is a no-op
# safety net kept for clarity.
# (dist/migrations/ is part of the dist/ tree copied two lines above)

# Own the app tree (read-only at runtime; pylon dir is a mounted volume)
RUN chown -R pylon:pylon /app

USER pylon

# ─── Runtime configuration ────────────────────────────────────────────────────
# Ollama URL: override for non-Docker-Desktop environments (e.g. Linux hosts
# where host.docker.internal is not automatically populated).
# On macOS/Windows Docker Desktop the default works without any override.
ENV OLLAMA_BASE_URL=http://host.docker.internal:11434/v1

# DB and config live on the mounted volume — not in the image.
VOLUME ["/home/pylon/.pylon"]

# Must run with -it (docker run -it) — Ink requires an interactive TTY.
ENTRYPOINT ["node", "/app/packages/app/dist/bin/pylon.js"]
