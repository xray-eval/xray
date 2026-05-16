#!/usr/bin/env bash
# Build the production image, run it, wait for HEALTHCHECK, dump logs on failure.
# Same check that CI runs before publishing — if this passes locally, it passes in CI.
# See .claude/rules/supply-chain.md (local-first principle in CLAUDE.md).

set -euo pipefail

IMAGE="${IMAGE:-xray:smoke}"
CONTAINER="${CONTAINER:-xray-smoke}"
PORT="${PORT:-8080}"
TIMEOUT="${TIMEOUT:-30}"

# Initialised before the loop so an early failure (TIMEOUT=0, immediate crash)
# doesn't trip `set -u` when we reference $status in the failure message.
status="not inspected"

cleanup() {
  # NOTE: `docker run` below intentionally does NOT use --rm — otherwise a
  # container that exits on its own (broken CMD) disappears before we can
  # capture logs, and this trap can't help.
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "→ building $IMAGE"
docker build -t "$IMAGE" .

echo "→ running $CONTAINER on :$PORT"
docker run -d --name "$CONTAINER" -p "$PORT:8080" "$IMAGE" >/dev/null

echo "→ waiting for container health=healthy (timeout ${TIMEOUT}s)"
for i in $(seq 1 "$TIMEOUT"); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "missing")
  case "$status" in
    healthy)
      echo "✓ healthy after ${i}s"
      exit 0
      ;;
    unhealthy)
      echo "✗ container reported unhealthy after ${i}s — dumping logs:"
      docker logs "$CONTAINER" || true
      exit 1
      ;;
    missing)
      echo "✗ container disappeared after ${i}s (likely crashed) — dumping logs:"
      docker logs "$CONTAINER" || true
      exit 1
      ;;
  esac
  sleep 1
done

echo "✗ container did not reach healthy within ${TIMEOUT}s (last status: $status) — dumping logs:"
docker logs "$CONTAINER" || true
exit 1
