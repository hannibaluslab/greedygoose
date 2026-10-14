/** Generated: cd contracts && forge inspect src/GooseExecutor.sol:GooseExecutor abi --json */
export const gooseExecutorAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "c",
        "type": "tuple",
        "internalType": "struct GooseExecutor.Config",
        "components": [
          {
            "name": "manager",
            "type": "address",
            "internalType": "contract IJustaPermissionManager"
          },
          {
            "name": "aaveV3Pool",
            "type": "address",
            "internalType": "contract IAaveV3Pool"
          },
          {
            "name": "spoke",
            "type": "address",
            "internalType": "contract ISpoke"
          },
          {
            "name": "usdc",
            "type": "address",
            "internalType": "contract IERC20"
          },
          {
            "name": "aUsdc",
            "type": "address",
            "internalType": "contract IERC20"
          },
          {
            "name": "usdcReserveId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "capMax",
            "type": "uint160",
            "internalType": "uint160"
          },
          {
            "name": "pageSize",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "owner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "codehashes",
            "type": "bytes32[]",
            "internalType": "bytes32[]"
          },
          {
            "name": "thresholds",
            "type": "tuple",
            "internalType": "struct Thresholds",
            "components": [
              {
                "name": "triggerHf",
                "type": "uint64",
                "internalType": "uint64"
              },
              {
                "name": "targetHf",
                "type": "uint64",
                "internalType": "uint64"
              },
              {
                "name": "stressDrop",
                "type": "uint64",
                "internalType": "uint64"
              },
              {
                "name": "stressFloorHf",
                "type": "uint64",
                "internalType": "uint64"
              }
            ]
          },
          {
            "name": "amounts",
            "type": "tuple",
            "internalType": "struct Amounts",
            "components": [
              {
                "name": "minRepay",
                "type": "uint64",
                "internalType": "uint64"
              },
              {
                "name": "minSave",
                "type": "uint64",
                "internalType": "uint64"
              },
              {
                "name": "keepBack",
                "type": "uint64",
                "internalType": "uint64"
              },
              {
                "name": "weekendWindow",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "maxSavesPerDay",
                "type": "uint8",
                "internalType": "uint8"
              }
            ]
          }
        ]
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "AAVE_V3_POOL",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IAaveV3Pool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ACCOUNT_GAS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "AUSDC",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "CAP_MAX",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint160",
        "internalType": "uint160"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "DELAY",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MANAGER",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IJustaPermissionManager"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_WORK",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "PAGE_SIZE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "SPOKE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract ISpoke"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "USDC",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "USDC_RESERVE_ID",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "accounts",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "jobs",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "index",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "fails",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "cooldownUntil",
        "type": "uint48",
        "internalType": "uint48"
      },
      {
        "name": "savesDay",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "savesToday",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "allowedCodehash",
    "inputs": [
      {
        "name": "codehash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "amounts",
    "inputs": [],
    "outputs": [
      {
        "name": "minRepay",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "minSave",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "keepBack",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "weekendWindow",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "maxSavesPerDay",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "applyChange",
    "inputs": [
      {
        "name": "kind",
        "type": "uint8",
        "internalType": "enum GooseExecutor.Change"
      },
      {
        "name": "value",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "nonce",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "bootstrap",
    "inputs": [
      {
        "name": "forwarders",
        "type": "address[]",
        "internalType": "address[]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "bootstrapped",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "cancelChange",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "changeNonce",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "checkLog",
    "inputs": [
      {
        "name": "log",
        "type": "tuple",
        "internalType": "struct Log",
        "components": [
          {
            "name": "index",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "timestamp",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "txHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "blockNumber",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "blockHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "source",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "topics",
            "type": "bytes32[]",
            "internalType": "bytes32[]"
          },
          {
            "name": "data",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      },
      {
        "name": "",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "upkeepNeeded",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "performData",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "checkUpkeep",
    "inputs": [
      {
        "name": "checkData",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "upkeepNeeded",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "performData",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "disallowCodehash",
    "inputs": [
      {
        "name": "codehash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "frozen",
    "inputs": [
      {
        "name": "ts",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "holiday",
    "inputs": [
      {
        "name": "day",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isForwarder",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "jobsOf",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "jobs",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "save",
        "type": "tuple",
        "internalType": "struct GooseExecutor.Grant",
        "components": [
          {
            "name": "start",
            "type": "uint48",
            "internalType": "uint48"
          },
          {
            "name": "end",
            "type": "uint48",
            "internalType": "uint48"
          },
          {
            "name": "cap",
            "type": "uint160",
            "internalType": "uint160"
          }
        ]
      },
      {
        "name": "protect",
        "type": "tuple",
        "internalType": "struct GooseExecutor.Grant",
        "components": [
          {
            "name": "start",
            "type": "uint48",
            "internalType": "uint48"
          },
          {
            "name": "end",
            "type": "uint48",
            "internalType": "uint48"
          },
          {
            "name": "cap",
            "type": "uint160",
            "internalType": "uint160"
          }
        ]
      },
      {
        "name": "fails",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "cooldownUntil",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "memberCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "members",
    "inputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "nextFreeze",
    "inputs": [
      {
        "name": "ts",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pause",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "paused",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "performUpkeep",
    "inputs": [
      {
        "name": "performData",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "permissionOf",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "job",
        "type": "uint8",
        "internalType": "enum GooseExecutor.Job"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct IJustaPermissionManager.Permission",
        "components": [
          {
            "name": "account",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "spender",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "start",
            "type": "uint48",
            "internalType": "uint48"
          },
          {
            "name": "end",
            "type": "uint48",
            "internalType": "uint48"
          },
          {
            "name": "salt",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "calls",
            "type": "tuple[]",
            "internalType": "struct IJustaPermissionManager.CallPermission[]",
            "components": [
              {
                "name": "target",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "selector",
                "type": "bytes4",
                "internalType": "bytes4"
              },
              {
                "name": "checker",
                "type": "address",
                "internalType": "address"
              }
            ]
          },
          {
            "name": "spends",
            "type": "tuple[]",
            "internalType": "struct IJustaPermissionManager.SpendLimit[]",
            "components": [
              {
                "name": "token",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "allowance",
                "type": "uint160",
                "internalType": "uint160"
              },
              {
                "name": "unit",
                "type": "uint8",
                "internalType": "enum IJustaPermissionManager.PeriodUnit"
              },
              {
                "name": "multiplier",
                "type": "uint16",
                "internalType": "uint16"
              }
            ]
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "planOf",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct GooseExecutor.Plan",
        "components": [
          {
            "name": "action",
            "type": "uint8",
            "internalType": "enum GooseExecutor.Action"
          },
          {
            "name": "job",
            "type": "uint8",
            "internalType": "enum GooseExecutor.Job"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "hf",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "reason",
            "type": "uint8",
            "internalType": "enum ProtectCase"
          },
          {
            "name": "off",
            "type": "uint8",
            "internalType": "enum GooseExecutor.OffReason"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "prune",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "job",
        "type": "uint8",
        "internalType": "enum GooseExecutor.Job"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "queueChange",
    "inputs": [
      {
        "name": "kind",
        "type": "uint8",
        "internalType": "enum GooseExecutor.Change"
      },
      {
        "name": "value",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "eta",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "queued",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "eta",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "register",
    "inputs": [
      {
        "name": "job",
        "type": "uint8",
        "internalType": "enum GooseExecutor.Job"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "start",
        "type": "uint48",
        "internalType": "uint48"
      },
      {
        "name": "end",
        "type": "uint48",
        "internalType": "uint48"
      },
      {
        "name": "salt",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "cap",
        "type": "uint160",
        "internalType": "uint160"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "removeForwarder",
    "inputs": [
      {
        "name": "forwarder",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "runAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "preFreeze",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "thresholds",
    "inputs": [],
    "outputs": [
      {
        "name": "triggerHf",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "targetHf",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "stressDrop",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "stressFloorHf",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "unpause",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "ChangeApplied",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ChangeCancelled",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ChangeQueued",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "kind",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum GooseExecutor.Change"
      },
      {
        "name": "value",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      },
      {
        "name": "nonce",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "eta",
        "type": "uint48",
        "indexed": false,
        "internalType": "uint48"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CodehashSet",
    "inputs": [
      {
        "name": "codehash",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "allowed",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ForwarderSet",
    "inputs": [
      {
        "name": "forwarder",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "allowed",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "HolidaySet",
    "inputs": [
      {
        "name": "day",
        "type": "uint32",
        "indexed": true,
        "internalType": "uint32"
      },
      {
        "name": "on",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "JobOff",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "job",
        "type": "uint8",
        "indexed": true,
        "internalType": "enum GooseExecutor.Job"
      },
      {
        "name": "reason",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum GooseExecutor.OffReason"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "JobOn",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "job",
        "type": "uint8",
        "indexed": true,
        "internalType": "enum GooseExecutor.Job"
      },
      {
        "name": "permissionHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "cap",
        "type": "uint160",
        "indexed": false,
        "internalType": "uint160"
      },
      {
        "name": "end",
        "type": "uint48",
        "indexed": false,
        "internalType": "uint48"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnerSet",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PageOpened",
    "inputs": [
      {
        "name": "page",
        "type": "uint32",
        "indexed": true,
        "internalType": "uint32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Paused",
    "inputs": [
      {
        "name": "paused",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ProtectRepaid",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "hfBefore",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "hfAfter",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "reason",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum ProtectCase"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RunDeferred",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RunFailed",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "reason",
        "type": "bytes4",
        "indexed": false,
        "internalType": "bytes4"
      },
      {
        "name": "fails",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Saved",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AccountNotAllowed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadyBootstrapped",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadWindow",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CapOutOfBounds",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CashLower",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DebtNotLower",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ExecutorGotFunds",
    "inputs": []
  },
  {
    "type": "error",
    "name": "HealthLower",
    "inputs": []
  },
  {
    "type": "error",
    "name": "JobNotOn",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ManagerNotOwner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotApproved",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotForwarder",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotOwner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotQueued",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OnlySelf",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OutOfBounds",
    "inputs": []
  },
  {
    "type": "error",
    "name": "Reentered",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RunsPaused",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SavingsMoved",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SavingsNotUp",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StaleGrant",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StillOn",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TooEarly",
    "inputs": [
      {
        "name": "eta",
        "type": "uint48",
        "internalType": "uint48"
      }
    ]
  },
  {
    "type": "error",
    "name": "TooMuchWork",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongAmount",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroValue",
    "inputs": []
  }
] as const;
