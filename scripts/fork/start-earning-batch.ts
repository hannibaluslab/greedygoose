/**
 * The app's own bytes for Start earning on an account JAW hasn't deployed yet, for
 * contracts/test/OneTapNewAccountFork.t.sol: the fork runs exactly the batch this TypeScript builds, the way Home's card
 * builds it (useStartEarning: startEarningPlan, then startEarningPrefix in front of earning's grant), the grant as
 * useCashSetup `earningPlan` asks useAgents `changePlan` for it (jobGrant("save", CAP_MAX), jawPermission), put together
 * by agentChangePlan with the allowlist. getCode answers "0x", as Base does for a never-used account, so no owner call
 * is read or added and the registration is left out of the simulation. Nothing is signed or sent. Forge calls it
 * through vm.ffi with NEXT_PUBLIC_GOOSE_EXECUTOR set to the fork's executor; it prints
 * abi.encode(calls, grants, simulated) on stdout, `simulated` being the part the app simulates before the tap.
 *
 *   account start salt capMax walletRaw
 *
 * `start` and `salt` stand in for lib/agents/picks.ts (the device's clock less five minutes, and 256 random bits).
 */
import { encodeAbiParameters, type Address, type Hex } from "viem";
import { contractPermission, jawPermission } from "@/lib/agents/oneTapGrant";
import { GRANT_SECONDS, jobGrant } from "@/lib/agents/permissions";
import { encodePermission } from "@/lib/agents/register";
import { startEarningPlan, startEarningPrefix } from "@/lib/startEarning";
import { agentChangePlan } from "@/lib/tx/plans";
import type { Call } from "@/lib/aave/tx";

const [account, startArg, saltArg, capMaxArg, walletArg] = process.argv.slice(2) as [
  Address,
  string,
  string,
  string,
  string,
];
const executor = process.env.NEXT_PUBLIC_GOOSE_EXECUTOR as Address;
const start = Number(startArg);
const salt = BigInt(saltArg);
const capMaxRaw = BigInt(capMaxArg);
const walletRaw = BigInt(walletArg);

async function batch() {
  // The wallet read again while it's prepared answers what the card showed.
  const supply = startEarningPlan(account, walletRaw, () => Promise.resolve(walletRaw));
  if (!supply) throw new Error("Under the smallest amount");
  const grant = jawPermission(account, executor, start + GRANT_SECONDS, jobGrant("save", capMaxRaw), { start, salt });
  const plan = agentChangePlan(
    account,
    { grants: [grant], prefix: startEarningPrefix(supply) },
    {
      getCode: () => Promise.resolve("0x" as Hex),
      ownerCalls: () => Promise.reject(new Error("a never-used account's owners are never read")),
    },
  );
  const calls = await (plan.calls as () => Promise<Call[]>)();
  if (!plan.simulated) throw new Error("No simulated part");
  return { calls, grants: [grant], simulated: plan.simulated(calls) };
}

const callsType = {
  type: "tuple[]",
  components: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
} as const;
const asCalls = (calls: Call[]) => calls.map((c) => ({ target: c.to, value: c.value, data: c.data }));

batch().then(
  ({ calls, grants, simulated }) =>
    process.stdout.write(
      encodeAbiParameters(
        [callsType, { type: "bytes[]" }, callsType],
        [asCalls(calls), grants.map((g) => encodePermission(contractPermission(g))), asCalls(simulated)],
      ),
    ),
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
