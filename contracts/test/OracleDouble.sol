// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Stand-in for Aave's spoke oracle on a local fork, so scripts/board-e2e.ts can move a stock's price after members
/// join and check the board's percentages. Test-only: never deployed anywhere but anvil.
contract OracleDouble {
    mapping(uint256 reserveId => uint256) public prices;

    function getReservePrice(uint256 reserveId) external view returns (uint256) {
        return prices[reserveId];
    }

    function setReservePrice(uint256 reserveId, uint256 price) external {
        prices[reserveId] = price;
    }
}
