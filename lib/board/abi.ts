/** Generated: cd contracts && forge inspect src/GooseBoard.sol:GooseBoard abi --json */
export const gooseBoardAbi = [
  {
    type: "function",
    name: "join",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "joinedAt",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "leave",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "listed",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "memberCount",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "members",
    inputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "page",
    inputs: [
      {
        name: "start",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "count",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "accounts",
        type: "address[]",
        internalType: "address[]",
      },
      {
        name: "onBoard",
        type: "bool[]",
        internalType: "bool[]",
      },
      {
        name: "joinedAtBlocks",
        type: "uint256[]",
        internalType: "uint256[]",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "Joined",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "blockNumber",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Left",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
] as const;
