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

export const supportsAtomicBatch = (caps: ChainCapabilities | undefined) => {
  const atomic = caps?.atomic as { status?: string } | undefined;
  return atomic?.status === "supported" || atomic?.status === "ready";
};
