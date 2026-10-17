/**
 * Mainnet simulation (nothing sent): a real JAW account can approve a Guardian permission
 * on the real JustaPermissionManager with a single call (the manager is already an owner).
 * The checker must be a contract with code; the deployed GuardianChecker isn't on mainnet yet,
 * so any contract stands in here — approve() only validates that the checker has code.
 */
import { describe, expect, it } from "vitest";
import { createPublicClient, http } from "viem";
import { CHAIN } from "@/lib/chain";
import { GUARDIAN } from "@/lib/guardian/config";
import { justanAccountAbi } from "@/lib/guardian/abis";
import { approveGuardianCall, buildGuardianPermission, revokeGuardianCall } from "@/lib/guardian/permission";
import { AAVE } from "@/lib/aave/addresses";

const client = createPublicClient({ chain: CHAIN, transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL) });
const user = "0x14087c532332dE6E971Eb2F60a252cbf511F59eA" as const;

describe("Guardian on mainnet (simulated)", () => {
  it("the manager is already an owner of this JAW account", async () => {
    expect(
      await client.readContract({
        address: user,
        abi: justanAccountAbi,
        functionName: "isOwnerAddress",
        args: [GUARDIAN.PERMISSION_MANAGER],
      }),
    ).toBe(true);
  });

  it("approve then revoke a Guardian permission from the account", async () => {
    const now = Math.floor(Date.now() / 1000);
    const perm = buildGuardianPermission({
      account: user,
      spender: "0x00000000000000000000000000000000000000ee",
      checker: AAVE.HUB, // stand-in contract with code (see header)
      dailyCapRaw: 50_000_000n,
      start: now - 300,
      end: now + 365 * 86400,
    });
    const r = await client.simulateCalls({
      account: user,
      calls: [approveGuardianCall(perm), revokeGuardianCall(perm)].map(({ to, data }) => ({ to, data })),
    });
    expect(r.results.map((x) => x.status)).toEqual(["success", "success"]);
  });
});
