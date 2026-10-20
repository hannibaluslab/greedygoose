import { encodeFunctionData, isAddressEqual, toFunctionSelector, type Hex } from "viem";
import type { Permission } from "@jaw.id/core";
import type { ActivityItem } from "@/lib/activity/decode";
import type { Call } from "@/lib/aave/tx";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
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

/**
 * Another write's plan as the first calls of a change's batch (Turn into cash's conversion): its calls, key and
 * activity, with nothing more for the allowlist to know.
 */
export const planPrefix = (plan: TxPlan): ChangePrefix => ({
  key: plan.key,
  calls: async () => (typeof plan.calls === "function" ? plan.calls() : plan.calls),
  activity: plan.activity,
});

/** What a change's batch reads on Base while it's built, and what runs once it lands. */
type ChangeDeps = {
  /** The account's code on Base: none yet means JAW's factory deploys it in the same user operation. */
  getCode: (account: `0x${string}`) => Promise<Hex | undefined>;
  /** addOwnerAddress(manager) when the manager doesn't own the account yet (oneTapGrant `managerOwnerCalls`). */
  ownerCalls: () => Promise<Call[]>;
  /** Records the change off-chain once it landed (JAW's list): never sends anything again. */
  landed?: (receipts: readonly TxReceipt[]) => Promise<void>;
};

const REGISTER_APPROVED = toFunctionSelector("registerApproved(bytes)");
const isRegistration = (c: Call) =>
  !!GOOSE_EXECUTOR && isAddressEqual(c.to, GOOSE_EXECUTOR) && c.data.slice(0, 10).toLowerCase() === REGISTER_APPROVED;

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
 *
 * An account JAW hasn't deployed yet (money arrived, nothing ever sent) is simulated without its registrations (Adrian,
 * 2026-10-20: one Face ID there too): the executor checks the account's code and that the manager owns it, which JAW's
 * factory puts there first in the same user operation, so no simulation from the bare address can pass them. What
 * they check was read on Base instead: the executor allows the code of JAW's accounts (allowedCodehash of the factory's
 * clone, true on 0x778d), and JAW's v1 recipe makes the manager an owner (core accountRecord.js ACCOUNT_RECIPE_V1).
 * The supply and the approves are still simulated; if a registration ever failed, the whole batch would revert and
 * nothing would move.
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
  let deployed = true;
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
      const code = await deps.getCode(account);
      deployed = !!code && code !== "0x";
      const head = prefix ? await prefix.calls() : [];
      const tail =
        grants.length > 0
          ? oneTapGrantCalls(account, grants, deployed ? await deps.ownerCalls() : [], settings)
          : settings.length > 0
            ? buildRegisterCalls(account, [], settings)
            : [];
      return assertAllowed(account, [...head, ...revokes.map(revokeCall), ...tail], prefix?.allow);
    },
    simulated: (batch) => (deployed ? batch : batch.filter((c) => !isRegistration(c))),
    fallback: REGISTER_FALLBACK,
    activity: prefix?.activity,
    landed: deps.landed,
  };
}
