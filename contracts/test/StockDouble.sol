// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Plain ERC-20 stand-in for a Coinbase B20 stock token on a Foundry fork.
/// B20 tokens are native to Base (their deployed code is the single byte 0xef), so Foundry's EVM can't run them;
/// ForkBase etches this at the token's address. Same decimals (8) as every supported stock.
contract StockDouble {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (from != msg.sender) allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
