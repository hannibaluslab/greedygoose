import { toHex, type Address, type Hex } from "viem";
import { APP_START_BLOCK, RECEIVED_TOKENS } from "./arrivals";

/**
 * Alchemy's Transfers API (alchemy_getAssetTransfers) on Base: every USDC and stock transfer to an account since the
 * app's first block, in one request a thousand at a time. Base's public RPC refuses getLogs, and Etherscan's free plan
 * doesn't cover Base, so money someone sent comes from here. The key is Alchemy's own, allowed only from the app's
 * domains in Alchemy's dashboard. Without it, nothing that needs it is shown.
 */
const KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;
export const ALCHEMY_ON = !!KEY;

type Transfer = { hash: Hex; blockNum: Hex; metadata?: { blockTimestamp?: string } };

/** The transactions that moved USDC or a stock to `account`, once each, oldest first: hash, block and time. */
export async function transfersIn(account: Address): Promise<{ hash: Hex; block: bigint; t: number }[]> {
  if (!KEY) return [];
  const url = `https://base-mainnet.g.alchemy.com/v2/${KEY}`;
  const seen = new Map<Hex, { hash: Hex; block: bigint; t: number }>();
  let pageKey: string | undefined;
  do {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "alchemy_getAssetTransfers",
        params: [
          {
            fromBlock: toHex(APP_START_BLOCK),
            toBlock: "latest",
            toAddress: account,
            contractAddresses: RECEIVED_TOKENS,
            category: ["erc20"],
            withMetadata: true,
            excludeZeroValue: true,
            order: "asc",
            maxCount: "0x3e8",
            ...(pageKey ? { pageKey } : {}),
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Alchemy ${res.status}`);
    const body = (await res.json()) as {
      result?: { transfers: Transfer[]; pageKey?: string };
      error?: { message: string };
    };
    if (!body.result) throw new Error(body.error?.message ?? "Alchemy: no result");
    for (const tr of body.result.transfers) {
      if (seen.has(tr.hash)) continue;
      const t = tr.metadata?.blockTimestamp ? Math.floor(Date.parse(tr.metadata.blockTimestamp) / 1000) : 0;
      seen.set(tr.hash, { hash: tr.hash, block: BigInt(tr.blockNum), t });
    }
    pageKey = body.result.pageKey;
  } while (pageKey);
  return [...seen.values()];
}
