"use client";

import { useMemo, useSyncExternalStore } from "react";
import { encodeFunctionData, isAddressEqual } from "viem";
import { useReadContracts } from "wagmi";
import { GUARDIAN, GUARDIAN_CHECKER, GUARDIAN_KEEPER, guardianConfigured } from "@/lib/guardian/config";
import { justanAccountAbi, permissionManagerAbi } from "@/lib/guardian/abis";
import { approveGuardianCall, buildGuardianPermission, revokeGuardianCall, toTuple, type Call } from "@/lib/guardian/permission";
import { readGuardian, subscribeGuardian, writeGuardian } from "@/lib/guardian/store";

export type GuardianStatus = "unconfigured" | "off" | "on" | "loading";

/** Guardian state for one account, rebuilt from the stored record and confirmed on-chain. */
export function useGuardian(account: `0x${string}`) {
  const snap = useSyncExternalStore(subscribeGuardian, () => JSON.stringify(readGuardian(account)), () => "null");
  const record = useMemo(() => JSON.parse(snap) as ReturnType<typeof readGuardian>, [snap]);
  const configured = guardianConfigured();

  const permission = useMemo(
    () =>
      configured && record
        ? buildGuardianPermission({
            account,
            spender: GUARDIAN_KEEPER!,
            checker: GUARDIAN_CHECKER!,
            dailyCapRaw: BigInt(record.capRaw),
            start: record.start,
            end: record.end,
          })
        : null,
    [configured, record, account],
  );

  const owner = useReadContracts({
    allowFailure: true,
    query: { enabled: configured, refetchInterval: 60_000 },
    contracts: [{ address: account, abi: justanAccountAbi, functionName: "isOwnerAddress", args: [GUARDIAN.PERMISSION_MANAGER] }],
  });
  const tuple = permission ? toTuple(permission) : null;
  const perm = useReadContracts({
    allowFailure: true,
    query: { enabled: !!tuple, refetchInterval: 20_000 },
    contracts: tuple
      ? [
          { address: GUARDIAN.PERMISSION_MANAGER, abi: permissionManagerAbi, functionName: "isApproved", args: [tuple] },
          { address: GUARDIAN.PERMISSION_MANAGER, abi: permissionManagerAbi, functionName: "isRevoked", args: [tuple] },
        ]
      : [],
  });

  const managerIsOwner = owner.data?.[0]?.result === true;
  const approved = perm.data?.[0]?.result === true;
  const revoked = perm.data?.[1]?.result === true;
  const nowSec = useNowSec();
  const expired = !!record && nowSec >= record.end;

  const status: GuardianStatus = !configured
    ? "unconfigured"
    : owner.isLoading || (!!tuple && perm.isLoading)
      ? "loading"
      : permission && approved && !revoked && !expired
        ? "on"
        : "off";

  /** Calls to turn Guardian on with a daily cap. Stores the record first so it can always be revoked. */
  function enableCalls(capRaw: bigint): Call[] {
    if (!configured) throw new Error("Guardian isn't available yet");
    const now = Math.floor(Date.now() / 1000);
    // Start a few minutes in the past so the first check can't land before `start` on-chain.
    const rec = { capRaw: capRaw.toString(), start: now - 300, end: now + 365 * 86_400 };
    writeGuardian(account, rec);
    const perm = buildGuardianPermission({ account, spender: GUARDIAN_KEEPER!, checker: GUARDIAN_CHECKER!, dailyCapRaw: capRaw, start: rec.start, end: rec.end });
    const calls: Call[] = [];
    if (!managerIsOwner) {
      // Same first step JAW's own grant flow takes: let the permission manager act for this account.
      calls.push({ to: account, data: encodeFunctionData({ abi: justanAccountAbi, functionName: "addOwnerAddress", args: [GUARDIAN.PERMISSION_MANAGER] }), value: 0n });
    }
    calls.push(approveGuardianCall(perm));
    return assertGuardianCalls(account, calls);
  }

  function disableCalls(): Call[] {
    if (!permission) throw new Error("Guardian isn't on");
    return assertGuardianCalls(account, [revokeGuardianCall(permission)]);
  }

  return { status, record, permission, managerIsOwner, enableCalls, disableCalls, clear: () => writeGuardian(account, null), refetch: () => Promise.all([owner.refetch(), perm.refetch()]) };
}

/** Only the manager (approve/revoke) or the account itself (addOwnerAddress(manager)) may be targeted. */
function assertGuardianCalls(account: `0x${string}`, calls: Call[]): Call[] {
  for (const c of calls) {
    const ok = isAddressEqual(c.to, GUARDIAN.PERMISSION_MANAGER) || isAddressEqual(c.to, account);
    if (!ok || c.value !== 0n) throw new Error(`Blocked: unexpected target ${c.to}`);
  }
  return calls;
}

/** Current time in seconds, refreshed every minute (render-safe; no Date.now() during render). */
const subscribeMinute = (cb: () => void) => {
  const id = setInterval(cb, 60_000);
  return () => clearInterval(id);
};
const minuteNow = () => Math.floor(Date.now() / 60_000) * 60;
function useNowSec() {
  return useSyncExternalStore(subscribeMinute, minuteNow, () => 0);
}
