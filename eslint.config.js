// Security-boundary lint rules (T008).
//  - no eval / new Function / dynamic import() with a non-literal specifier, anywhere
//  - `@dap/contracts/mint` (the trusted minting runtime) is importable only from
//    packages/security/** and packages/testkit/**
import tseslint from "typescript-eslint";

const MINT_RESTRICTION = {
  paths: [
    {
      name: "@dap/contracts/mint",
      message:
        "The minting runtime is restricted to packages/security and packages/testkit (ATK-ARCH-05).",
    },
  ],
  patterns: [
    {
      group: ["@dap/contracts/mint/*", "**/contracts/src/mint/*", "**/contracts/dist/mint/*"],
      message:
        "The minting runtime is restricted to packages/security and packages/testkit (ATK-ARCH-05).",
    },
  ],
};

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
      "no-restricted-imports": ["error", MINT_RESTRICTION],
    },
  },
  {
    // Trusted code that is allowed to mint: the security package, the testkit, and the
    // minting module's own files (they import each other by relative path).
    files: ["packages/security/**", "packages/testkit/**", "packages/contracts/src/mint/**"],
    rules: { "no-restricted-imports": "off" },
  },
);
