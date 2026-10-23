#!/usr/bin/env bash
# Production release. Vercel isn't connected to GitHub, so a push never deploys: production changes only through this
# script, with the owner's OK.
#
#   scripts/release.sh <commit on origin/main>
#
# Needs the Vercel CLI signed in to the team that owns the project, `vercel link` run once in the repo root (it writes
# .vercel/, gitignored), and .env.local holding NEXT_PUBLIC_ALCHEMY_KEY and NEXT_PUBLIC_BASE_RPC_URL (read here by
# command substitution, never printed). NEXT_PUBLIC_JAW_API_KEY lives in the Vercel project's production env.
set -euo pipefail

# Production's public build values (contracts/docs/DEPLOYMENTS.md, "Live now"). A deploy without them silently turns the
# agents, the Leaderboard and the Wall off. GooseGuard (the spender of every agent permission) and GoosePlanner (its
# views), deployed 2026-10-23 at block 52997787 (DEPLOYMENTS.md, "GooseGuard + GoosePlanner"). This app no longer talks
# to GooseExecutor (0x686c).
GUARD=0x9f0deB42282A75eB2beCa6F6Ca200429F9851C74
GUARD_BLOCK=52997787
PLANNER=0xB971e69aad366A8AfC026a5d7Db1dD671B602D55
BOARD=0x0E10c55D3f20D4Ea1DEf5aC6c60480b34c07FcA1
WALL_FROM_BLOCK=52912478 # the block the Wall went live at: a new one would restart its count
SITE=https://app.greedygoo.com

ROOT=$(git rev-parse --show-toplevel)
SHA=$(git -C "$ROOT" rev-parse --verify "${1:?usage: scripts/release.sh <commit on origin/main>}^{commit}")
ENVF="$ROOT/.env.local"
val() { grep "^$1=" "$ENVF" | head -1 | cut -d= -f2-; }
for v in GUARD GUARD_BLOCK PLANNER; do
  [ -n "${!v}" ] || { echo "$v is empty in scripts/release.sh: GooseGuard and GoosePlanner aren't deployed yet." >&2; exit 1; }
done
[ -f "$ROOT/.vercel/project.json" ] || { echo "Run 'vercel link' in the repo root first." >&2; exit 1; }
for k in NEXT_PUBLIC_ALCHEMY_KEY NEXT_PUBLIC_BASE_RPC_URL; do
  [ -n "$(val "$k")" ] || { echo "$k is missing from .env.local." >&2; exit 1; }
done

# Production only runs what GitHub has.
git -C "$ROOT" fetch -q origin main
git -C "$ROOT" merge-base --is-ancestor "$SHA" origin/main || { echo "$SHA is not on origin/main." >&2; exit 1; }

# A clean export of the commit (no local files, no .env.local), linked to the same Vercel project.
SRC=$(mktemp -d)
trap 'rm -rf "$SRC"' EXIT
git -C "$ROOT" archive "$SHA" | tar -x -C "$SRC"
cp -R "$ROOT/.vercel" "$SRC/.vercel"

# --force skips Vercel's build cache: a cached build once shipped the new JS with the old CSS.
(cd "$SRC" && vercel deploy --prod --yes --force \
  --build-env NEXT_PUBLIC_ALCHEMY_KEY="$(val NEXT_PUBLIC_ALCHEMY_KEY)" \
  --build-env NEXT_PUBLIC_BASE_RPC_URL="$(val NEXT_PUBLIC_BASE_RPC_URL)" \
  --build-env NEXT_PUBLIC_GOOSE_GUARD="$GUARD" \
  --build-env NEXT_PUBLIC_GOOSE_GUARD_BLOCK="$GUARD_BLOCK" \
  --build-env NEXT_PUBLIC_GOOSE_PLANNER="$PLANNER" \
  --build-env NEXT_PUBLIC_AGENTS_LIVE=1 \
  --build-env NEXT_PUBLIC_GOOSE_BOARD="$BOARD" \
  --build-env NEXT_PUBLIC_WALL_FROM_BLOCK="$WALL_FROM_BLOCK")

# Checks: every page answers, and the live scripts carry production's values.
fail=0
for p in / /home /portfolio /agents /activity /send /settings /leaderboard /guide; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$SITE$p")
  echo "$code $p"
  [ "$code" = 200 ] || fail=1
done
JS=$(for p in /home /agents /leaderboard; do curl -s "$SITE$p" | grep -o '/_next/static/[^"]*\.js'; done | sort -u)
ALL=$(for f in $JS; do curl -s "$SITE$f"; done)
for v in "$GUARD" "$GUARD_BLOCK" "$PLANNER" "$BOARD" "$WALL_FROM_BLOCK" alchemy.com; do
  if grep -q -i -F "$v" <<<"$ALL"; then echo "live: $v"; else echo "MISSING from the live scripts: $v" >&2; fail=1; fi
done
[ "$fail" = 0 ] && echo "Released $SHA to $SITE." || { echo "Released, but a check failed: look before telling anyone." >&2; exit 1; }
