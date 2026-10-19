import type { JawPermission } from "@/lib/agents/permissions";
import { buildRegisterCalls, REGISTER_FALLBACK } from "@/lib/agents/register";
import { buildSetKeepMixCalls, buildSetMixCalls } from "@/lib/agents/settings";
import { txKey, type TxPlan } from "../prepared";

/** The mix's `setMix` batch, as useTx signs it: keyed by the account and the weights. */
export const setMixPlan = (account: `0x${string}`, weights: readonly number[]): TxPlan => ({
  key: txKey("setMix", account, weights),
  user: account,
  calls: () => Promise.resolve(buildSetMixCalls(account, weights)),
});

/** "Sells first" (`setKeepMix`), as useTx signs it: keyed by the account and the choice. */
export const keepMixPlan = (account: `0x${string}`, on: boolean): TxPlan => ({
  key: txKey("keepMix", account, on),
  user: account,
  calls: () => Promise.resolve(buildSetKeepMixCalls(account, on)),
});

/** The registrations of the user's new grants (`registerApproved`), as useTx signs them: keyed by the account and salts. */
export const registerPlan = (account: `0x${string}`, permissions: readonly JawPermission[]): TxPlan => ({
  key: txKey(
    "register",
    account,
    permissions.map((p) => p.salt),
  ),
  user: account,
  calls: () => Promise.resolve(buildRegisterCalls(account, permissions)),
  fallback: REGISTER_FALLBACK,
});
