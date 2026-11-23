import { afterEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY, persistTheme, readInitialTheme } from "./theme";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme helpers", () => {
  it("uses an explicit stored theme before querying system preference", () => {
    const matchMedia = vi.fn();
    vi.stubGlobal("window", { matchMedia });
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue("light"),
      setItem: vi.fn(),
    });

    expect(readInitialTheme()).toBe("light");
    expect(matchMedia).not.toHaveBeenCalled();
  });

  it("falls back to OS preference when storage has no valid theme, defaulting to dark", () => {
    vi.stubGlobal("window", {
      matchMedia: vi.fn().mockReturnValue({ matches: true }),
    });
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
    });
    expect(readInitialTheme()).toBe("light");

    vi.stubGlobal("window", {
      matchMedia: vi.fn().mockImplementation(() => {
        throw new Error("sandboxed");
      }),
    });
    expect(readInitialTheme()).toBe("dark");
  });

  it("writes theme choice and reports storage failures cleanly", () => {
    const setItem = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("unavailable");
      });
    vi.stubGlobal("localStorage", { getItem: vi.fn(), setItem });

    expect(persistTheme("light")).toBe(true);
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "light");
    expect(persistTheme("dark")).toBe(false);
  });
});
