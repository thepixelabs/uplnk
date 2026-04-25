# ─── Stage 1: builder ─────────────────────────────────────────────────────────
# Compiles TypeScript with tsup. SQLite ships with Bun (bun:sqlite) — no
# native addon to compile, so we don't need python3/make/g++ here.
FROM oven/bun:1-alpine AS builder

# pnpm is still used as the workspace install tool — Bun runs it via `bun x`.
# Pin the version that matches the packageManager field in package.json.
RUN bun install -g pnpm@9.15.0

WORKDIR /build

# Copy manifests first so pnpm install is cache-efficient
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/app/package.json   ./packages/app/
COPY packages/db/package.json    ./packages/db/
COPY packages/shared/package.json ./packages/shared/

# Install all workspace deps
RUN pnpm install --frozen-lockfile

# Copy full source
COPY packages/ ./packages/
COPY scripts/  ./scripts/
COPY tsconfig.base.json tsconfig.json ./

# Build @uplnk/app (tsup bundles @uplnk/db + @uplnk/shared inline).
# bun:sqlite is a Bun built-in — not bundled, resolved at runtime.
RUN pnpm --filter uplnk build


# ─── Stage 2: runner ──────────────────────────────────────────────────────────
FROM oven/bun:1-alpine AS runner

# Create a non-root user. DB and config land in /home/uplnk/.uplnk/
# Mount the host directory with:  -v ~/.uplnk:/home/uplnk/.uplnk
RUN addgroup -S uplnk && adduser -S uplnk -G uplnk

WORKDIR /app

# Copy the compiled app bundle. Migrations are embedded at build time via
# packages/db/src/migrations.generated.ts (no filesystem lookup at runtime).
COPY --from=builder /build/packages/app/dist/ ./packages/app/dist/

# Own the app tree (read-only at runtime; uplnk dir is a mounted volume)
RUN chown -R uplnk:uplnk /app

USER uplnk

# ─── Runtime configuration ────────────────────────────────────────────────────
# Ollama URL: override for non-Docker-Desktop environments (e.g. Linux hosts
# where host.docker.internal is not automatically populated).
# On macOS/Windows Docker Desktop the default works without any override.
ENV OLLAMA_BASE_URL=http://host.docker.internal:11434/v1

# DB and config live on the mounted volume — not in the image.
VOLUME ["/home/uplnk/.uplnk"]

# Must run with -it (docker run -it) — Ink requires an interactive TTY.
ENTRYPOINT ["bun", "/app/packages/app/dist/uplnk.js"]
