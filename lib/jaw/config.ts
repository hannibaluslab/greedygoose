import { createConfig, http } from "wagmi";
import { jaw } from "@jaw.id/wagmi";
import { CHAIN } from "@/lib/chain";
import type { Rehearsal } from "@/lib/rehearsal";

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "GreedyGoose";
export const ENS_PARENT = process.env.NEXT_PUBLIC_ENS_PARENT ?? "justan.id";

/**
 * Development only: the dress rehearsal (scripts/rehearsal/README.md), a local anvil fork of Base with fake money and a
 * fork signer in place of JAW. The condition is written out here, not imported, so the bundler sees it is false in a
 * production build and leaves the signer out (`npm run rehearsal:check-build`); `next build` always runs as production.
 */
function rehearsal(): Rehearsal | null {
  if (process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_REHEARSAL_RPC) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a static import would ship the signer in every build
    return (require("@/lib/rehearsal") as typeof import("@/lib/rehearsal")).loadRehearsal();
  }
  return null;
}

export const REHEARSAL = rehearsal();

/** The connector the Welcome screen signs in with: JAW's, or the fork signer's during a rehearsal. */
export const SIGN_IN_CONNECTOR_TYPE = REHEARSAL?.connectorType ?? jaw.type;

/**
 * JAW is the only wallet (CLAUDE.md). CrossPlatform mode (the SDK default) is what
 * lets a JAW account created in another app sign in here with its stocks.
 */
export const wagmiConfig = createConfig({
  chains: [CHAIN],
  connectors: REHEARSAL
    ? [REHEARSAL.connector]
    : [
        jaw({
          apiKey: process.env.NEXT_PUBLIC_JAW_API_KEY,
          appName: APP_NAME,
          appLogoUrl: process.env.NEXT_PUBLIC_APP_LOGO_URL || null,
          defaultChainId: CHAIN.id,
          ens: ENS_PARENT,
        }),
      ],
  // A fork reads Base's state the first time it is touched, which can take longer than viem's 10 s.
  transports: { [CHAIN.id]: REHEARSAL ? http(REHEARSAL.rpc, { timeout: 60_000 }) : http(process.env.NEXT_PUBLIC_BASE_RPC_URL) },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
