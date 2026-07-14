import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  { ignores: [".scaffold/**", "build/**", "node_modules/**", "addon/**", "typings/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      globals: {
        addon: "readonly",
        Components: "readonly",
        IOUtils: "readonly",
        PathUtils: "readonly",
        Services: "readonly",
        Zotero: "readonly",
        ztoolkit: "readonly",
        _globalThis: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-empty": "off",
      "no-useless-escape": "off",
      "no-control-regex": "off",
    },
  },
];
