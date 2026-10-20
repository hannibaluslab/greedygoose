import { isAddressEqual, type Address } from "viem";
import {
  PERIOD,
  readAgentGrant,
  type AgentJob,
  type JawPermission,
  type ListedPermission,
} from "@/lib/agents/permissions";

/*
 * An agent grant as Base holds it (the manager's struct, with each period as a number), read against the same job
 * templates as JAW's list: what the allowlist lets a one-signature batch approve, register and revoke, and what the
 * app puts back in JAW's relay.
 */

/** JAW's word for each JustaPermissionManager PeriodUnit, as its relay lists a spend (core `periodToEnum`, reversed). */
export const PERIOD_WORD: Record<number, string> = {
  [PERIOD.Minute]: "minute",
  [PERIOD.Hour]: "hour",
  [PERIOD.Day]: "day",
  [PERIOD.Week]: "week",
  [PERIOD.Month]: "month",
  [PERIOD.Forever]: "forever",
};

/**
 * An on-chain permission (the manager's struct, as `permissionOf` or a batch's approve carries it) read as JAW's relay
 * lists it, so `readAgentGrant` checks it against the same templates; null for a period JAW has no word for.
 */
function listedFromPermission(p: JawPermission, permissionId: string): ListedPermission | null {
  const spends: ListedPermission["spends"] = [];
  for (const s of p.spends) {
    const unit = PERIOD_WORD[s.unit];
    if (!unit) return null;
    spends.push({ token: s.token, allowance: s.allowance.toString(), unit, multiplier: s.multiplier });
  }
  return {
    permissionId,
    spender: p.spender,
    start: p.start,
    end: p.end,
    salt: `0x${p.salt.toString(16)}`,
    calls: p.calls.map((c) => ({ target: c.target, selector: c.selector, checker: c.checker })),
    spends,
  };
}

/**
 * The job an on-chain permission is a grant of: `user`'s own, to `executor`, and exactly one job's template; null for
 * anything else. What the allowlist lets a batch approve and register.
 */
export function agentJobOf(p: JawPermission, user: Address, executor: Address): AgentJob | null {
  if (!isAddressEqual(p.account, user) || !isAddressEqual(p.spender, executor)) return null;
  const listed = listedFromPermission(p, "0x");
  return listed ? (readAgentGrant(listed, executor)?.job ?? null) : null;
}
