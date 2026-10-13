import { base } from "viem/chains";

export const CHAIN = base;
export const CHAIN_ID = base.id; // 8453
export const EXPLORER_URL = "https://basescan.org";

export const txUrl = (hash: `0x${string}`) => `${EXPLORER_URL}/tx/${hash}`;
export const addressUrl = (address: `0x${string}`) => `${EXPLORER_URL}/address/${address}`;
