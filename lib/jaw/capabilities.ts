import type { ChainCapabilities } from "@jaw.id/core";
import { USDC } from "@/lib/tokens/registry";

/**
 * Decision D4: the user pays network fees in USDC via JAW's feeToken capability.
 * If USDC is not an accepted fee token on Base, writes are blocked (never silently require ETH).
 */
export function usdcFeeSupport(caps: ChainCapabilities | undefined): "supported" | "unsupported" | "unknown" {
  if (!caps) return "unknown";
  const ft = caps.feeToken;
  if (!ft?.supported) return "unsupported";
  const ok = ft.tokens.some((t) => t.feeToken && t.address.toLowerCase() === USDC.address.toLowerCase());
  return ok ? "supported" : "unsupported";
}

/**
 * EIP-5792 `atomic` as JAW reports it for the chain. JAW documents wallet_sendCalls as all-or-nothing
 * (one ERC-4337 UserOperation), so a missing report is "unknown", never a reason to block (plan item 3).
 */
export function atomicSupport(caps: ChainCapabilities | undefined): "supported" | "unsupported" | "unknown" {
  const status = (caps?.atomic as { status?: unknown } | undefined)?.status;
  if (status === "supported" || status === "ready") return "supported";
  return status === "unsupported" ? "unsupported" : "unknown";
}

/** Shown when JAW says it can't run a batch all-or-nothing, so its steps could land one without the other. */
export const NOT_ATOMIC = "Your account can’t do these steps in one go on Base right now, so nothing was sent.";

/**
 * How a batch goes to JAW: when it reports `atomic`, the batch requires it (atomicRequired, so JAW
 * refuses rather than run the steps apart); a report of "unsupported" stops a batch of several calls
 * before Face ID; no report sends it as before.
 */
export function atomicSend(caps: ChainCapabilities | undefined, callCount: number): { forceAtomic: boolean } | null {
  const atomic = atomicSupport(caps);
  if (atomic === "unsupported" && callCount > 1) return null;
  return { forceAtomic: atomic === "supported" };
}
