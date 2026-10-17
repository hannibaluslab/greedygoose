// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Stand-in for a Coinbase B20 stock on the rehearsal fork only (scripts/rehearsal, a local anvil fork of Base).
/// B20 tokens are native to Base (their code is the single byte 0xef), so anvil can't run them. `setup.ts` puts this
/// code at each stock's own address with anvil_setCode, then writes the balances the Aave hub and the stock pools hold
/// on Base, and the stock's real `uiMultiplier`, with anvil_setStorageAt. It is never deployed: it has no constructor.
///
/// Everything lives under one namespaced slot (ERC-7201 style), so nothing a B20 token keeps at the address can
/// collide with it: balanceOf[holder] at keccak256(abi.encode(holder, SLOT)), allowance at SLOT + 1, uiMultiplier at
/// SLOT + 2. Same decimals (8) as every supported stock, and the same Transfer and Approval events as an ERC-20.
contract RehearsalStock {
    struct Layout {
        mapping(address => uint256) balanceOf;
        mapping(address => mapping(address => uint256)) allowance;
        uint256 uiMultiplier;
    }

    /// keccak256("greedygoose.rehearsal.stock")
    bytes32 internal constant SLOT = keccak256("greedygoose.rehearsal.stock");

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function _l() internal pure returns (Layout storage l) {
        bytes32 s = SLOT;
        assembly {
            l.slot := s
        }
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function balanceOf(address holder) external view returns (uint256) {
        return _l().balanceOf[holder];
    }

    function allowance(address holder, address spender) external view returns (uint256) {
        return _l().allowance[holder][spender];
    }

    /// B20: shares shown to users = raw × uiMultiplier / 1e18. Set by setup.ts to the stock's value on Base.
    function uiMultiplier() external view returns (uint256) {
        return _l().uiMultiplier;
    }

    function balanceOfUI(address holder) external view returns (uint256) {
        Layout storage l = _l();
        return l.balanceOf[holder] * l.uiMultiplier / 1e18;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _l().allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        Layout storage l = _l();
        if (from != msg.sender) {
            uint256 allowed = l.allowance[from][msg.sender];
            if (allowed != type(uint256).max) l.allowance[from][msg.sender] = allowed - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        Layout storage l = _l();
        l.balanceOf[from] -= amount;
        l.balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
