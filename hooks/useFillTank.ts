"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { usePublicClient } from "wagmi";
import { usePrepare, useTx } from "@/hooks/useTx";
import type { Cash } from "@/lib/cash";
import { readCash } from "@/lib/cash/read";
import { CHAIN_ID } from "@/lib/chain";
import { fillRaw, fillTankPlan } from "@/lib/fuelTank";

/**
 * "Fill up" for the fuel tank (lib/fuelTank.ts): savings back into the wallet up to a full tank, one batch through useTx,
 * prepared while its button shows (`active`), so the tap opens JAW's sheet at once. Says so once it lands.
 */
export function useFillTank(account: `0x${string}`, cash: Cash | undefined, active: boolean) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const tx = useTx("This didn’t go through on Base. Your cash didn’t move, except any network fee.");
  const plan = active && cash ? fillTankPlan(account, cash, (u) => readCash(client!, u)) : null;
  const prep = usePrepare(tx.prep, plan);

  // Landed: said once, and the write goes back to idle for the next time.
  const said = useRef(false);
  const reset = tx.reset;
  useEffect(() => {
    if (tx.phase !== "done") return void (said.current = false);
    if (said.current) return;
    said.current = true;
    toast.success("Your fuel tank is full");
    reset();
  }, [tx.phase, reset]);

  return {
    /** The tank isn't full and savings can fill it. */
    canFill: !!cash && fillRaw(cash) !== null,
    phase: tx.phase,
    busy: tx.busy,
    checking: plan ? prep.checking : false,
    blocked: plan ? prep.blocked : false,
    error: tx.error ?? (plan ? prep.error : null),
    fill: () => {
      if (!plan) return;
      if (tx.phase === "failed") tx.reset();
      void tx.sign(plan);
    },
  };
}
