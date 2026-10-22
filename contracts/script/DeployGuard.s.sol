// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {GooseGuard} from "../src/GooseGuard.sol";
import {GoosePlanner} from "../src/GoosePlanner.sol";
import {IGooseGuard} from "../src/planner/PlanBase.sol";
import {ProtectPlanner} from "../src/planner/ProtectPlanner.sol";
import {TradePlanner} from "../src/planner/TradePlanner.sol";
import {CashPlanner} from "../src/planner/CashPlanner.sol";

interface ISpokeOracle {
    function ORACLE() external view returns (address);
}

interface IJawAccountFactory {
    function getImplementation() external view returns (address);
}

interface IAeroFactoryLike {
    function getPool(address tokenA, address tokenB, int24 tickSpacing) external view returns (address);
}

/// Deploys GooseGuard and GoosePlanner (its three helpers first) on Base. The owner broadcasts it, never Claude:
///
///   GUARD_OWNER=<the deployer's address> forge script script/DeployGuard.s.sol \
///     --rpc-url https://mainnet.base.org --account <the deployer's keystore> --broadcast
///
/// No amount limit anywhere, the live test included (decision 9); one owner key (decision 8). The floors are the
/// decided ones: Protect sells at most 3% under Aave's price, Rebalance and Turn into cash swap at most 0.5% under, the
/// pool within 1% of Aave's either way, $1 left in the wallet, and a whole payoff only under $1 (step0-facts.md).
/// GUARD_RUNNER replaces KeeperHub's wallet as the only runner (a rehearsal on anvil).
///
/// Then: KeeperHub's workflow q5vdv47dieyabhg4toiue reads `checkUpkeep(abi.encode(0,1))` from the Planner and writes
/// `performUpkeep` to the Guard at 5.5M (both steps' contract addresses change; nothing else). Each user grants their
/// agents again once, with the Guard as spender. The old executor 0x686c is paused after the swap.
contract DeployGuard is Script {
    uint256 internal constant BASE = 8453;

    /// KeeperHub's workflow wallet (Turnkey, 7702-delegated): the only runner (DEPLOYMENTS.md).
    address internal constant KEEPERHUB = 0x9c74d428Ff2707e0E9cB576AFFFD87c1b1eF3E93;
    /// The code of every account JAW's factory deploys, the EIP-1167 clone of JAW_ACCOUNT (DeployExecutor.s.sol).
    bytes32 internal constant JAW_CLONE_CODEHASH = 0xc79e2c8f7a03b38abd65a7e073fc3410849544bba74f53360c127775bc891848;
    address internal constant JAW_ACCOUNT = 0xbb4f7d5418Cd8DADB61bb95561179e517572cBCd;
    address internal constant JAW_FACTORY = 0x5803c076563C85799989d42Fc00292A8aE52fa9E;

    // The addresses GooseGuard fixes as constants, checked here against Base before anything is sent.
    address internal constant MANAGER = 0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8;
    address internal constant SPOKE = 0x17905Db0e4A3514467539956c084180616AE7B8D;
    address internal constant ORACLE = 0xaBaf048fD7675Ea34a84332371ffd5D55E322A47;
    address internal constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant AUSDC = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB;
    address internal constant ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
    address internal constant AERO_FACTORY = 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef;
    address internal constant AERODROME_V1_ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;
    address internal constant UNISWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant PSM3 = 0x1601843c5E9bC251A3272907010AFa41Fa18347E;
    address internal constant EUR_USD = 0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F;

    function run() external returns (GooseGuard guard, GoosePlanner planner) {
        require(block.chainid == BASE, "Base only: the Guard's addresses are Base's");
        checkCode();
        address owner = vm.envAddress("GUARD_OWNER");
        address runner = vm.envOr("GUARD_RUNNER", KEEPERHUB);
        vm.startBroadcast();
        guard = new GooseGuard(owner, runner, JAW_CLONE_CODEHASH, 300, 50, 100, 1e6, 1e6);
        IGooseGuard ig = IGooseGuard(address(guard));
        planner = new GoosePlanner(ig, new ProtectPlanner(ig), new TradePlanner(ig), new CashPlanner(ig));
        vm.stopBroadcast();
        require(guard.owner() == owner && guard.isRunner(runner), "owner or runner not set");
        require(address(planner.GUARD()) == address(guard), "the Planner plans for another Guard");
    }

    /// Every address the Guard fixes has code on Base, the oracle is the spoke's, each stock pool is Aerodrome's own
    /// tick-spacing-10 pool with USDC, and JAW's factory still deploys the clone the Guard lets register.
    function checkCode() public view {
        address[12] memory fixed_ = [
            MANAGER,
            SPOKE,
            ORACLE,
            AAVE_V3_POOL,
            USDC,
            AUSDC,
            ROUTER,
            AERODROME_V1_ROUTER,
            UNISWAP_ROUTER,
            PSM3,
            EUR_USD,
            JAW_FACTORY
        ];
        for (uint256 i; i < fixed_.length; ++i) {
            require(fixed_[i].code.length > 0, "an address the Guard fixes has no code");
        }
        address[5] memory coins = [
            0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2, // USDT
            0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34, // USDe
            0x820C137fa70C8691f0e44Dc420a5e53c168921Dc, // USDS
            0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb, // DAI
            0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42 // EURC
        ];
        for (uint256 i; i < coins.length; ++i) {
            require(coins[i].code.length > 0, "a Turn into cash coin has no code");
        }
        require(ISpokeOracle(SPOKE).ORACLE() == ORACLE, "the spoke's oracle moved");
        require(IJawAccountFactory(JAW_FACTORY).getImplementation() == JAW_ACCOUNT, "JAW's factory deploys another account");
        (address[7] memory stocks, address[7] memory pools) = stocksAndPools();
        for (uint256 r; r < 7; ++r) {
            require(stocks[r].code.length > 0, "a stock has no code");
            require(IAeroFactoryLike(AERO_FACTORY).getPool(stocks[r], USDC, 10) == pools[r], "a stock pool moved");
        }
    }

    /// GooseGuard's `_stock(r)` and `_pool(r)`, by Aave reserve id (DeployGuard.t.sol checks they match the Guard's).
    function stocksAndPools() public pure returns (address[7] memory stocks, address[7] memory pools) {
        stocks = [
            0xb200000000000000000000C2e324d24d7eEcd1fb, // AAPLc
            0xb200000000000000000000d9192b6B456483C2E8, // AMZNc
            0xb2000000000000000000002D0BA3164cc74f58B7, // GOOGLc
            0xb2000000000000000000008bC8786B856E61707C, // METAc
            0xB200000000000000000000Ab99cFa739E253872B, // MSFTc
            0xb20000000000000000000078ee7ce2fE4908108C, // NVDAc
            0xb2000000000000000000001e800a7f5189430cD0 // TSLAc
        ];
        pools = [
            0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0,
            0xd03Bc8C7F2FAedCe2aac81bF0444AEA08Ea06E9b,
            0xB1987CAD1682841b4b641d50E520777eC5Ab5542,
            0xEAF57753BC382E0324a1D43F72E7027705a2273E,
            0x7103eB3c9590d1281f7dc03b2A9EE27C39dF5D54,
            0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9,
            0x469337fDcc5E8f38e2E4B670B04F57865D13a7BB
        ];
    }
}
