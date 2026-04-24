// eslint.config.js
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

// The flat/recommended-type-checked array: item 0 registers the plugin globally,
// item 1 adjusts eslint core rules for TS files. We spread both.
const [pluginBase, eslintRecommendedOverrides] = tseslint.configs["flat/recommended-type-checked"];

export default [
  // Register the @typescript-eslint plugin globally
  pluginBase,
  // Apply eslint core rule overrides only to TS files
  eslintRecommendedOverrides,
  // Apply type-checked rules scoped to our TS source files only
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      ...tseslint.configs["recommended-type-checked"].rules,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
];
