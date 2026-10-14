#!/usr/bin/env bash
# The rehearsal's chain: a local anvil fork of Base mainnet at its latest block, chain id 8453, one block a second,
# listening on 127.0.0.1 only. It reads Base through REHEARSAL_FORK_URL and never writes to it: every transaction
# lands on this local node. Stop it with Ctrl-C; a new start is a fresh fork (run setup again).
#
# --network optimism: Base is an OP Stack chain. Left to itself, anvil (1.8+) picks its "base" family for chain 8453,
# which runs the B20 stocks natively at their addresses and ignores the stand-in code setup.ts puts there; that native
# B20 has no uiMultiplier(), which the app reads for every stock. Under "optimism" a B20 address is its plain 0xef
# code, as in the fork suites (contracts/test/ForkBase.sol), and the stand-ins take over.
#
# --no-rate-limit: anvil fetches Base's state one slot at a time, the first time anything touches it, and by default
# holds itself to 330 compute units a second. A first quote on a stock pool then took 5.5 minutes, against 9 seconds
# without the limit (2026-10-14). Base's public RPC still answers or asks anvil to retry.
#
#   npm run rehearsal:fork                      # port 18545, forked from https://mainnet.base.org
#   REHEARSAL_PORT=18546 npm run rehearsal:fork
#   REHEARSAL_FORK_URL=<your Base RPC> npm run rehearsal:fork   # a keyed RPC is faster; it is only read
set -euo pipefail

PORT="${REHEARSAL_PORT:-18545}"
FORK_URL="${REHEARSAL_FORK_URL:-https://mainnet.base.org}"
export PATH="$PATH:$HOME/.foundry/bin"

command -v anvil >/dev/null || { echo "anvil not found: install Foundry (https://getfoundry.sh)" >&2; exit 1; }
chain=$(cast chain-id --rpc-url "$FORK_URL")
[ "$chain" = "8453" ] || { echo "$FORK_URL is chain $chain, not Base (8453)" >&2; exit 1; }

echo "Forking Base ($FORK_URL) at its latest block on http://127.0.0.1:$PORT"
exec anvil \
  --fork-url "$FORK_URL" \
  --chain-id 8453 \
  --network optimism \
  --host 127.0.0.1 \
  --port "$PORT" \
  --block-time 1 \
  --no-rate-limit \
  ${REHEARSAL_FORK_BLOCK:+--fork-block-number "$REHEARSAL_FORK_BLOCK"}
