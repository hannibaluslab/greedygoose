import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, type Hex } from "viem";
import { assertAllowed } from "@/lib/allowlist";
import type { Call } from "@/lib/aave/tx";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import type { JawPermission } from "@/lib/agents/permissions";
import { permissionTuple } from "@/lib/protocols/abis";

/*
 * Registration (runner switch plan, option 1; Adrian, 2026-10-20): a JAW grant only approves the permission in the
 * manager, and GooseExecutor runs a job once it is registered. No runner watches the manager's events, so the app
 * registers it, from the user's own account, in the change's last batch after its grants: `registerApproved` with the permission as the
 * manager's PermissionApproved event logs it, abi.encode(permission). Anyone may call it; the executor rebuilds the
 * job's template and checks the manager approved exactly that.
 */

/** What a registration that would fail says when the executor's reason has no words of its own. */
export const REGISTER_FALLBACK = "We couldn’t finish turning this on right now. Try again in a moment.";

/** A permission as the manager's PermissionApproved event logs it: abi.encode(permission). */
export const encodePermission = (p: JawPermission): Hex => encodeAbiParameters([permissionTuple], [p]);

/** The permission a registration carries. Throws on bytes that aren't one. */
export function decodePermission(data: Hex): JawPermission {
  const [p] = decodeAbiParameters([permissionTuple], data);
  return { ...p, calls: [...p.calls], spends: [...p.spends] };
}

/**
 * One batch for a change's last JAW sheet (Adrian, 2026-10-20: "Batch those into one"): its settings in the executor's
 * registry (`setMix`, `setKeepMix`, each built by its own builder), then one `registerApproved` per new grant (the
 * user's own grants of the executor, nothing else). Atomic: all of it lands, or none of it.
 */
export function buildRegisterCalls(
  user: `0x${string}`,
  permissions: readonly JawPermission[],
  settings: readonly Call[] = [],
): Call[] {
  if (!GOOSE_EXECUTOR) throw new Error("Agents aren't available yet");
  const executor = GOOSE_EXECUTOR;
  if (permissions.length === 0 && settings.length === 0) throw new Error("Nothing to register");
  return assertAllowed(user, [
    ...settings,
    ...permissions.map((p) => ({
      to: executor,
      data: encodeFunctionData({
        abi: gooseExecutorAbi,
        functionName: "registerApproved",
        args: [encodePermission(p)],
      }),
      value: 0n,
    })),
  ]);
}
