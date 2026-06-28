import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    // Global ignores
    {
        ignores: ["node_modules/", "dist/", "**/*.js", "*.mjs"],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
            "@typescript-eslint/no-require-imports": "warn",
            "no-console": "warn",
            "no-control-regex": "off",
            "no-empty": "warn",
            "no-useless-escape": "warn",
            "prefer-const": "warn",
        },
    },
);
