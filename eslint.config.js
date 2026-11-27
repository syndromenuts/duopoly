import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["static/vendor/", "node_modules/"] },
  js.configs.recommended,
  {
    // app.js is a classic script; the dice are ES modules it imports.
    files: ["static/app.js"],
    languageOptions: { sourceType: "script", globals: globals.browser },
  },
  {
    files: ["static/dice3d.js", "static/dicephysics.js"],
    languageOptions: { sourceType: "module", globals: globals.browser },
  },
  {
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
];
