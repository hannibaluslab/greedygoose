import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from "viem";
import { interestIn, sinceLastMoveRaw } from "@/lib/earned";
import { PROTOCOLS } from "@/lib/protocols/config";

const events = parseAbi([
  "event Mint(address indexed caller, address indexed onBehalfOf, uint256 value, uint256 balanceIncrease, uint256 index)",
  "event Burn(address indexed from, address indexed target, uint256 value, uint256 balanceIncrease, uint256 index)",
]);
const ME = "0xFf13Dc32AcA90b3D61058ea26Df1D895F842eE1F";
const OTHER = "0x000000000000000000000000000000000000dEaD";
const data = (value: bigint, increase: bigint) =>
  encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [value, increase, 10n ** 27n]);
const mint = (to: string, increase: bigint, address: string = PROTOCOLS.AUSDC) => ({
  address: address as `0x${string}`,
  topics: encodeEventTopics({
    abi: events,
    eventName: "Mint",
    args: { caller: to as `0x${string}`, onBehalfOf: to as `0x${string}` },
  }) as Hex[],
  data: data(1_000_000n, increase),
});
const burn = (from: string, increase: bigint) => ({
  address: PROTOCOLS.AUSDC,
  topics: encodeEventTopics({
    abi: events,
    eventName: "Burn",
    args: { from: from as `0x${string}`, target: from as `0x${string}` },
  }) as Hex[],
  data: data(1_000_000n, increase),
});

describe("total earned in savings", () => {
  it("adds the interest each of the account's own aUSDC Mints and Burns closed", () => {
    expect(interestIn([mint(ME, 29n), burn(ME, 100n)], ME)).toBe(129n);
  });

  it("leaves out someone else's moves and other tokens' events", () => {
    expect(interestIn([mint(OTHER, 50n), mint(ME, 7n, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")], ME)).toBe(0n);
  });

  it("adds what built up since the last move: the balance now less the balance at that move's index", () => {
    // 1,757,694 scaled at index 1.14988… was 2,021,138; the balance is 2,021,167 now.
    expect(sinceLastMoveRaw(2_021_167n, 1_757_694n, 1149880534825988900466754985n)).toBe(29n);
    expect(sinceLastMoveRaw(0n, 0n, 0n)).toBe(0n);
  });
});
