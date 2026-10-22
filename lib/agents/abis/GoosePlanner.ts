/** Generated: cd contracts && forge inspect src/GoosePlanner.sol:GoosePlanner abi --json. */
export const plannerAbi = [
  {
    type: "constructor",
    inputs: [
      {
        name: "guard",
        type: "address",
        internalType: "contract IGooseGuard",
      },
      {
        name: "protect",
        type: "address",
        internalType: "contract ProtectPlanner",
      },
      {
        name: "trader",
        type: "address",
        internalType: "contract TradePlanner",
      },
      {
        name: "cash",
        type: "address",
        internalType: "contract CashPlanner",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "CASH",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract CashPlanner",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "CHECK_GAS",
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
    name: "DEPTH_ROOM_BPS",
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
    name: "GUARD",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract IGooseGuard",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "MAX_CANDS",
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
    name: "MAX_FOUND",
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
    name: "MIN_REPAY",
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
    name: "PACK_GAS",
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
    name: "PLAN_GAS",
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
    name: "PLAN_ROOM",
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
    name: "PROTECT",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract ProtectPlanner",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "PROTECT_PCT",
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
    name: "READ_GAS",
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
    name: "READ_RESERVE",
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
    name: "SCAN_PCT",
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
    name: "SKIP_WEEKENDS",
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
    name: "TRADER",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract TradePlanner",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "amounts",
    inputs: [],
    outputs: [
      {
        name: "minRepay",
        type: "uint64",
        internalType: "uint64",
      },
      {
        name: "minSave",
        type: "uint64",
        internalType: "uint64",
      },
      {
        name: "keepBack",
        type: "uint64",
        internalType: "uint64",
      },
      {
        name: "weekendWindow",
        type: "uint32",
        internalType: "uint32",
      },
      {
        name: "maxSavesPerDay",
        type: "uint8",
        internalType: "uint8",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "checkUpkeep",
    inputs: [
      {
        name: "checkData",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
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
    name: "frozen",
    inputs: [
      {
        name: "ts",
        type: "uint256",
        internalType: "uint256",
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
    name: "movesOf",
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
        type: "tuple[]",
        internalType: "struct PlanBase.Move[]",
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
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nextFreeze",
    inputs: [
      {
        name: "ts",
        type: "uint256",
        internalType: "uint256",
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
    name: "nextOpen",
    inputs: [
      {
        name: "ts",
        type: "uint256",
        internalType: "uint256",
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
    name: "nextTradeAt",
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
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "planAccount",
    inputs: [
      {
        name: "a",
        type: "address",
        internalType: "address",
      },
      {
        name: "round",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "moves",
        type: "tuple[]",
        internalType: "struct PlanBase.Move[]",
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
    stateMutability: "view",
  },
  {
    type: "function",
    name: "planOf",
    inputs: [
      {
        name: "a",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "p",
        type: "tuple",
        internalType: "struct GoosePlanner.Plan",
        components: [
          {
            name: "action",
            type: "uint8",
            internalType: "enum GoosePlanner.Action",
          },
          {
            name: "job",
            type: "uint8",
            internalType: "enum GoosePlanner.Job",
          },
          {
            name: "amount",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "hf",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "reason",
            type: "uint8",
            internalType: "uint8",
          },
          {
            name: "off",
            type: "uint8",
            internalType: "enum GoosePlanner.OffReason",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "pool",
    inputs: [
      {
        name: "r",
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
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "poolPrice",
    inputs: [
      {
        name: "r",
        type: "uint256",
        internalType: "uint256",
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
    name: "probe",
    inputs: [
      {
        name: "n",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "gasAtEntry",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "filler",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "protectCheck",
    inputs: [
      {
        name: "a",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "need",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "hf",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "protectOf",
    inputs: [
      {
        name: "a",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "lineWad",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "targetWad",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "rebalanceLimits",
    inputs: [],
    outputs: [
      {
        name: "bandBps",
        type: "uint16",
        internalType: "uint16",
      },
      {
        name: "bandMaxBps",
        type: "uint16",
        internalType: "uint16",
      },
      {
        name: "poolGapBps",
        type: "uint16",
        internalType: "uint16",
      },
      {
        name: "floorBps",
        type: "uint16",
        internalType: "uint16",
      },
      {
        name: "minTrade",
        type: "uint64",
        internalType: "uint64",
      },
      {
        name: "maxSlice",
        type: "uint64",
        internalType: "uint64",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "rescuingOf",
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
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "scanOf",
    inputs: [
      {
        name: "round",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "shard",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "shards",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "start",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "scanned",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "cands",
        type: "address[]",
        internalType: "address[]",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "scanStart",
    inputs: [
      {
        name: "pass",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "size",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "first",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "stock",
    inputs: [
      {
        name: "r",
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
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "stockDepth",
    inputs: [
      {
        name: "r",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "price",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "buy",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "floorBps",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "enough",
        type: "uint256",
        internalType: "uint256",
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
    name: "thresholds",
    inputs: [],
    outputs: [
      {
        name: "triggerHf",
        type: "uint64",
        internalType: "uint64",
      },
      {
        name: "targetHf",
        type: "uint64",
        internalType: "uint64",
      },
      {
        name: "stressDrop",
        type: "uint64",
        internalType: "uint64",
      },
      {
        name: "stressFloorHf",
        type: "uint64",
        internalType: "uint64",
      },
    ],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "topUpsReady",
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
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
] as const;
