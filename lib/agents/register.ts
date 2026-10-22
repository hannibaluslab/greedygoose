import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, hexToBigInt, size, slice, type Hex } from "viem";
import { assertAllowed } from "@/lib/allowlist";
import type { Call } from "@/lib/aave/tx";
import { GOOSE_GUARD } from "@/lib/agents/config";
import { guardAbi } from "@/lib/agents/abis/GooseGuard";
import { JOBS, type AgentJob, type JawPermission } from "@/lib/agents/permissions";
import { permissionTuple } from "@/lib/protocols/abis";

/*
 * Registration (spec-final-v2.md §5): a grant only approves the permission in JAW's manager, and GooseGuard runs a job
 * once the account itself registers it, in the same batch: `register(job, permission)` with the permission as the
 * manager's PermissionApproved event logs it, abi.encode(permission). Only the account can register its own grant, only
 * the newest counts (its start must be later than any the job had), and the allowlist holds the job to the grant's own
 * template. `unregister(job)` switches a job off and keeps its start.
 */

/** What a registration that would fail says when the Guard's reason has no words of its own. */
export const REGISTER_FALLBACK = "We couldn’t finish turning this on right now. Try again in a moment.";

/** A permission as the manager's PermissionApproved event logs it: abi.encode(permission). */
export const encodePermission = (p: JawPermission): Hex => encodeAbiParameters([permissionTuple], [p]);

/** The permission a registration carries. Throws on bytes that aren't one. */
export function decodePermission(data: Hex): JawPermission {
  const [p] = decodeAbiParameters([permissionTuple], data);
  return { ...p, calls: [...p.calls], spends: [...p.spends] };
}

/**
 * The start of the grant GooseGuard holds for a job, from `permissionOf`'s bytes: word 3 of abi.encode(permission)
 * (the tuple's offset, account, spender, then start). It is the Guard's high-water mark, kept after `unregister`, so a
 * new grant must start after it. 0 when the job never had one.
 */
export function heldStartOf(data: Hex): number {
  return size(data) >= 128 ? Number(hexToBigInt(slice(data, 96, 128))) : 0;
}

function guard() {
  if (!GOOSE_GUARD) throw new Error("Agents aren't available yet");
  return GOOSE_GUARD;
}

/** GooseGuard's register(job, permission) for one grant of the user's own. */
const registerCall = (job: AgentJob, p: JawPermission): Call => ({
  to: guard(),
  data: encodeFunctionData({ abi: guardAbi, functionName: "register", args: [JOBS.indexOf(job), encodePermission(p)] }),
  value: 0n,
});

/**
 * One batch for a change's last JAW sheet (Adrian, 2026-10-20: "Batch those into one"): its settings in GooseGuard
 * (`setMix`, `setKeepMix`, `setTopUps`, `unregister`, each built by its own builder), then one `register` per new grant
 * (the user's own grants of the Guard, each as its own job, nothing else). Atomic: all of it lands, or none of it.
 */
export function buildRegisterCalls(
  user: `0x${string}`,
  grants: readonly { job: AgentJob; p: JawPermission }[],
  settings: readonly Call[] = [],
): Call[] {
  if (grants.length === 0 && settings.length === 0) throw new Error("Nothing to register");
  return assertAllowed(user, [...settings, ...grants.map((g) => registerCall(g.job, g.p))]);
}

/** GooseGuard's unregister(job) for each job turned off: the job stops at once, its start stays the high-water mark. */
export function buildUnregisterCalls(user: `0x${string}`, jobs: readonly AgentJob[]): Call[] {
  if (jobs.length === 0) return [];
  return assertAllowed(
    user,
    jobs.map((job) => ({
      to: guard(),
      data: encodeFunctionData({ abi: guardAbi, functionName: "unregister", args: [JOBS.indexOf(job)] }),
      value: 0n,
    })),
  );
}
