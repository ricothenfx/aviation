/**
 * Shared ESLint flat config (engineering-standards.md §2: zero warnings tolerated).
 * Consumed by the root eslint.config.mjs; keeps rule ownership in packages/config.
 * @type {import("eslint").Linter.Config[]}
 */
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/.pnpm-store/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/next-env.d.ts",
      "**/drizzle/**",
      // Agent Manager / kilo worktrees carry a full repo copy — never lint those.
      "**/.kilo/**",
    ],
  },
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "no-console": ["error", { allow: ["info", "warn", "error"] }],
    },
  },
  {
    files: ["apps/**/*.tsx", "apps/**/*.ts"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
];
