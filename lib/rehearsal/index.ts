import { getAddress, isAddress, type Address } from "viem";
import { RehearsalBadge } from "./Badge";
import { REHEARSAL_CONNECTOR_TYPE, rehearsalConnector } from "./connector";
import { rehearsalRpcFrom } from "./flag";

/**
 * The dress rehearsal, as `lib/jaw/config.ts` loads it (development only): the fork's RPC for every read, the fork
 * signer's connector in place of JAW's, and the badge. Configured by `.env.rehearsal.local`, which
 * scripts/rehearsal/setup.ts writes.
 */
export function loadRehearsal() {
  const rpc = rehearsalRpcFrom({ NODE_ENV: process.env.NODE_ENV, NEXT_PUBLIC_REHEARSAL_RPC: process.env.NEXT_PUBLIC_REHEARSAL_RPC });
  if (!rpc) return null;
  const account = address("NEXT_PUBLIC_REHEARSAL_ACCOUNT", process.env.NEXT_PUBLIC_REHEARSAL_ACCOUNT);
  const signer = address("NEXT_PUBLIC_REHEARSAL_SIGNER", process.env.NEXT_PUBLIC_REHEARSAL_SIGNER);
  const fromBlock = process.env.NEXT_PUBLIC_REHEARSAL_FROM_BLOCK;
  if (!fromBlock || !/^\d+$/.test(fromBlock)) throw new Error("NEXT_PUBLIC_REHEARSAL_FROM_BLOCK is missing: run npm run rehearsal:setup");
  return {
    rpc,
    connector: rehearsalConnector({ rpc, account, signer, fromBlock: BigInt(fromBlock) }),
    connectorType: REHEARSAL_CONNECTOR_TYPE,
    Badge: RehearsalBadge,
  };
}

export type Rehearsal = NonNullable<ReturnType<typeof loadRehearsal>>;

function address(name: string, value: string | undefined): Address {
  if (!value || !isAddress(value)) throw new Error(`${name} is missing: run npm run rehearsal:setup`);
  return getAddress(value);
}
