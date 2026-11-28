import { describe, expect, it } from "vitest";
import defaultCapabilities from "../src-tauri/capabilities/default.json";
import cargoLock from "../src-tauri/Cargo.lock?raw";
import cargoToml from "../src-tauri/Cargo.toml?raw";
import rustLib from "../src-tauri/src/lib.rs?raw";
import rustMain from "../src-tauri/src/main.rs?raw";
import tauriConfig from "../src-tauri/tauri.conf.json";
import viteConfigSource from "../vite.config.ts?raw";
import { MAX_XML_BYTES } from "./helpers";

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

function parseRustNumberConstant(source: string, constantName: string): number {
  const match = new RegExp(
    `const\\s+${constantName}\\s*:\\s*[A-Za-z0-9_]+\\s*=\\s*([0-9_.]+)\\s*;`,
    "u"
  ).exec(source);
  expect(match, `Rust constant ${constantName}`).not.toBeNull();
  return Number(match![1].replaceAll("_", ""));
}

describe("release configuration contract", () => {
  it("uses Cargo.toml as the sole application-version source", () => {
    const normalizedCargoToml = normalizeNewlines(cargoToml);
    const normalizedCargoLock = normalizeNewlines(cargoLock);
    const packageSection = /^\[package\]\n(?<body>[\s\S]*?)(?=^\[)/mu.exec(normalizedCargoToml)
      ?.groups?.body;
    const cargoManifestVersion = /^version = "([^"]+)"$/mu.exec(packageSection ?? "")?.[1];
    const cargoLockRootPackages = normalizedCargoLock
      .split(/(?=^\[\[package\]\]$)/mu)
      .filter((packageStanza) => /^name = "xml-prompt-studio"$/mu.test(packageStanza))
      .filter((packageStanza) => !/^source = /mu.test(packageStanza));
    const cargoLockVersions = cargoLockRootPackages.map(
      (packageStanza) => /^version = "([^"]+)"$/mu.exec(packageStanza)?.[1]
    );

    expect(cargoManifestVersion).toBeDefined();
    expect(cargoLockRootPackages).toHaveLength(1);
    expect(cargoLockVersions).toEqual([cargoManifestVersion]);
    expect(tauriConfig).not.toHaveProperty("version");
  });

  it("keeps the portable Tauri build composition and Windows GUI subsystem explicit", () => {
    expect(tauriConfig.build.beforeBuildCommand).toBe(
      "npm run native-notices:check && npm run build"
    );
    expect(tauriConfig.bundle.active).toBe(false);
    expect(normalizeNewlines(rustMain)).toContain(
      '#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]'
    );
  });

  it("keeps cross-boundary constants, devUrl, window flags, CSP, and empty capabilities in sync", () => {
    const normalizedRustLib = normalizeNewlines(rustLib);
    expect(parseRustNumberConstant(normalizedRustLib, "MAX_XML_BYTES")).toBe(MAX_XML_BYTES);

    const mainWindow = tauriConfig.app.windows[0];
    expect(mainWindow.label).toBe("main");
    expect(mainWindow.visible).toBe(false);
    expect(mainWindow.dragDropEnabled).toBe(false);
    expect(parseRustNumberConstant(normalizedRustLib, "CONFIG_MIN_WINDOW_WIDTH")).toBe(
      mainWindow.minWidth
    );
    expect(parseRustNumberConstant(normalizedRustLib, "CONFIG_MIN_WINDOW_HEIGHT")).toBe(
      mainWindow.minHeight
    );

    const normalizedVite = normalizeNewlines(viteConfigSource);
    const devHost = /const\s+DEV_HOST\s*=\s*"([^"]+)"/u.exec(normalizedVite)?.[1];
    const devPort = /const\s+DEV_PORT\s*=\s*(\d+)/u.exec(normalizedVite)?.[1];
    expect(`http://${devHost}:${devPort}`).toBe(tauriConfig.build.devUrl);

    const csp = tauriConfig.app.security.csp;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");

    expect(defaultCapabilities.windows).toEqual(["main"]);
    expect(defaultCapabilities.permissions).toEqual([]);
  });
});
