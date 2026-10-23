/** Generated: cd contracts && forge inspect src/GooseGuard.sol:GooseGuard abi --json. */
export const guardAbi = [
  {
    type: "constructor",
    inputs: [
      {
        name: "owner_",
        type: "address",
        internalType: "address",
      },
      {
        name: "runner",
        type: "address",
        internalType: "address",
      },
      {
        name: "cloneCodehash",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "saleFloorBps",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "swapFloorBps",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "bandBps",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "keepBack",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "dust",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "BAND_BPS",
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
    name: "DUST",
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
    name: "KEEP_BACK",
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
    name: "SALE_FLOOR_BPS",
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
    name: "SWAP_FLOOR_BPS",
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
    name: "TIGHT_BPS",
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
    name: "accountOf",
    inputs: [
      {
        name: "a",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct GooseGuard.Account",
        components: [
          {
            name: "index",
            type: "uint24",
            internalType: "uint24",
          },
          {
            name: "jobs",
            type: "uint8",
            internalType: "uint8",
          },
          {
            name: "rescueAt",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "sessionAt",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "runner",
            type: "address",
            internalType: "address",
          },
        ],
      },
      {
        name: "",
        type: "tuple",
        internalType: "struct GooseGuard.Settings",
        components: [
          {
            name: "mix",
            type: "uint112",
            internalType: "uint112",
          },
          {
            name: "line",
            type: "uint16",
            internalType: "uint16",
          },
          {
            name: "target",
            type: "uint16",
            internalType: "uint16",
          },
          {
            name: "mixSetAt",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "keepMix",
            type: "bool",
            internalType: "bool",
          },
          {
            name: "topUpsOn",
            type: "bool",
            internalType: "bool",
          },
          {
            name: "keep",
            type: "uint48",
            internalType: "uint48",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "applyChange",
    inputs: [
      {
        name: "kind",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "arg",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "cancelChange",
    inputs: [
      {
        name: "id",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "capOf",
    inputs: [
      {
        name: "kind",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "args",
        type: "uint256[]",
        internalType: "uint256[]",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "codehashOk",
    inputs: [
      {
        name: "codehash",
        type: "bytes32",
        internalType: "bytes32",
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
    name: "endRescue",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "epoch",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint32",
        internalType: "uint32",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isRunner",
    inputs: [
      {
        name: "runner",
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
    name: "linesOf",
    inputs: [
      {
        name: "a",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "line",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "target",
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
    name: "membersLength",
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
    name: "owner",
    inputs: [],
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
    name: "pause",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "paused",
    inputs: [],
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
    name: "performUpkeep",
    inputs: [
      {
        name: "performData",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "permissionOf",
    inputs: [
      {
        name: "a",
        type: "address",
        internalType: "address",
      },
      {
        name: "job",
        type: "uint8",
        internalType: "uint8",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "protectMembers",
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
    name: "protectMembersLength",
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
    name: "queueChange",
    inputs: [
      {
        name: "kind",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "arg",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "id",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "queued",
    inputs: [
      {
        name: "id",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "eta",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "register",
    inputs: [
      {
        name: "job",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "permission",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "removeRunner",
    inputs: [
      {
        name: "runner",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "run",
    inputs: [
      {
        name: "m",
        type: "tuple",
        internalType: "struct GooseGuard.Move",
        components: [
          {
            name: "account",
            type: "address",
            internalType: "address",
          },
          {
            name: "kind",
            type: "uint8",
            internalType: "uint8",
          },
          {
            name: "args",
            type: "uint256[]",
            internalType: "uint256[]",
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "runners",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint32",
        internalType: "uint32",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "sellLineOf",
    inputs: [
      {
        name: "a",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "line",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "setKeepMix",
    inputs: [
      {
        name: "on",
        type: "bool",
        internalType: "bool",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setMix",
    inputs: [
      {
        name: "mix",
        type: "uint112",
        internalType: "uint112",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setProtect",
    inputs: [
      {
        name: "line",
        type: "uint16",
        internalType: "uint16",
      },
      {
        name: "target",
        type: "uint16",
        internalType: "uint16",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setRunner",
    inputs: [
      {
        name: "runner",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setTopUps",
    inputs: [
      {
        name: "on",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "keep",
        type: "uint48",
        internalType: "uint48",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "unpause",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "unregister",
    inputs: [
      {
        name: "job",
        type: "uint8",
        internalType: "uint8",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "ChangeApplied",
    inputs: [
      {
        name: "id",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "kind",
        type: "uint8",
        indexed: false,
        internalType: "uint8",
      },
      {
        name: "arg",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ChangeCancelled",
    inputs: [
      {
        name: "id",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ChangeQueued",
    inputs: [
      {
        name: "id",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "kind",
        type: "uint8",
        indexed: false,
        internalType: "uint8",
      },
      {
        name: "arg",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
      },
      {
        name: "eta",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ConfigRefreshed",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "hfBefore",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "hfAfter",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "EntryConverted",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "coin",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amountIn",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "usdcOut",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "JobOff",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "job",
        type: "uint8",
        indexed: true,
        internalType: "uint8",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "JobOn",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "job",
        type: "uint8",
        indexed: true,
        internalType: "uint8",
      },
      {
        name: "start",
        type: "uint48",
        indexed: false,
        internalType: "uint48",
      },
      {
        name: "end",
        type: "uint48",
        indexed: false,
        internalType: "uint48",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "KeepMixSet",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "on",
        type: "bool",
        indexed: false,
        internalType: "bool",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "MixSet",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "mix",
        type: "uint112",
        indexed: false,
        internalType: "uint112",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Paused",
    inputs: [
      {
        name: "on",
        type: "bool",
        indexed: false,
        internalType: "bool",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ProtectRepaid",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "fromWallet",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "fromSavings",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "hfBefore",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "hfAfter",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ProtectSet",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "line",
        type: "uint16",
        indexed: false,
        internalType: "uint16",
      },
      {
        name: "target",
        type: "uint16",
        indexed: false,
        internalType: "uint16",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ProtectSold",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "shares",
        type: "uint256[7]",
        indexed: false,
        internalType: "uint256[7]",
      },
      {
        name: "repaid",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "hfBefore",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "hfAfter",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Rebalanced",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "sold",
        type: "uint256[7]",
        indexed: false,
        internalType: "uint256[7]",
      },
      {
        name: "bought",
        type: "uint256[7]",
        indexed: false,
        internalType: "uint256[7]",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Refused",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "kind",
        type: "uint8",
        indexed: true,
        internalType: "uint8",
      },
      {
        name: "reason",
        type: "bytes4",
        indexed: false,
        internalType: "bytes4",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "RescueEnded",
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
  {
    type: "event",
    name: "RunnerRemoved",
    inputs: [
      {
        name: "runner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "RunnerSet",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "runner",
        type: "address",
        indexed: false,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Saved",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "TopUpInvested",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "bought",
        type: "uint256[7]",
        indexed: false,
        internalType: "uint256[7]",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "TopUpsSet",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "on",
        type: "bool",
        indexed: false,
        internalType: "bool",
      },
      {
        name: "keep",
        type: "uint48",
        indexed: false,
        internalType: "uint48",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "AlreadyQueued",
    inputs: [],
  },
  {
    type: "error",
    name: "BadArgs",
    inputs: [],
  },
  {
    type: "error",
    name: "BadChange",
    inputs: [],
  },
  {
    type: "error",
    name: "BadJob",
    inputs: [],
  },
  {
    type: "error",
    name: "BadKind",
    inputs: [],
  },
  {
    type: "error",
    name: "BadLines",
    inputs: [],
  },
  {
    type: "error",
    name: "BadMix",
    inputs: [],
  },
  {
    type: "error",
    name: "BelowFloor",
    inputs: [],
  },
  {
    type: "error",
    name: "CashLower",
    inputs: [],
  },
  {
    type: "error",
    name: "CashOut",
    inputs: [],
  },
  {
    type: "error",
    name: "ChangeExpired",
    inputs: [],
  },
  {
    type: "error",
    name: "CodeNotAllowed",
    inputs: [],
  },
  {
    type: "error",
    name: "Crossed",
    inputs: [],
  },
  {
    type: "error",
    name: "DebtNotLower",
    inputs: [],
  },
  {
    type: "error",
    name: "Expired",
    inputs: [],
  },
  {
    type: "error",
    name: "FutureStart",
    inputs: [],
  },
  {
    type: "error",
    name: "HealthLower",
    inputs: [],
  },
  {
    type: "error",
    name: "HealthTooLow",
    inputs: [],
  },
  {
    type: "error",
    name: "IsPaused",
    inputs: [],
  },
  {
    type: "error",
    name: "LastRunner",
    inputs: [],
  },
  {
    type: "error",
    name: "NoGain",
    inputs: [],
  },
  {
    type: "error",
    name: "NoGas",
    inputs: [],
  },
  {
    type: "error",
    name: "NoGrant",
    inputs: [],
  },
  {
    type: "error",
    name: "NoMix",
    inputs: [],
  },
  {
    type: "error",
    name: "NoPrice",
    inputs: [],
  },
  {
    type: "error",
    name: "NotAccount",
    inputs: [],
  },
  {
    type: "error",
    name: "NotApproved",
    inputs: [],
  },
  {
    type: "error",
    name: "NotCollateral",
    inputs: [],
  },
  {
    type: "error",
    name: "NotInMix",
    inputs: [],
  },
  {
    type: "error",
    name: "NotManaged",
    inputs: [],
  },
  {
    type: "error",
    name: "NotNeeded",
    inputs: [],
  },
  {
    type: "error",
    name: "NotNewOwner",
    inputs: [],
  },
  {
    type: "error",
    name: "NotOwner",
    inputs: [],
  },
  {
    type: "error",
    name: "NotQueued",
    inputs: [],
  },
  {
    type: "error",
    name: "NotRunner",
    inputs: [],
  },
  {
    type: "error",
    name: "NotSpender",
    inputs: [],
  },
  {
    type: "error",
    name: "NotTopUp",
    inputs: [],
  },
  {
    type: "error",
    name: "NothingOwed",
    inputs: [],
  },
  {
    type: "error",
    name: "NothingToMove",
    inputs: [],
  },
  {
    type: "error",
    name: "OffBand",
    inputs: [],
  },
  {
    type: "error",
    name: "OnlySelf",
    inputs: [],
  },
  {
    type: "error",
    name: "OppositeQueued",
    inputs: [],
  },
  {
    type: "error",
    name: "OutOfBounds",
    inputs: [],
  },
  {
    type: "error",
    name: "Overshoot",
    inputs: [],
  },
  {
    type: "error",
    name: "Paced",
    inputs: [],
  },
  {
    type: "error",
    name: "PaidOff",
    inputs: [],
  },
  {
    type: "error",
    name: "Reentered",
    inputs: [],
  },
  {
    type: "error",
    name: "RescueOn",
    inputs: [],
  },
  {
    type: "error",
    name: "SellsToCash",
    inputs: [],
  },
  {
    type: "error",
    name: "StaleFeed",
    inputs: [],
  },
  {
    type: "error",
    name: "StaleGrant",
    inputs: [],
  },
  {
    type: "error",
    name: "StockMoved",
    inputs: [],
  },
  {
    type: "error",
    name: "TooEarly",
    inputs: [
      {
        name: "eta",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "TooLong",
    inputs: [],
  },
  {
    type: "error",
    name: "TooManyMembers",
    inputs: [],
  },
  {
    type: "error",
    name: "TooMuch",
    inputs: [],
  },
] as const;
