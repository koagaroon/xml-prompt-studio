// Runs before React mounts so the right theme's CSS variables apply on the
// first paint, no flash. App.tsx mirrors this logic in readInitialTheme()
// so React state and the DOM data-theme attribute agree from the very
// first render. Loaded as an external script (not inline) so the CSP can
// stay on `script-src 'self'` without 'unsafe-inline' or hash allowlisting.
(function () {
  var stored = null;
  try {
    stored = localStorage.getItem("theme");
  } catch {
    // localStorage unavailable in some sandboxed embeds. Still fall
    // through to system preference so React and first paint agree.
  }
  var theme = stored === "dark" || stored === "light" ? stored : "dark";
  if (stored !== "dark" && stored !== "light") {
    try {
      if (
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: light)").matches
      ) {
        theme = "light";
      }
    } catch {
      // matchMedia unavailable — keep the CSS default-dark fallback.
    }
  }
  document.documentElement.setAttribute("data-theme", theme);
})();
