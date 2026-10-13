import { createConfig, http } from "wagmi";
import { jaw } from "@jaw.id/wagmi";
import { CHAIN } from "@/lib/chain";

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "GreedyGoose";
export const ENS_PARENT = process.env.NEXT_PUBLIC_ENS_PARENT ?? "justan.id";

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
