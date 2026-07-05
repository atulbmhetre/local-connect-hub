import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const SUPABASE_DIRECT_MUTATION_SELECTOR =
  "CallExpression[callee.property.name=/^(insert|update|delete|upsert)$/][callee.object.type='CallExpression'][callee.object.callee.property.name='from'][callee.object.callee.object.name='supabase']";

const SUPABASE_DIRECT_MUTATION_MESSAGE =
  "Direct Supabase table mutations are banned — use a SECURITY DEFINER RPC instead (see docs/db-conventions.md)";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "android/**",
      "ios/**",
      "node_modules/**",
      "coverage/**",
      "**/build/**",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: SUPABASE_DIRECT_MUTATION_SELECTOR,
          message: SUPABASE_DIRECT_MUTATION_MESSAGE,
        },
      ],
    },
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);
