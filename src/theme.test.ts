import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import themeBootstrapSource from "../public/theme-bootstrap.js?raw";
import { THEME_STORAGE_KEY, persistTheme, readInitialTheme } from "./theme";

afterEach(() => {
  vi.unstubAllGlobals();
});

function runBootstrapScript(env: {
  storedValue?: string | null;
  storageThrows?: boolean;
  prefersLight?: boolean;
  matchMediaMissing?: boolean;
  matchMediaThrows?: boolean;
}): { appliedTheme: string | null; setItemCalls: number } {
  let appliedTheme: string | null = null;
  let setItemCalls = 0;

  const localStorageDouble = {
    getItem: () => {
      if (env.storageThrows) {
        throw new Error("storage blocked");
      }
      return env.storedValue ?? null;
    },
    setItem: () => {
      setItemCalls += 1;
    },
  };

  const windowDouble = env.matchMediaMissing
    ? {}
    : {
        matchMedia: (query: string) => {
          expect(query).toBe("(prefers-color-scheme: light)");
          if (env.matchMediaThrows) {
            throw new Error("matchMedia blocked");
          }
          return { matches: Boolean(env.prefersLight) };
        },
      };

  const documentDouble = {
    documentElement: {
      setAttribute: (name: string, value: string) => {
        if (name === "data-theme") {
          appliedTheme = value;
        }
      },
    },
  };

  vm.runInNewContext(themeBootstrapSource, {
    localStorage: localStorageDouble,
    window: windowDouble,
    document: documentDouble,
  });

  vi.stubGlobal("window", windowDouble);
  vi.stubGlobal("localStorage", localStorageDouble);

  return { appliedTheme, setItemCalls };
}

describe("theme helpers and public/theme-bootstrap.js parity", () => {
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

  it.each([
    { label: "stored light", storedValue: "light", prefersLight: false, expected: "light" },
    { label: "stored dark", storedValue: "dark", prefersLight: true, expected: "dark" },
    {
      label: "corrupt stored value + OS light",
      storedValue: "sepia",
      prefersLight: true,
      expected: "light",
    },
    { label: "empty storage + OS dark", storedValue: null, prefersLight: false, expected: "dark" },
    {
      label: "throwing storage + OS light",
      storageThrows: true,
      prefersLight: true,
      expected: "light",
    },
    { label: "missing matchMedia", storedValue: null, matchMediaMissing: true, expected: "dark" },
    { label: "throwing matchMedia", storedValue: null, matchMediaThrows: true, expected: "dark" },
  ])("keeps theme-bootstrap.js and readInitialTheme() in 1:1 agreement ($label)", (scenario) => {
    const bootstrap = runBootstrapScript(scenario);
    expect(bootstrap.appliedTheme).toBe(scenario.expected);
    expect(readInitialTheme()).toBe(scenario.expected);
    expect(bootstrap.setItemCalls).toBe(0);
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
