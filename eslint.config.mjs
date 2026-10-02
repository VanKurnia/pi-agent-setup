import js from "@eslint/js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Extensions switched off in `/extensions`. `.script/dev-scope.mjs` derives
 * them into `tsconfig.devscope.json`, which `tsconfig.json` also extends, so
 * both tools read one source of truth. The lint, typecheck, lint:fix and
 * prepare scripts regenerate it before use; a missing file fails both tools
 * rather than silently widening the scope.
 */
const repoRoot = dirname(fileURLToPath(import.meta.url));
const devScope = JSON.parse(readFileSync(join(repoRoot, "tsconfig.devscope.json"), "utf8")).exclude;

export default tseslint.config(
    // Global ignores. devScope carries the shared exclude list (node_modules,
    // dist, build) plus the disabled extensions; the rest covers git-ignored
    // scratch directories and vendored JS.
    {
        ignores: ["tmp/", "agent/tmp/", "**/*.js", ...devScope],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        // Hand-written .mjs tooling. js.configs.recommended enables no-undef
        // but declares no globals, and only the TS preset disables no-undef.
        files: ["**/*.mjs"],
        languageOptions: {
            globals: { ...globals.node },
        },
    },
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
