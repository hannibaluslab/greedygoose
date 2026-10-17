"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { toast } from "sonner";
import type { TxPhase } from "./useTx";
import { CHAIN_ID } from "@/lib/chain";
import { boughtAmount, boughtLine, tradedLine } from "@/lib/activity/bought";

/**
 * When a buy lands, Home (F1-6, F2-7): the sheet closes, Home opens on the re-read balances and the dark toast says
 * what arrived, read from the receipt (Activity caches receipts under the same key). Once per transaction.
 * `credit` marks a Credit Buy; `from`, the stock a Trade sold for it ("Traded NVDA for 0.0086 AAPL").
 */
export function useBoughtHome(p: {
  phase: TxPhase;
  user: `0x${string}`;
  symbol: string;
  txHash?: `0x${string}`;
  credit?: boolean;
  from?: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const queryClient = useQueryClient();
  const landed = useRef(false);
  const { phase, user, symbol, txHash, credit, from, onClose } = p;

  useEffect(() => {
    if (phase !== "done" || landed.current) return;
    landed.current = true;
    onClose();
    router.push("/home");
    const arrived = async () => {
      if (!txHash || !client) return null;
      const r = await queryClient.fetchQuery({
        queryKey: ["receipt", txHash],
        queryFn: () => client.getTransactionReceipt({ hash: txHash }),
        staleTime: Infinity,
      });
      return boughtAmount(r.logs, user, symbol);
    };
    void arrived()
      .catch(() => null)
      .then((amount) => toast.success(from ? tradedLine(amount, symbol, from) : boughtLine(amount, symbol, credit)));
  }, [phase, user, symbol, txHash, credit, from, onClose, router, client, queryClient]);
}
