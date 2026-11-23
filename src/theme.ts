export type Theme = "dark" | "light";

// localStorage key for the persisted theme. Written ONLY on explicit user
// toggle so users who never toggle continue following OS preference changes.
// Keep this literal in sync with public/theme-bootstrap.js.
export const THEME_STORAGE_KEY = "theme";

export function readInitialTheme(): Theme {
  if (typeof window === "undefined") {
    return "dark";
  }
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light") {
      return stored;
    }
  } catch {
    // localStorage unavailable — fall through to system preference.
  }
  try {
    if (window.matchMedia?.("(prefers-color-scheme: light)").matches) {
      return "light";
    }
  } catch {
    // matchMedia can throw in restricted embeds; match theme-bootstrap.js.
  }
  return "dark";
}

export function persistTheme(theme: Theme): boolean {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    return true;
  } catch {
    return false;
  }
}
