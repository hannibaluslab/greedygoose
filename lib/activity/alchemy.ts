import { hexToBigInt, isAddressEqual, toHex, type Address, type Hex } from "viem";
import { USDC } from "@/lib/tokens/registry";
import { APP_START_BLOCK, RECEIVED_TOKENS } from "./arrivals";

/**
 * Alchemy's Transfers API (alchemy_getAssetTransfers) on Base: every USDC and stock transfer to an account since the
 * app's first block, in one request a thousand at a time. Base's public RPC refuses getLogs, and Etherscan's free plan
 * doesn't cover Base, so money someone sent comes from here. The key is Alchemy's own, allowed only from the app's
 * domains in Alchemy's dashboard. Without it, nothing that needs it is shown.
 */
const KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;
export const ALCHEMY_ON = !!KEY;

/** One record of alchemy_getAssetTransfers, as much of it as is read. */
export type AlchemyTransfer = {
  hash: Hex;
  blockNum: Hex;
  rawContract?: { value?: Hex | null; address?: string | null };
  metadata?: { blockTimestamp?: string };
};

/** A transaction that moved USDC or a stock to the account: its block and time, the USDC it brought, and any stock. */
export type TransferIn = { hash: Hex; block: bigint; t: number; usdcRaw: bigint; stock: boolean };

/** Alchemy's records folded into one TransferIn per transaction, in the order they came. */
export function foldTransfers(seen: Map<Hex, TransferIn>, transfers: readonly AlchemyTransfer[]) {
  for (const tr of transfers) {
    const raw = tr.rawContract?.value ? hexToBigInt(tr.rawContract.value) : 0n;
    const token = tr.rawContract?.address;
    const usdc = !!token && isAddressEqual(token as Address, USDC.address);
    const t = tr.metadata?.blockTimestamp ? Math.floor(Date.parse(tr.metadata.blockTimestamp) / 1000) : 0;
    const tx = seen.get(tr.hash) ?? { hash: tr.hash, block: BigInt(tr.blockNum), t, usdcRaw: 0n, stock: false };
    if (usdc) tx.usdcRaw += raw;
    else if (raw > 0n) tx.stock = true;
    seen.set(tr.hash, tx);
  }
  return seen;
}

/** The transactions that moved USDC or a stock to `account`, once each, oldest first. */
export async function transfersIn(account: Address): Promise<TransferIn[]> {
  if (!KEY) return [];
  const url = `https://base-mainnet.g.alchemy.com/v2/${KEY}`;
  const seen = new Map<Hex, TransferIn>();
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
      result?: { transfers: AlchemyTransfer[]; pageKey?: string };
      error?: { message: string };
    };
    if (!body.result) throw new Error(body.error?.message ?? "Alchemy: no result");
    foldTransfers(seen, body.result.transfers);
    pageKey = body.result.pageKey;
  } while (pageKey);
  return [...seen.values()];
}
