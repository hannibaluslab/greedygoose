import { getAddress, type Address } from "viem";
import { createConnector } from "wagmi";
import { CHAIN_ID } from "@/lib/chain";
import { createForkSigner, type ForkSigner, type ForkSignerOptions } from "./signer";

export const REHEARSAL_CONNECTOR_TYPE = "rehearsal";

/** Whether the viewer signed in on the fork, so a reload reconnects like JAW's connector does. */
const CONNECTED_KEY = "gg.rehearsal.connected";
const remembered = () => {
  try {
    return globalThis.localStorage?.getItem(CONNECTED_KEY) === "1";
  } catch {
    return false;
  }
};
const remember = (on: boolean) => {
  try {
    if (on) globalThis.localStorage?.setItem(CONNECTED_KEY, "1");
    else globalThis.localStorage?.removeItem(CONNECTED_KEY);
  } catch {}
};

/**
 * The rehearsal's wagmi connector: signs in as the rehearsal account and hands wagmi the fork signer
 * (`./signer.ts`) as its provider. Development only (lib/rehearsal/flag.ts).
 */
export function rehearsalConnector(o: ForkSignerOptions) {
  let provider: ForkSigner | undefined;
  const account = getAddress(o.account);
  return createConnector<ForkSigner>((config) => ({
    id: "rehearsal",
    name: "Rehearsal (local fork)",
    type: REHEARSAL_CONNECTOR_TYPE,
    async connect({ withCapabilities } = {}) {
      const p = await this.getProvider();
      await p.assertFork(); // anvil on this machine, chain 8453, an unlocked owner: or no sign-in
      remember(true);
      return {
        accounts: (withCapabilities ? [{ address: account, capabilities: {} }] : [account]) as never,
        chainId: CHAIN_ID,
      };
    },
    async disconnect() {
      remember(false);
    },
    async getAccounts() {
      return [account] as readonly Address[];
    },
    async getChainId() {
      return CHAIN_ID;
    },
    async getProvider() {
      provider ??= createForkSigner(o);
      return provider;
    },
    async isAuthorized() {
      return remembered();
    },
    async switchChain({ chainId }) {
      const chain = config.chains.find((c) => c.id === chainId);
      if (!chain || chainId !== CHAIN_ID) throw new Error("The rehearsal runs on Base only");
      return chain;
    },
    onAccountsChanged() {},
    onChainChanged(chainId) {
      config.emitter.emit("change", { chainId: Number(chainId) });
    },
    onDisconnect() {
      remember(false);
      config.emitter.emit("disconnect");
    },
  }));
}
