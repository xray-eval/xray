# syntax=docker/dockerfile:1.7

# --- Stage 1: production dependencies only -----------------------------------
#
# Installs ONLY `dependencies` from package.json (not devDependencies). This is
# what ends up in the runtime image — no biome, no lefthook, no tsc, no
# drizzle-kit. Bun bundles the React entry from index.html at server boot.
# The 7-day pnpm cooldown and `ignore-scripts=true` defaults still apply
# (see .claude/rules/supply-chain.md §1).
#
# Base images are pinned by manifest digest, not just tag — same rule as
# GitHub Action pinning. Bump the tag in the comment and the digest in the
# same commit.
#
# node:24.15.0-bookworm-slim (matches .nvmrc)
FROM node@sha256:24dc26ef1e3c3690f27ebc4136c9c186c3133b25563ae4d7f0692e4d1fe5db0e AS prod-deps

ENV CI=1 \
    PNPM_HOME=/root/.local/share/pnpm \
    PATH=/root/.local/share/pnpm:$PATH

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN corepack enable && corepack prepare --activate \
 && pnpm install --prod --frozen-lockfile --ignore-scripts

# --- Stage 2: runtime --------------------------------------------------------
#
# oven/bun:1.3.14-debian (matches .tool-versions; pinned by manifest digest)
FROM oven/bun@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f AS runtime

# Non-root user. The image carries code + production deps; secrets are
# runtime-only (.claude/rules/public-repo.md §2) — never ARG/ENV them here.
RUN useradd --system --create-home --uid 10001 --gid users xray

# Pre-create the default XRAY_DATA_DIR and hand ownership to the non-root user.
# Without this, `openStoreFromEnv` calls `mkdirSync('/data')` at boot and gets
# EACCES because `/` is owned by root. An operator mounting a volume here
# overrides this, but the unmounted case still has to work for `docker run`
# without flags (and for `pnpm docker:smoke`).
RUN mkdir -p /data && chown xray:users /data

USER xray
WORKDIR /home/xray/app

# Production node_modules, from stage 1. Avoids re-fetching at container boot
# (network-at-runtime supply-chain risk) and guarantees the image matches
# pnpm-lock.yaml exactly.
COPY --chown=xray:users --from=prod-deps /app/node_modules ./node_modules

# Ordered most-stable to least-stable so source edits don't bust the layer
# cache on package.json / tsconfig.json. Bun runs TS directly, so we ship .ts.
# index.html is bundled at server boot — see src/server/main.ts.
COPY --chown=xray:users package.json tsconfig.json index.html ./
COPY --chown=xray:users src ./src

ENV HOST=0.0.0.0 \
    PORT=8080 \
    NODE_ENV=production
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun --eval "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "src/server/main.ts"]
