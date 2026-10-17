import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // `typeof import("…")` stays allowed: vi.mock factories and the rehearsal's lazy require need it.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports", disallowTypeAnnotations: false },
      ],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      eqeqeq: ["error", "smart"],
    },
  },
  {
    // The app itself: no stray logging, and size and branching kept in check. The warnings mark what v2's
    // screen-by-screen rebuild splits up; they become errors once the last one is gone.
    files: ["app/**", "components/**", "hooks/**", "lib/**", "config/**"],
    ignores: ["lib/**/abis/**"],
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
      "max-lines": ["warn", { max: 400, skipBlankLines: true, skipComments: true }],
      complexity: ["warn", 25],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored Solidity libraries and Foundry output.
    "contracts/lib/**",
    "contracts/out/**",
  ]),
]);

export default eslintConfig;
