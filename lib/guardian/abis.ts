/* JustaPermissionManager (subset) — struct layout copied from the verified source on Base. */
const callPermission = {
  type: "tuple[]",
  name: "calls",
  components: [
    { name: "target", type: "address" },
    { name: "selector", type: "bytes4" },
    { name: "checker", type: "address" },
  ],
} as const;
const spendLimit = {
  type: "tuple[]",
  name: "spends",
  components: [
    { name: "token", type: "address" },
    { name: "allowance", type: "uint160" },
    { name: "unit", type: "uint8" },
    { name: "multiplier", type: "uint16" },
  ],
} as const;
export const permissionTuple = {
  type: "tuple",
  name: "permission",
  components: [
    { name: "account", type: "address" },
    { name: "spender", type: "address" },
    { name: "start", type: "uint48" },
    { name: "end", type: "uint48" },
    { name: "salt", type: "uint256" },
    callPermission,
    spendLimit,
  ],
} as const;

export const permissionManagerAbi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [permissionTuple], outputs: [{ type: "bool" }] },
  { type: "function", name: "revoke", stateMutability: "nonpayable", inputs: [permissionTuple], outputs: [] },
  { type: "function", name: "isApproved", stateMutability: "view", inputs: [permissionTuple], outputs: [{ type: "bool" }] },
  { type: "function", name: "isRevoked", stateMutability: "view", inputs: [permissionTuple], outputs: [{ type: "bool" }] },
  { type: "function", name: "getHash", stateMutability: "view", inputs: [permissionTuple], outputs: [{ type: "bytes32" }] },
  {
    type: "function",
    name: "executeBatch",
    stateMutability: "nonpayable",
    inputs: [
      permissionTuple,
      {
        type: "tuple[]",
        name: "calls",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getCurrentPeriod",
    stateMutability: "view",
    inputs: [permissionTuple, { ...spendLimit, type: "tuple", name: "spendLimit" }],
    outputs: [{ type: "tuple", components: [{ name: "start", type: "uint48" }, { name: "end", type: "uint48" }, { name: "spend", type: "uint160" }] }],
  },
  { type: "event", name: "PermissionApproved", inputs: [{ name: "permissionHash", type: "bytes32", indexed: true }, { ...permissionTuple, indexed: false }] },
  { type: "event", name: "PermissionRevoked", inputs: [{ name: "permissionHash", type: "bytes32", indexed: true }] },
] as const;

export const aaveV3PoolAbi = [
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const justanAccountAbi = [
  { type: "function", name: "isOwnerAddress", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "addOwnerAddress", stateMutability: "nonpayable", inputs: [{ name: "owner", type: "address" }], outputs: [] },
] as const;
