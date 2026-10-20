import { createConfig, http } from "wagmi";
import { jaw } from "@jaw.id/wagmi";
import type { JawTheme } from "@jaw.id/core";
import { CHAIN } from "@/lib/chain";
import type { Rehearsal } from "@/lib/rehearsal";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "GreedyGoo";
const ENS_PARENT = process.env.NEXT_PUBLIC_ENS_PARENT ?? "justan.id";

/**
 * JAW's own frames (sign in, sign up, every Review + Face ID sheet) wear the app's ink and lime, so the app and
 * JAW read as one product (Adrian, 2026-10-15). Colours from the goose and the canvas tokens.
 */
const JAW_THEME = {
  mode: "dark",
  accentColor: "#d4ff3c",
  accentColorForeground: "#0e0d0b",
  borderRadius: "lg",
  colors: {
    background: "#0e0d0b",
    foreground: "#f5f0e2",
    card: "#1a1915",
    cardForeground: "#f5f0e2",
    popover: "#1a1915",
    popoverForeground: "#f5f0e2",
    primary: "#d4ff3c",
    primaryForeground: "#0e0d0b",
    secondary: "#24221d",
    secondaryForeground: "#f5f0e2",
    muted: "#24221d",
    mutedForeground: "#8a8479",
    accent: "#24221d",
    accentForeground: "#f5f0e2",
    border: "#2c2a25",
    input: "#24221d",
    ring: "#d4ff3c",
    positive: "#d4ff3c",
    halo: "#d4ff3c",
    scrim: "#0e0d0b",
    identiconTile: "#24221d",
  },
} as const satisfies JawTheme;

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
          theme: JAW_THEME,
        }),
      ],
  // A fork reads Base's state the first time it is touched, which can take longer than viem's 10 s.
  transports: {
    [CHAIN.id]: REHEARSAL ? http(REHEARSAL.rpc, { timeout: 60_000 }) : http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
