import {
  AbiDecodingDataSizeTooSmallError,
  AbiDecodingZeroDataError,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  erc20Abi,
  parseAbi,
  type Address,
  type Client,
} from "viem";
import { getBalance, getCode, getTransactionCount, readContract } from "viem/actions";
import { USDC } from "@/lib/tokens/registry";
import type { BaseCheck } from "./recipient";

/** A token's and a pool's own questions: every ERC-20 answers the first two, every Uniswap- or Aerodrome-style pool the last two. */
const tokenOrPoolAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

/** The contract didn't answer that question (it reverted, or answered nothing a value can be read from); any other error is thrown on. */
const noAnswer = (e: unknown) =>
  e instanceof BaseError &&
  !!e.walk(
    (x) =>
      x instanceof ContractFunctionRevertedError ||
      x instanceof ContractFunctionZeroDataError ||
      x instanceof AbiDecodingZeroDataError ||
      x instanceof AbiDecodingDataSizeTooSmallError,
  );
const answers = (p: Promise<unknown>) =>
  p.then(
    () => true,
    (e) => {
      if (noAnswer(e)) return false;
      throw e;
    },
  );

/**
 * Whether a contract is a token or a trading pool, not an account: a token (it answers decimals and totalSupply) or a
 * pool (token0 and token1). Money sent to one is stuck or taken by whoever trades next. Accounts (JAW's, a Safe) answer
 * none of these. This catches what APP_CONTRACTS can't list: other tokens (WETH) and the venues' pools, whose
 * addresses are worked out from the factories rather than kept.
 */
async function isTokenOrPool(client: Client, address: Address): Promise<boolean> {
  const ask = (functionName: "decimals" | "totalSupply" | "token0" | "token1") =>
    answers(readContract(client, { address, abi: tokenOrPoolAbi, functionName }));
  const [decimals, supply, token0, token1] = await Promise.all([
    ask("decimals"),
    ask("totalSupply"),
    ask("token0"),
    ask("token1"),
  ]);
  return (decimals && supply) || (token0 && token1);
}

/** One read of the recipient on Base, in parallel: its code, its nonce, its ETH and its USDC; then, for a contract, whether it's a token or a pool. */
export async function readRecipient(client: Client, address: Address): Promise<BaseCheck> {
  const [code, nonce, eth, usdc] = await Promise.all([
    getCode(client, { address }),
    getTransactionCount(client, { address }),
    getBalance(client, { address }),
    readContract(client, { address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
  ]);
  const hasCode = !!code && code !== "0x";
  return {
    code: hasCode,
    used: hasCode || nonce > 0 || eth > 0n || usdc > 0n,
    notAccount: hasCode && (await isTokenOrPool(client, address)),
  };
}
