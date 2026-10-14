// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// A fixed price, for the rehearsal fork only (scripts/rehearsal/price-shock.ts). The spoke's oracle prices a stock
/// with `latestAnswer()` on the reserve's source (`getReserveSource(reserveId)`, a Chainlink proxy). price-shock puts
/// this code at that source's address with anvil_setCode and writes the price (8 decimals, USD) at ANSWER with
/// anvil_setStorageAt; `--reset` puts the proxy's own code back. Never deployed: it has no constructor.
contract RehearsalFeed {
    /// keccak256("greedygoose.rehearsal.feed.answer")
    bytes32 internal constant ANSWER = keccak256("greedygoose.rehearsal.feed.answer");

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestAnswer() public view returns (int256 answer) {
        bytes32 s = ANSWER;
        assembly {
            answer := sload(s)
        }
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (1, latestAnswer(), block.timestamp, block.timestamp, 1);
    }

    function latestTimestamp() external view returns (uint256) {
        return block.timestamp;
    }
}
