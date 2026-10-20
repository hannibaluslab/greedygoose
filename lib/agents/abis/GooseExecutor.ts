/** Generated: cd contracts && forge inspect src/GooseExecutor.sol:GooseExecutor abi --json. */
export const gooseExecutorAbi = [
  {
    type: "constructor",
    inputs: [
      {
        name: "c",
        type: "tuple",
        internalType: "struct GooseExecutor.Config",
        components: [
          {
            name: "manager",
            type: "address",
            internalType: "contract IJustaPermissionManager",
          },
          {
            name: "aaveV3Pool",
            type: "address",
            internalType: "contract IAaveV3Pool",
          },
          {
            name: "spoke",
            type: "address",
            internalType: "contract ISpoke",
          },
          {
            name: "usdc",
            type: "address",
            internalType: "contract IERC20",
          },
          {
            name: "aUsdc",
            type: "address",
            internalType: "contract IERC20",
          },
          {
            name: "usdcReserveId",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "oracle",
            type: "address",
            internalType: "contract IAaveOracle",
          },
          {
            name: "router",
            type: "address",
            internalType: "address",
          },
          {
            name: "stocks",
            type: "address[7]",
            internalType: "address[7]",
          },
          {
            name: "capMax",
            type: "uint160",
            internalType: "uint160",
          },
          {
            name: "pageSize",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "owner",
            type: "address",
            internalType: "address",
          },
          {
            name: "codehashes",
            type: "bytes32[]",
            internalType: "bytes32[]",
          },
          {
            name: "thresholds",
            type: "tuple",
            internalType: "struct Thresholds",
            components: [
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
          },
          {
            name: "amounts",
            type: "tuple",
            internalType: "struct Amounts",
            components: [
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
          },
          {
            name: "sellLimits",
            type: "tuple",
            internalType: "struct SellLimits",
            components: [
              {
                name: "floorBps",
                type: "uint16",
                internalType: "uint16",
              },
              {
                name: "poolCap",
                type: "uint64",
                internalType: "uint64",
              },
              {
                name: "maxSlice",
                type: "uint64",
                internalType: "uint64",
              },
            ],
          },
          {
            name: "rebalanceLimits",
            type: "tuple",
            internalType: "struct RebalanceLimits",
            components: [
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
          },
          {
            name: "entryLimits",
            type: "tuple",
            internalType: "struct EntryLimits",
            components: [
              {
                name: "floorBps",
                type: "uint16",
                internalType: "uint16",
              },
              {
                name: "minEntry",
                type: "uint64",
                internalType: "uint64",
              },
              {
                name: "maxSwap",
                type: "uint64",
                internalType: "uint64",
              },
            ],
          },
        ],
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "AAVE_V3_POOL",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract IAaveV3Pool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "ACCOUNT_GAS",
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
    name: "AUSDC",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract IERC20",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "CAP_MAX",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint160",
        internalType: "uint160",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "DELAY",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint48",
        internalType: "uint48",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "MANAGER",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract IJustaPermissionManager",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "MAX_WORK",
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
    name: "ORACLE",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract IAaveOracle",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "PAGE_SIZE",
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
    name: "ROUTER",
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
    name: "SPOKE",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract ISpoke",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "USDC",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract IERC20",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "USDC_RESERVE_ID",
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
    name: "accounts",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "jobs",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "index",
        type: "uint32",
        internalType: "uint32",
      },
      {
        name: "fails",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "cooldownUntil",
        type: "uint48",
        internalType: "uint48",
      },
      {
        name: "savesDay",
        type: "uint32",
        internalType: "uint32",
      },
      {
        name: "savesToday",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "rescueAt",
        type: "uint48",
        internalType: "uint48",
      },
      {
        name: "keepMix",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "rebalanceDay",
        type: "uint32",
        internalType: "uint32",
      },
      {
        name: "protectIndex",
        type: "uint32",
        internalType: "uint32",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "allowedCodehash",
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
    name: "applyChange",
    inputs: [
      {
        name: "kind",
        type: "uint8",
        internalType: "enum GooseExecutor.Change",
      },
      {
        name: "value",
        type: "bytes",
        internalType: "bytes",
      },
      {
        name: "nonce",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "bootstrap",
    inputs: [
      {
        name: "forwarders",
        type: "address[]",
        internalType: "address[]",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "bootstrapped",
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
    name: "changeNonce",
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
    name: "checkProtect",
    inputs: [
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
        name: "upkeepNeeded",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "performData",
        type: "bytes",
        internalType: "bytes",
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
        name: "upkeepNeeded",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "performData",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "disallowCodehash",
    inputs: [
      {
        name: "codehash",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "entryLimits",
    inputs: [],
    outputs: [
      {
        name: "floorBps",
        type: "uint16",
        internalType: "uint16",
      },
      {
        name: "minEntry",
        type: "uint64",
        internalType: "uint64",
      },
      {
        name: "maxSwap",
        type: "uint64",
        internalType: "uint64",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "entryWaits",
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
    name: "holiday",
    inputs: [
      {
        name: "day",
        type: "uint32",
        internalType: "uint32",
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
    name: "isForwarder",
    inputs: [
      {
        name: "",
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
    name: "mixes",
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
        name: "account",
        type: "address",
        internalType: "address",
      },
      {
        name: "job",
        type: "uint8",
        internalType: "enum GooseExecutor.Job",
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct IJustaPermissionManager.Permission",
        components: [
          {
            name: "account",
            type: "address",
            internalType: "address",
          },
          {
            name: "spender",
            type: "address",
            internalType: "address",
          },
          {
            name: "start",
            type: "uint48",
            internalType: "uint48",
          },
          {
            name: "end",
            type: "uint48",
            internalType: "uint48",
          },
          {
            name: "salt",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "calls",
            type: "tuple[]",
            internalType: "struct IJustaPermissionManager.CallPermission[]",
            components: [
              {
                name: "target",
                type: "address",
                internalType: "address",
              },
              {
                name: "selector",
                type: "bytes4",
                internalType: "bytes4",
              },
              {
                name: "checker",
                type: "address",
                internalType: "address",
              },
            ],
          },
          {
            name: "spends",
            type: "tuple[]",
            internalType: "struct IJustaPermissionManager.SpendLimit[]",
            components: [
              {
                name: "token",
                type: "address",
                internalType: "address",
              },
              {
                name: "allowance",
                type: "uint160",
                internalType: "uint160",
              },
              {
                name: "unit",
                type: "uint8",
                internalType: "enum IJustaPermissionManager.PeriodUnit",
              },
              {
                name: "multiplier",
                type: "uint16",
                internalType: "uint16",
              },
            ],
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
        name: "account",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "p",
        type: "tuple",
        internalType: "struct GooseExecutor.Plan",
        components: [
          {
            name: "action",
            type: "uint8",
            internalType: "enum GooseExecutor.Action",
          },
          {
            name: "job",
            type: "uint8",
            internalType: "enum GooseExecutor.Job",
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
            internalType: "enum GooseExecutor.OffReason",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "pools",
    inputs: [
      {
        name: "reserveId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "start",
        type: "uint48",
        internalType: "uint48",
      },
      {
        name: "sold",
        type: "uint208",
        internalType: "uint208",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "protectMemberCount",
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
    name: "prune",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address",
      },
      {
        name: "job",
        type: "uint8",
        internalType: "enum GooseExecutor.Job",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "queueChange",
    inputs: [
      {
        name: "kind",
        type: "uint8",
        internalType: "enum GooseExecutor.Change",
      },
      {
        name: "value",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [
      {
        name: "id",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "eta",
        type: "uint48",
        internalType: "uint48",
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
        type: "uint48",
        internalType: "uint48",
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
    name: "registerApproved",
    inputs: [
      {
        name: "approved",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "registrationOf",
    inputs: [
      {
        name: "approved",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [
      {
        name: "ok",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "job",
        type: "uint8",
        internalType: "enum GooseExecutor.Job",
      },
      {
        name: "cap",
        type: "uint160",
        internalType: "uint160",
      },
      {
        name: "t",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "removeForwarder",
    inputs: [
      {
        name: "forwarder",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "runAccount",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address",
      },
      {
        name: "frozen_",
        type: "bool",
        internalType: "bool",
      },
    ],
    outputs: [
      {
        name: "deferred",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "sellLimits",
    inputs: [],
    outputs: [
      {
        name: "floorBps",
        type: "uint16",
        internalType: "uint16",
      },
      {
        name: "poolCap",
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
        name: "weights",
        type: "uint16[7]",
        internalType: "uint16[7]",
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
    name: "stocks",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address[7]",
        internalType: "address[7]",
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
    stateMutability: "view",
  },
  {
    type: "function",
    name: "topUps",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "on",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "day",
        type: "uint32",
        internalType: "uint32",
      },
      {
        name: "keep",
        type: "uint48",
        internalType: "uint48",
      },
      {
        name: "ready",
        type: "uint56",
        internalType: "uint56",
      },
      {
        name: "today",
        type: "uint56",
        internalType: "uint56",
      },
      {
        name: "mark",
        type: "uint56",
        internalType: "uint56",
      },
      {
        name: "own",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "unpause",
    inputs: [],
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
        internalType: "enum GooseExecutor.Change",
      },
      {
        name: "value",
        type: "bytes",
        indexed: false,
        internalType: "bytes",
      },
      {
        name: "nonce",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "eta",
        type: "uint48",
        indexed: false,
        internalType: "uint48",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "CodehashSet",
    inputs: [
      {
        name: "codehash",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "allowed",
        type: "bool",
        indexed: false,
        internalType: "bool",
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
    name: "EntryWaiting",
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
        name: "retryAt",
        type: "uint32",
        indexed: false,
        internalType: "uint32",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ForwarderSet",
    inputs: [
      {
        name: "forwarder",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "allowed",
        type: "bool",
        indexed: false,
        internalType: "bool",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "HolidaySet",
    inputs: [
      {
        name: "day",
        type: "uint32",
        indexed: true,
        internalType: "uint32",
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
        internalType: "enum GooseExecutor.Job",
      },
      {
        name: "reason",
        type: "uint8",
        indexed: false,
        internalType: "enum GooseExecutor.OffReason",
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
        internalType: "enum GooseExecutor.Job",
      },
      {
        name: "permissionHash",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
      },
      {
        name: "cap",
        type: "uint160",
        indexed: false,
        internalType: "uint160",
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
        name: "weights",
        type: "uint16[7]",
        indexed: false,
        internalType: "uint16[7]",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OwnerSet",
    inputs: [
      {
        name: "owner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "PageOpened",
    inputs: [
      {
        name: "page",
        type: "uint32",
        indexed: true,
        internalType: "uint32",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Paused",
    inputs: [
      {
        name: "paused",
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
        name: "amount",
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
      {
        name: "reason",
        type: "uint8",
        indexed: false,
        internalType: "enum ProtectCase",
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
    name: "RebalanceSkipped",
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
    name: "RunDeferred",
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
    name: "RunFailed",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "reason",
        type: "bytes4",
        indexed: false,
        internalType: "bytes4",
      },
      {
        name: "fails",
        type: "uint8",
        indexed: false,
        internalType: "uint8",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "SaleSkipped",
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
    name: "TopUpCounted",
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
        name: "waiting",
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
    name: "AccountNotAllowed",
    inputs: [],
  },
  {
    type: "error",
    name: "AlreadyBootstrapped",
    inputs: [],
  },
  {
    type: "error",
    name: "BackingMoved",
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
    name: "DebtNotLower",
    inputs: [],
  },
  {
    type: "error",
    name: "ExecutorGotFunds",
    inputs: [],
  },
  {
    type: "error",
    name: "HealthLower",
    inputs: [],
  },
  {
    type: "error",
    name: "HealthNotHigher",
    inputs: [],
  },
  {
    type: "error",
    name: "JobNotOn",
    inputs: [],
  },
  {
    type: "error",
    name: "ManagerNotOwner",
    inputs: [],
  },
  {
    type: "error",
    name: "NotApproved",
    inputs: [],
  },
  {
    type: "error",
    name: "NotForwarder",
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
    name: "OnlySelf",
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
    name: "Reentered",
    inputs: [],
  },
  {
    type: "error",
    name: "RunsPaused",
    inputs: [],
  },
  {
    type: "error",
    name: "SavingsMoved",
    inputs: [],
  },
  {
    type: "error",
    name: "SavingsNotUp",
    inputs: [],
  },
  {
    type: "error",
    name: "StaleGrant",
    inputs: [],
  },
  {
    type: "error",
    name: "StillOn",
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
        type: "uint48",
        internalType: "uint48",
      },
    ],
  },
  {
    type: "error",
    name: "TooMuchWork",
    inputs: [],
  },
  {
    type: "error",
    name: "WrongAmount",
    inputs: [],
  },
  {
    type: "error",
    name: "ZeroValue",
    inputs: [],
  },
] as const;
