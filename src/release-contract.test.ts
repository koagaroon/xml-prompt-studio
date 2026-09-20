import { describe, expect, it } from "vitest";
import cargoLock from "../src-tauri/Cargo.lock?raw";
import cargoToml from "../src-tauri/Cargo.toml?raw";
import tauriConfig from "../src-tauri/tauri.conf.json";

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
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

  it("keeps the portable Tauri build composition explicit", () => {
    expect(tauriConfig.build.beforeBuildCommand).toBe(
      "npm run native-notices:check && npm run build"
    );
    expect(tauriConfig.bundle.active).toBe(false);
  });
});
