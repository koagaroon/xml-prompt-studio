// Runs before React mounts so the right theme's CSS variables apply on the
// first paint, no flash. App.tsx mirrors this logic in readInitialTheme()
// so React state and the DOM data-theme attribute agree from the very
// first render. Loaded as an external script (not inline) so the CSP can
// stay on `script-src 'self'` without 'unsafe-inline' or hash allowlisting.
//
// Syntax floor is ES2019 on purpose (let/const, bare catch) — every
// Tauri 2 webview supports it, and matching readInitialTheme's modern
// style keeps the two mirrored readers easy to diff. The floor is
// ENFORCED by eslint.config.js's public/**/*.js override (ecmaVersion
// 2019), not just convention.
(function () {
  let stored = null;
  try {
    stored = localStorage.getItem("theme");
  } catch {
    // localStorage unavailable in some sandboxed embeds. Fall through
    // to system preference so React and first paint agree.
  }
  let theme = "dark";
  if (stored === "dark" || stored === "light") {
    theme = stored;
  } else {
    try {
      if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
        theme = "light";
      }
    } catch {
      // matchMedia unavailable — keep the CSS default-dark fallback.
    }
  }
  document.documentElement.setAttribute("data-theme", theme);
})();
