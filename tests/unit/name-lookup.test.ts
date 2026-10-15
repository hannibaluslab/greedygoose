import { beforeEach, describe, expect, it, vi } from "vitest";
import { toCoinType } from "viem";

/**
 * addressOfName against a stand-in for the mainnet client: what it does when the Base lookup has no address, has one,
 * or fails. viem answers null for "no Base address" (no resolver, no record, a gateway that has none), so a throw is
 * a real failure and must never fall back to the Ethereum address.
 */
const lookups: { base: () => Promise<`0x${string}` | null>; eth: () => Promise<`0x${string}` | null> } = {
  base: async () => null,
  eth: async () => null,
};
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      getEnsAddress: ({ coinType }: { coinType?: bigint }) => (coinType === BigInt(toCoinType(8453)) ? lookups.base() : lookups.eth()),
    }),
  };
});

const { addressOfName } = await import("@/lib/jaw/name");
const onBase = "0x2211d1D0020DAEA8039E46Cf1367962070d77DA9" as const;
const onEth = "0x5b76f5B8fc9D700624F78208132f91AD4e61a1f0" as const;

describe("addressOfName (a name's account, for Send and the Leaderboard)", () => {
  beforeEach(() => {
    lookups.base = async () => null;
    lookups.eth = async () => null;
  });

  it("takes the Base address first", async () => {
    lookups.base = async () => onBase;
    lookups.eth = async () => onEth;
    expect(await addressOfName("jesse.base.eth")).toEqual({ name: "jesse.base.eth", address: onBase, onBase: true });
  });

  it("falls back to the Ethereum address only when there is no Base address; outside the app's names it may be another account on Base", async () => {
    lookups.eth = async () => onEth;
    expect(await addressOfName("brian.base.eth")).toEqual({ name: "brian.base.eth", address: onEth, onBase: false });
    // A JAW name is the same account on every chain.
    expect(await addressOfName("extenso")).toEqual({ name: "extenso.justan.id", address: onEth, onBase: true });
  });

  it("a Base lookup that fails stops there: it never falls back to the Ethereum address", async () => {
    lookups.base = async () => {
      throw new Error("HTTP request failed");
    };
    lookups.eth = async () => onEth;
    await expect(addressOfName("rae.eth")).rejects.toThrow("HTTP request failed");
  });

  it("is null when the name points nowhere, and an address is returned as typed", async () => {
    expect(await addressOfName("nobody.eth")).toBeNull();
    expect(await addressOfName(onEth)).toEqual({ name: null, address: onEth, onBase: true });
  });
});
