// Runs before React mounts so the right theme's CSS variables apply on the
// first paint, no flash. App.tsx mirrors this logic in readInitialTheme()
// so React state and the DOM data-theme attribute agree from the very
// first render. Loaded as an external script (not inline) so the CSP can
// stay on `script-src 'self'` without 'unsafe-inline' or hash allowlisting.
(function () {
  try {
    var stored = localStorage.getItem("theme");
    var theme =
      stored === "dark" || stored === "light"
        ? stored
        : window.matchMedia &&
            window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark";
    document.documentElement.setAttribute("data-theme", theme);
  } catch (e) {
    // localStorage / matchMedia unavailable in some sandboxed embeds.
    // Silently fall through to the CSS default-dark.
  }
})();
