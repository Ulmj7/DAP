// Security-boundary lint rules (T008).
//  - no eval / new Function / dynamic import() with a non-literal specifier, anywhere
//  - `@dap/contracts/mint` (the trusted minting runtime) is importable only from
//    packages/security/** and packages/testkit/**
//  - deep imports INTO the contracts package are forbidden outside packages/contracts
//    (relative src/dist paths and undeclared subpaths), so registerGrant/grantRecord-style
//    internals stay behind the mint boundary (ATK-ARCH-05).
import tseslint from "typescript-eslint";

const MINT_MSG =
  "The minting runtime is restricted to packages/security and packages/testkit (ATK-ARCH-05).";
const DEEP_MSG =
  "Deep imports into @dap/contracts are forbidden outside packages/contracts. Import the package root @dap/contracts (or the declared @dap/contracts/mint subpath where allowed).";

// The deep-import pattern group (ATK-ARCH-05). The `!` negations keep the DECLARED root
// (@dap/contracts) and the restricted mint subpath (@dap/contracts/mint) out of THIS rule; the
// mint subpath is handled separately by the mint restriction.
const DEEP_GROUP = {
  group: [
    "**/contracts/src/**",
    "**/contracts/dist/**",
    "@dap/contracts/*",
    "!@dap/contracts/mint",
    "!@dap/contracts/mint/*",
  ],
  message: DEEP_MSG,
};

// Full restriction (mint + deep) applied to every file by default.
const MINT_AND_DEEP = {
  paths: [{ name: "@dap/contracts/mint", message: MINT_MSG }],
  patterns: [
    {
      group: ["@dap/contracts/mint/*", "**/contracts/src/mint/*", "**/contracts/dist/mint/*"],
      message: MINT_MSG,
    },
    DEEP_GROUP,
  ],
};

// Deep-only restriction: trusted minters may import the mint subpath but never deep internals.
const DEEP_ONLY = { patterns: [DEEP_GROUP] };

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", ".specify/**", ".claude/**", ".agents/**", "specs/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.type!='Literal']",
          message: "Dynamic import() with a non-literal specifier is forbidden (ATK-ARCH-06).",
        },
        {
          selector: "NewExpression[callee.name='Function']",
          message: "`new Function` is forbidden (ATK-ARCH-06).",
        },
      ],
      "no-restricted-imports": ["error", MINT_AND_DEEP],
    },
  },
  {
    // packages/contracts may import its own modules (and the mint tree) freely by relative path.
    files: ["packages/contracts/**"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // Trusted minters: the security package and the testkit may import the restricted
    // @dap/contracts/mint subpath, but NOT deep imports into contracts.
    files: ["packages/security/**", "packages/testkit/**"],
    rules: { "no-restricted-imports": ["error", DEEP_ONLY] },
  },
);
