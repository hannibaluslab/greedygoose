import { encodeFunctionData } from "viem";
import type { Permission } from "@jaw.id/core";
import type { ActivityItem } from "@/lib/activity/decode";
import type { Call } from "@/lib/aave/tx";
import { oneTapGrantCalls } from "@/lib/agents/oneTapGrant";
import type { JawPermission } from "@/lib/agents/permissions";
import { PROTOCOLS } from "@/lib/protocols/config";
import { permissionManagerAbi } from "@/lib/protocols/abis";
import { buildRegisterCalls, REGISTER_FALLBACK } from "@/lib/agents/register";
import { assertAllowed, type AllowContext } from "@/lib/allowlist";
import { buildSetKeepMixCalls, buildSetMixCalls } from "@/lib/agents/settings";
import { txKey, type TxPlan, type TxReceipt } from "../prepared";

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

/**
 * A change's last batch: its registry settings, then the registrations of its new grants (`registerApproved`), as
 * useTx signs them: keyed by the account, the grants' salts and the settings' calldata.
 */
export const registerPlan = (
  account: `0x${string}`,
  permissions: readonly JawPermission[],
  settings: readonly Call[] = [],
): TxPlan => ({
  key: txKey(
    "register",
    account,
    permissions.map((p) => p.salt),
    settings.map((c) => c.data),
  ),
  user: account,
  calls: () => Promise.resolve(buildRegisterCalls(account, permissions, settings)),
  fallback: REGISTER_FALLBACK,
});

/** Calls that go first in a change's batch (Start earning's savings supply), with what the allowlist must know. */
export type ChangePrefix = {
  /** What shapes them, for the plan's key. */
  key: unknown;
  calls: () => Promise<Call[]>;
  allow?: AllowContext;
  activity?: ActivityItem[];
};

/** What a change's batch reads on Base while it's built, and what runs once it lands. */
type ChangeDeps = {
  /** addOwnerAddress(manager) when the manager doesn't own the account yet (oneTapGrant `managerOwnerCalls`). */
  ownerCalls: () => Promise<Call[]>;
  /** Records the change off-chain once it landed (JAW's list): never sends anything again. */
  landed?: (receipts: readonly TxReceipt[]) => Promise<void>;
};

/** manager.revoke(permission): a grant of the user's own, taken back in the manager. */
export const revokeCall = (p: JawPermission): Call => ({
  to: PROTOCOLS.PERMISSION_MANAGER as `0x${string}`,
  data: encodeFunctionData({ abi: permissionManagerAbi, functionName: "revoke", args: [p] }),
  value: 0n,
});

/**
 * A change in one signature (D14 dropped, Adrian 2026-10-20: "the permission, the cash move and the registration in one
 * signature like Leo's Guardian"): `prefix` first (Start earning's supply), then each grant it takes back (`revokes`: a
 * job turned off, or the grant a new one replaces, so nothing old stays approved), then the owner call when the manager
 * doesn't own the account yet, each new grant's approve in JAW's manager, the registry `settings`, and each new grant's
 * registration (oneTapGrantCalls); the whole batch through the allowlist. Keyed by the account, every grant's salt
 * (new ones picked once, lib/agents/picks.ts), the settings' calldata and the prefix's key.
 */
export function agentChangePlan(
  account: `0x${string}`,
  change: {
    grants: readonly Permission[];
    revokes?: readonly JawPermission[];
    settings?: readonly Call[];
    prefix?: ChangePrefix;
  },
  deps: ChangeDeps,
): TxPlan {
  const { grants, revokes = [], settings = [], prefix } = change;
  return {
    key: txKey(
      "agents",
      account,
      grants.map((p) => p.salt),
      revokes.map((p) => p.salt),
      settings.map((c) => c.data),
      prefix?.key ?? null,
    ),
    user: account,
    calls: async () => {
      const head = prefix ? await prefix.calls() : [];
      const tail =
        grants.length > 0
          ? oneTapGrantCalls(account, grants, await deps.ownerCalls(), settings)
          : settings.length > 0
            ? buildRegisterCalls(account, [], settings)
            : [];
      return assertAllowed(account, [...head, ...revokes.map(revokeCall), ...tail], prefix?.allow);
    },
    fallback: REGISTER_FALLBACK,
    activity: prefix?.activity,
    landed: deps.landed,
  };
}
