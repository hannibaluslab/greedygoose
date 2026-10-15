// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title GooseBoard
/// @notice GreedyGoose's leaderboard member list (JUSTALAB-DECISIONS.md, "The Leaderboard"). An account joins itself,
/// on its first move in the app: GreedyGoose adds `join()` to that move's batch, so it costs no separate prompt. The
/// app reads the list, then scores each member from the chain (return since joining, percent only). No server and no
/// database (D12): this list is the only thing the board stores.
/// @dev Holds nothing and calls nothing. There is no owner: nobody can add, remove or reorder anyone. Only an account
/// can put itself on the list (`join`) or take itself off (`leave`). Not payable, so it can't receive ETH; it has no
/// token functions, so tokens sent to it by mistake are stuck, as with any contract that isn't built to hold them.
contract GooseBoard {
    /// Every account that ever joined, in the order it first joined. An account appears once; leaving keeps its
    /// place here and clears `listed`, so indexes never move and a reader can page through the list safely.
    address[] public members;

    /// Whether the account is on the board now.
    mapping(address account => bool) public listed;

    /// The block of the account's latest join, 0 if it never joined. Its score counts from the end of this block.
    /// Kept after `leave`: an account that left has joined before, so the app doesn't put it back on its next move.
    mapping(address account => uint256) public joinedAt;

    event Joined(address indexed account, uint256 blockNumber);
    event Left(address indexed account);

    /// Put the caller on the board, from this block. Does nothing when it is already on it, so a batch that carries
    /// `join()` twice (two moves sent before the first lands) still goes through. An account that left joins again
    /// from this block: its score starts over.
    function join() external {
        if (listed[msg.sender]) return;
        if (joinedAt[msg.sender] == 0) members.push(msg.sender);
        listed[msg.sender] = true;
        joinedAt[msg.sender] = block.number;
        emit Joined(msg.sender, block.number);
    }

    /// Take the caller off the board. Not offered in the app yet; it exists so that being on the board is always
    /// the account's own choice.
    function leave() external {
        if (!listed[msg.sender]) return;
        listed[msg.sender] = false;
        emit Left(msg.sender);
    }

    /// How many accounts ever joined (the length of `members`).
    function memberCount() external view returns (uint256) {
        return members.length;
    }

    /// Up to `count` members from index `start`, with whether each is on the board now and the block of its latest
    /// join. Past the end it returns what is there (possibly nothing).
    function page(uint256 start, uint256 count)
        external
        view
        returns (address[] memory accounts, bool[] memory onBoard, uint256[] memory joinedAtBlocks)
    {
        uint256 n = members.length;
        uint256 end = start >= n ? start : (count > n - start ? n : start + count);
        uint256 len = end - start;
        accounts = new address[](len);
        onBoard = new bool[](len);
        joinedAtBlocks = new uint256[](len);
        for (uint256 i; i < len; ++i) {
            address a = members[start + i];
            accounts[i] = a;
            onBoard[i] = listed[a];
            joinedAtBlocks[i] = joinedAt[a];
        }
    }
}
