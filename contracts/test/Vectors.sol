// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Thresholds} from "../src/CashRules.sol";

/// The inputs behind contracts/test/vectors/*.json, drawn exactly as scripts/agent-vectors.ts draws them:
/// uint256(keccak256(abi.encode(tag, i, field))). The JSON carries what the TypeScript reference decided for each.
library Vectors {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant RAY = 1e27;
    uint256 internal constant VALUE_PER_USD = 1e26;
    uint256 internal constant CALENDAR_START = 1_767_225_600; // 2026-01-01T00:00:00Z
    uint256 internal constant CALENDAR_DAYS = 1826;
    /// Where the hash test puts the executor (HASH_SPENDER in the script).
    address internal constant HASH_SPENDER = 0x0000000000000000000000000000000000600dE5;

    struct Protect {
        uint256 collateral;
        uint256 avgCf;
        uint256 debtRay;
        uint256 savings;
        uint256 capLeft;
        bool preFreeze;
        Thresholds t;
        uint256 minRepay;
    }

    struct Save {
        uint256 cash;
        uint256 capLeft;
        uint256 savesToday;
        uint256 keepBack;
        uint256 minSave;
        uint256 maxSavesPerDay;
    }

    struct Hash {
        uint8 job;
        address account;
        uint48 start;
        uint48 end;
        uint256 salt;
        uint160 cap;
    }

    function rand(string memory tag, uint256 i, uint256 field) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(tag, i, field)));
    }

    function between(uint256 r, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return lo + r % (hi - lo + 1);
    }

    function spread(uint256 r1, uint256 r2, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return (1 + r1 % 9) * 10 ** between(r2, lo, hi);
    }

    function protectInput(uint256 i) internal pure returns (Protect memory v) {
        uint256[20] memory r;
        for (uint256 f; f < 20; ++f) {
            r[f] = rand("protect", i, f);
        }
        uint256 trigger = between(r[14], 1.2e18, 2e18);
        uint256 target = between(r[15], trigger + 0.05e18, 2.5e18);
        uint256 drop = between(r[16], 0.05e18, 0.3e18);
        bool shield = r[19] % 4 == 0;
        uint256 stressed = trigger * (WAD - drop) / WAD;
        uint256 floorMin = shield && stressed >= 1.02e18 ? stressed + 1 : 1.02e18;
        uint256 floor = between(r[17], floorMin, trigger);
        uint256 hf = shield ? between(r[4], trigger, floor * WAD / (WAD - drop)) : between(r[4], 0.8e18, 2.6e18);
        v.t = Thresholds(uint64(trigger), uint64(target), uint64(drop), uint64(floor));

        v.collateral = spread(r[0], r[1], 1, 6) * VALUE_PER_USD + r[2] % VALUE_PER_USD;
        v.avgCf = between(r[3], 0.5e18, 0.85e18);
        uint256 debtValue = v.collateral * v.avgCf / WAD * WAD / hf;
        v.debtRay = r[6] % 20 == 0 ? 0 : debtValue * RAY + r[5] % RAY;
        v.savings = r[7] % 10 == 0 ? 0 : spread(r[8], r[9], 5, 11);
        v.capLeft = r[10] % 10 == 0 ? 0 : spread(r[11], r[12], 5, 10);
        v.preFreeze = shield || r[13] % 2 == 1;
        v.minRepay = 50_000 * 10 ** (r[18] % 4);
    }

    function saveInput(uint256 i) internal pure returns (Save memory v) {
        uint256[11] memory r;
        for (uint256 f; f < 11; ++f) {
            r[f] = rand("save", i, f);
        }
        v.keepBack = r[8] % 5_000_001;
        v.cash = r[0] % 5 == 0 ? r[1] % 10_000_000 : v.keepBack + spread(r[2], r[3], 5, 10);
        v.capLeft = r[4] % 8 == 0 ? 0 : spread(r[5], r[6], 5, 10);
        v.savesToday = r[7] % 12;
        v.minSave = 100_000 * 10 ** (r[9] % 4);
        v.maxSavesPerDay = 1 + r[10] % 24;
    }

    /// Odd ones land on a Friday between 15:00 and 03:00 UTC, around both edges of Leo's Friday window.
    function calendarTime(uint256 i) internal pure returns (uint256) {
        if (i % 2 == 0) return CALENDAR_START + rand("calendar", i, 0) % (CALENDAR_DAYS * 1 days);
        uint256 d = CALENDAR_START / 1 days + rand("calendar", i, 1) % CALENDAR_DAYS;
        uint256 friday = d - (d + 6) % 7; // 1970-01-02 (day 1) was a Friday
        return friday * 1 days + 15 hours + rand("calendar", i, 2) % 12 hours;
    }

    function hashInput(uint256 i) internal pure returns (Hash memory v) {
        v.job = uint8(rand("hash", i, 0) % 2);
        v.account = address(uint160(rand("hash", i, 1)));
        v.start = uint48(1_700_000_000 + rand("hash", i, 2) % 300_000_000);
        v.end = v.start + 1 + uint48(rand("hash", i, 3) % 400_000_000);
        v.salt = rand("hash", i, 4);
        v.cap = uint160(1 + rand("hash", i, 5) % 5_000_000);
    }

    /// Bit i of a bitmap packed high bit first.
    function bit(bytes memory bits, uint256 i) internal pure returns (bool) {
        return uint8(bits[i >> 3]) & (0x80 >> (i & 7)) != 0;
    }
}
