// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJustaPermissionManager as PM} from "../../src/IJustaPermissionManager.sol";
import {IAeroRouter, IUniswapRouter} from "../../src/IProtocols.sol";

// A small working Base for GooseGuard, etched at the real addresses: tokens that move, a manager that checks the
// permission and runs the account's batch, an Aave V4 spoke with health, Aave V3 savings, pools and routers that fill.
// Offline stand-ins only: no rounding, fees, B20 policies or spend limits of the real contracts.

address constant MANAGER = 0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8;
address constant SPOKE = 0x17905Db0e4A3514467539956c084180616AE7B8D;
address constant ORACLE = 0xaBaf048fD7675Ea34a84332371ffd5D55E322A47;
address constant V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
address constant AUSDC = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB;
address constant ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
address constant AERO_V1 = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;
address constant UNI = 0x2626664c2603336E57B271c5C0b26F421741e481;
address constant PSM3 = 0x1601843c5E9bC251A3272907010AFa41Fa18347E;
address constant EUR_USD = 0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F;
address constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
address constant USDE = 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34;
address constant USDS = 0x820C137fa70C8691f0e44Dc420a5e53c168921Dc;
address constant DAI = 0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb;
address constant EURC = 0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42;

function stockOf(uint256 r) pure returns (address) {
    if (r == 0) return 0xb200000000000000000000C2e324d24d7eEcd1fb;
    if (r == 1) return 0xb200000000000000000000d9192b6B456483C2E8;
    if (r == 2) return 0xb2000000000000000000002D0BA3164cc74f58B7;
    if (r == 3) return 0xb2000000000000000000008bC8786B856E61707C;
    if (r == 4) return 0xB200000000000000000000Ab99cFa739E253872B;
    if (r == 5) return 0xb20000000000000000000078ee7ce2fE4908108C;
    return 0xb2000000000000000000001e800a7f5189430cD0;
}

function poolOf(uint256 r) pure returns (address) {
    if (r == 0) return 0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0;
    if (r == 1) return 0xd03Bc8C7F2FAedCe2aac81bF0444AEA08Ea06E9b;
    if (r == 2) return 0xB1987CAD1682841b4b641d50E520777eC5Ab5542;
    if (r == 3) return 0xEAF57753BC382E0324a1D43F72E7027705a2273E;
    if (r == 4) return 0x7103eB3c9590d1281f7dc03b2A9EE27C39dF5D54;
    if (r == 5) return 0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9;
    return 0x469337fDcc5E8f38e2E4B670B04F57865D13a7BB;
}

function coinOf(uint256 k) pure returns (address) {
    if (k == 0) return USDT;
    if (k == 1) return USDE;
    if (k == 2) return USDS;
    if (k == 3) return DAI;
    return EURC;
}

interface IMint {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
}

contract WToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        allowance[f][msg.sender] -= v;
        balanceOf[f] -= v;
        balanceOf[to] += v;
        return true;
    }

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
    }

    function burn(address f, uint256 v) external {
        balanceOf[f] -= v;
    }
}

contract WOracle {
    mapping(uint256 => uint256) public getReservePrice;

    function set(uint256 r, uint256 p) external {
        getReservePrice[r] = p;
    }
}

contract WPool {
    uint160 public sqrtP;

    function set(uint160 s) external {
        sqrtP = s;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, bool) {
        return (sqrtP, 0, 0, 0, 0, true);
    }
}

contract WFeed {
    int256 public answer;

    function set(int256 a) external {
        answer = a;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, 0, block.timestamp, 1);
    }
}

/// Aave V4's spoke, reduced: supplied stock per reserve, one USDC debt, health on Aave's prices and fixed factors.
contract WSpoke {
    struct UserAccountData {
        uint256 riskPremium;
        uint256 avgCollateralFactor;
        uint256 healthFactor;
        uint256 totalCollateralValue;
        uint256 totalDebtValueRay;
        uint256 activeCollateralCount;
        uint256 borrowCount;
    }

    mapping(uint256 => mapping(address => uint256)) public supplied;
    mapping(address => uint256) public debt;
    mapping(uint256 => uint256) public cf; // BPS
    /// A collateral-factor rise Aave applies to an account only when it refreshes (bps added).
    mapping(address => uint256) public pendingBoost;
    mapping(address => uint256) public boost;

    function setCf(uint256 r, uint256 v) external {
        cf[r] = v;
    }

    function setPosition(address a, uint256 r, uint256 shares) external {
        supplied[r][a] = shares;
    }

    function setDebt(address a, uint256 d) external {
        debt[a] = d;
    }

    function setPendingBoost(address a, uint256 b) external {
        pendingBoost[a] = b;
    }

    function getUserTotalDebt(uint256, address a) external view returns (uint256) {
        return debt[a];
    }

    function getUserReserveStatus(uint256 r, address a) external view returns (bool, bool) {
        return (supplied[r][a] > 0, false);
    }

    function hfOf(address a) public view returns (uint256) {
        if (debt[a] == 0) return type(uint256).max;
        uint256 adj;
        for (uint256 r; r < 7; ++r) {
            adj += supplied[r][a] * WOracle(ORACLE).getReservePrice(r) * (cf[r] + boost[a]);
        }
        return adj * 1e4 / debt[a];
    }

    function getUserAccountData(address a) external view returns (UserAccountData memory d) {
        uint256 value;
        uint256 weighted;
        for (uint256 r; r < 7; ++r) {
            uint256 v = supplied[r][a] * WOracle(ORACLE).getReservePrice(r);
            value += v;
            weighted += v * (cf[r] + boost[a]);
        }
        d.totalCollateralValue = value * 1e10;
        d.avgCollateralFactor = value == 0 ? 0 : weighted * 1e14 / value;
        d.healthFactor = hfOf(a);
    }

    function repay(uint256, uint256 amount, address onBehalfOf) external returns (uint256, uint256) {
        uint256 pay = amount < debt[onBehalfOf] ? amount : debt[onBehalfOf];
        IMint(USDC).transferFrom(msg.sender, address(this), pay);
        debt[onBehalfOf] -= pay;
        return (pay, pay);
    }

    function withdraw(uint256 r, uint256 amount, address onBehalfOf) external returns (uint256, uint256) {
        require(msg.sender == onBehalfOf, "not user");
        uint256 have = supplied[r][onBehalfOf];
        uint256 w = amount < have ? amount : have;
        supplied[r][onBehalfOf] = have - w;
        IMint(stockOf(r)).mint(msg.sender, w);
        // Aave refreshes the position's config on withdraw.
        boost[onBehalfOf] = pendingBoost[onBehalfOf];
        require(hfOf(onBehalfOf) >= 1e18, "health");
        return (w, w);
    }

    function updateUserDynamicConfig(address a) external {
        require(msg.sender == a, "not user");
        boost[a] = pendingBoost[a];
    }
}

contract WV3Pool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        require(asset == USDC);
        IMint(USDC).transferFrom(msg.sender, address(this), amount);
        IMint(AUSDC).mint(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        require(asset == USDC);
        uint256 have = IMint(AUSDC).balanceOf(msg.sender);
        uint256 w = amount < have ? amount : have;
        IMint(AUSDC).burn(msg.sender, w);
        IMint(USDC).mint(to, w);
        return w;
    }
}

/// Every fill a router made, for the floor invariant.
struct Fill {
    address tokenIn;
    address tokenOut;
    uint256 amountIn;
    uint256 amountOut;
    address recipient;
}

/// Fills at Aave's price (mode 0) or at exactly the minimum asked (mode 1, the worst a pool may give).
contract WAeroRouter {
    uint256 public mode;
    Fill[] internal fills;

    function setMode(uint256 m) external {
        mode = m;
    }

    function fillsLength() external view returns (uint256) {
        return fills.length;
    }

    function fillAt(uint256 i) external view returns (Fill memory) {
        return fills[i];
    }

    function _fair(address tin, address tout, uint256 amountIn) internal view returns (uint256) {
        for (uint256 r; r < 7; ++r) {
            uint256 p = WOracle(ORACLE).getReservePrice(r);
            if (tin == stockOf(r) && tout == USDC) return amountIn * p / 1e10;
            if (tin == USDC && tout == stockOf(r)) return amountIn * 1e10 / p;
        }
        if (tin == EURC) return amountIn * uint256(WFeed(EUR_USD).answer()) / 1e8;
        return amountIn; // USDT: 6 decimals, 1:1
    }

    function exactInputSingle(IAeroRouter.ExactInputSingleParams calldata s) external payable returns (uint256 out) {
        IMint(s.tokenIn).transferFrom(msg.sender, address(this), s.amountIn);
        out = mode == 1 ? s.amountOutMinimum : _fair(s.tokenIn, s.tokenOut, s.amountIn);
        require(out >= s.amountOutMinimum, "Too little received");
        IMint(s.tokenOut).mint(s.recipient, out);
        fills.push(Fill(s.tokenIn, s.tokenOut, s.amountIn, out, s.recipient));
    }
}

contract WUniRouter {
    uint256 public mode;

    function setMode(uint256 m) external {
        mode = m;
    }

    function exactInputSingle(IUniswapRouter.ExactInputSingleParams calldata s) external payable returns (uint256 out) {
        IMint(s.tokenIn).transferFrom(msg.sender, address(this), s.amountIn);
        out = mode == 1 ? s.amountOutMinimum : s.amountIn / 1e12;
        require(out >= s.amountOutMinimum, "Too little received");
        IMint(s.tokenOut).mint(s.recipient, out);
    }
}

contract WPsm3 {
    uint256 public mode;

    function setMode(uint256 m) external {
        mode = m;
    }

    function swapExactIn(address tin, address tout, uint256 amountIn, uint256 minOut, address receiver, uint256)
        external
        returns (uint256 out)
    {
        IMint(tin).transferFrom(msg.sender, address(this), amountIn);
        out = mode == 1 ? minOut : amountIn / 1e12;
        require(out >= minOut, "PSM3/amountOut-too-low");
        IMint(tout).mint(receiver, out);
    }
}

/// JAW's manager, reduced: a permission runs only once its account approved it, while not revoked, inside its window,
/// and only for its spender. Call lists and spend limits are not modelled.
contract WManager {
    mapping(bytes32 => bool) public approvedHash;
    mapping(bytes32 => bool) public revokedHash;

    function _h(PM.Permission calldata p) internal pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }

    function approve(PM.Permission calldata p) external returns (bool) {
        require(msg.sender == p.account, "not account");
        approvedHash[_h(p)] = true;
        return true;
    }

    function revoke(PM.Permission calldata p) external {
        require(msg.sender == p.account, "not account");
        revokedHash[_h(p)] = true;
    }

    function isApproved(PM.Permission calldata p) external view returns (bool) {
        return approvedHash[_h(p)];
    }

    function isRevoked(PM.Permission calldata p) external view returns (bool) {
        return revokedHash[_h(p)];
    }

    function executeBatch(PM.Permission calldata p, PM.Call[] calldata calls) external {
        bytes32 h = _h(p);
        require(approvedHash[h] && !revokedHash[h], "not approved");
        require(msg.sender == p.spender, "not spender");
        require(block.timestamp >= p.start && block.timestamp <= p.end, "window");
        WAccount(payable(p.account)).executeBatch(calls);
    }
}

/// A JAW account, reduced: it runs the manager's batch as itself, wrapping a failed call in ExecuteError.
contract WAccount {
    error ExecuteError(uint256 index, bytes reason);

    receive() external payable {}

    function isOwnerAddress(address) external pure returns (bool) {
        return true;
    }

    function executeBatch(PM.Call[] calldata calls) external {
        require(msg.sender == MANAGER, "not manager");
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory r) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert ExecuteError(i, r);
        }
    }

    /// The test acting as the account's owner.
    function exec(address t, bytes calldata d) external returns (bytes memory) {
        (bool ok, bytes memory r) = t.call(d);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(r, 0x20), mload(r))
            }
        }
        return r;
    }
}
