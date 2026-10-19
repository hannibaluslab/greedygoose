import type { Call } from "@/lib/aave/tx";
import type { Cash } from "@/lib/cash";

export type Address = `0x${string}`;
/** A hook's batch builder, run from fresh reads while the screen is idle (useTx). */
export type Batch<I> = (p: I) => Promise<Call[]>;
/** The cash read again while a batch is prepared (useSigningCash). */
export type CashToSign = (user: Address, amountRaw: bigint) => Promise<Cash>;
