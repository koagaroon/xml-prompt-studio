// ESLint flat config (ESLint 9+). Matches Vite's React+TypeScript template
// recommendations: typescript-eslint base + react-hooks + react-refresh.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Generated outputs and external sources we don't lint.
  {
    ignores: ["dist", "src-tauri/target", "src-tauri/gen", "node_modules"]
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.browser
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true }
      ]
    }
  },
  // Plain-JS coverage: public/theme-bootstrap.js (runs in the webview)
  // and this config file itself (runs under Node) — union the globals.
  // `npm run lint:js` is `eslint .` so root-level files are in scope.
  {
    extends: [js.configs.recommended],
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: { ...globals.browser, ...globals.node }
    }
  },
  // public/ scripts execute in the webview EXACTLY as written — no
  // bundler, no transpilation — so their syntax floor is whatever the
  // oldest supported webview parses. Enforce the declared ES2019 floor
  // at lint time: a newer construct (the lookbehind-regex class) would
  // otherwise pass lint and fail only at parse time on old engines.
  {
    files: ["public/**/*.js"],
    languageOptions: {
      ecmaVersion: 2019,
      globals: globals.browser
    }
  }
);
