/**
 * GooseExecutor's `accounts(account)` getter, read with the nine fields every deployed executor has, jobs first. The
 * one live today (0x778d) returns nine; later ones add `protectIndex` after them. A read that names only these decodes
 * both (the ABI decoder never reads past the fields it's given), so the app works on either while the next executor
 * rolls out. Nothing reads `protectIndex`.
 */
export const executorAccountsAbi = [
  {
    type: "function",
    name: "accounts",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      { name: "jobs", type: "uint8" },
      { name: "index", type: "uint32" },
      { name: "fails", type: "uint8" },
      { name: "cooldownUntil", type: "uint48" },
      { name: "savesDay", type: "uint32" },
      { name: "savesToday", type: "uint8" },
      { name: "rescueAt", type: "uint48" },
      { name: "keepMix", type: "bool" },
      { name: "rebalanceDay", type: "uint32" },
    ],
  },
] as const;
