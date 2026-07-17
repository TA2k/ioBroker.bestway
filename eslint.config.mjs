import js from "@eslint/js";
import globals from "globals";

export default [
    {
        ignores: [
            "node_modules/**",
            ".references/**",
            "lib/adapter-config.d.ts",
        ],
    },
    js.configs.recommended,
    {
        files: ["eslint.config.mjs"],
        languageOptions: {
            sourceType: "module",
        },
    },
    {
        files: ["**/*.js"],
        languageOptions: {
            ecmaVersion: 2020,
            sourceType: "commonjs",
            globals: {
                ...globals.node,
                ...globals.mocha,
            },
        },
        rules: {
            indent: ["error", 2, { SwitchCase: 1 }],
            "no-console": "off",
            "no-var": "error",
            "no-trailing-spaces": "error",
            "prefer-const": "error",
            quotes: [
                "error",
                "double",
                {
                    avoidEscape: true,
                    allowTemplateLiterals: true,
                },
            ],
            semi: ["error", "always"],
        },
    },
];
