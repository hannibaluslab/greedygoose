import { createConfig, http } from "wagmi";
import { jaw } from "@jaw.id/wagmi";
import type { JawTheme } from "@jaw.id/core";
import { CHAIN } from "@/lib/chain";

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "GreedyGoose";
export const ENS_PARENT = process.env.NEXT_PUBLIC_ENS_PARENT ?? "justan.id";

/**
 * JAW's own frames (sign in, sign up, every Review + Face ID sheet) wear the app's ink and lime, so the app and
 * JAW read as one product (Adrian, 2026-10-15). Colours from the goose and the canvas tokens.
 */
export const JAW_THEME = {
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
 * JAW is the only wallet (CLAUDE.md). CrossPlatform mode (the SDK default) is what
 * lets a JAW account created in another app sign in here with its stocks.
 */
export const wagmiConfig = createConfig({
  chains: [CHAIN],
  connectors: [
    jaw({
      apiKey: process.env.NEXT_PUBLIC_JAW_API_KEY,
      appName: APP_NAME,
      appLogoUrl: process.env.NEXT_PUBLIC_APP_LOGO_URL || null,
      defaultChainId: CHAIN.id,
      ens: ENS_PARENT,
      theme: JAW_THEME,
    }),
  ],
  transports: { [CHAIN.id]: http(process.env.NEXT_PUBLIC_BASE_RPC_URL) },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
