import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  MonitorError,
  classifyCargoCurrency,
  classifyNpmCurrency,
  inspectCratesMetadata,
  parseProjectMsrv,
  renderReport,
  reportExitCode,
} from "./dependency-currency.mjs";

/** @param {string} name @param {string} locked @returns {import("./dependency-currency.mjs").NpmTarget} */
function npmTarget(name, locked) {
  return {
    declaredName: name,
    registryName: name,
    requested: `^${locked}`,
    locked,
    kind: "runtime",
    major: null,
  };
}

/** @param {string} name @param {string} locked @returns {import("./dependency-currency.mjs").CargoTarget} */
function cargoTarget(name, locked) {
  return {
    declaredName: name,
    registryName: name,
    requested: `^${locked}`,
    section: name === "tauri" ? "dependencies" : "build-dependencies",
    locked,
  };
}

/** @param {string} name @param {string} latest @param {string[]} versions */
function npmMetadata(name, latest, versions) {
  return {
    name,
    "dist-tags": { latest },
    versions: Object.fromEntries(versions.map((version) => [version, { name, version }])),
  };
}

const cases = [
  {
    npm: "@tauri-apps/api",
    locked: "2.11.1",
    patch: "2.11.2",
    native: "tauri",
    nativeLocked: "2.11.6",
    nativeNext: "2.12.0",
  },
  {
    npm: "@tauri-apps/cli",
    locked: "2.11.5",
    patch: "2.11.6",
    native: "tauri-build",
    nativeLocked: "2.6.3",
    nativeNext: "2.7.0",
  },
];

describe("Tauri npm compatibility", () => {
  it("reports the two incompatible update candidates as holds with a successful exit", () => {
    const rows = cases.map((entry) => ({
      ecosystem: "npm",
      dependency: entry.npm,
      locked: entry.locked,
      ...classifyNpmCurrency(
        npmTarget(entry.npm, entry.locked),
        npmMetadata(entry.npm, "2.12.0", [entry.locked, "2.12.0"]),
        {},
        [cargoTarget(entry.native, entry.nativeLocked)]
      ),
    }));
    assert.deepEqual(
      rows.map(({ status, latest }) => [status, latest]),
      [
        ["hold", "2.12.0"],
        ["hold", "2.12.0"],
      ]
    );
    assert.match(rows[0].reason, /match locked tauri 2\.11\.6/u);
    assert.match(rows[1].reason, /static-runtime/u);
    assert.match(renderReport(rows), /current=0 actionable=0 hold=2 error=0/u);
    assert.equal(reportExitCode(rows), 0);
  });

  for (const entry of cases) {
    const target = npmTarget(entry.npm, entry.locked);
    const native = cargoTarget(entry.native, entry.nativeLocked);
    const metadata = () => npmMetadata(entry.npm, "2.12.0", [entry.locked, "2.12.0"]);

    it(`keeps a compatible ${entry.npm} patch actionable while holding the newer minor`, () => {
      const result = classifyNpmCurrency(
        target,
        npmMetadata(entry.npm, "2.12.0", [entry.locked, entry.patch, "2.12.0"]),
        {},
        [native]
      );
      assert.equal(result.status, "actionable");
      assert.equal(result.latest, entry.patch);
      assert.match(result.reason, /held/u);
      assert.equal(reportExitCode([result]), 1);
    });

    it(`reports ${entry.npm} as current when there is no newer stable release`, () => {
      const result = classifyNpmCurrency(
        target,
        npmMetadata(entry.npm, entry.locked, [entry.locked]),
        {},
        [native]
      );
      assert.equal(result.status, "current");
      assert.equal(result.latest, entry.locked);
    });

    it(`ignores deprecated and prerelease ${entry.npm} patches`, () => {
      const available = npmMetadata(entry.npm, "2.12.0", [
        entry.locked,
        `${entry.patch}-rc.1`,
        "2.12.0",
      ]);
      const result = classifyNpmCurrency(
        target,
        {
          ...available,
          versions: {
            ...available.versions,
            [entry.patch]: { name: entry.npm, version: entry.patch, deprecated: "withdrawn" },
          },
        },
        {},
        [native]
      );
      assert.equal(result.status, "hold");
    });

    it(`releases the ${entry.npm} hold when the native lock advances first`, () => {
      const result = classifyNpmCurrency(target, metadata(), {}, [
        cargoTarget(entry.native, entry.nativeNext),
      ]);
      assert.equal(result.status, "actionable");
      assert.equal(result.latest, "2.12.0");
      assert.equal(
        classifyNpmCurrency(npmTarget(entry.npm, "2.12.0"), metadata(), {}, [
          cargoTarget(entry.native, entry.nativeNext),
        ]).status,
        "current"
      );
    });

    it(`rejects an already incompatible ${entry.npm} lock, even when a future major is available`, () => {
      for (const latest of ["2.12.0", "3.0.0"]) {
        const result = classifyNpmCurrency(
          npmTarget(entry.npm, "2.12.0"),
          npmMetadata(entry.npm, latest, [entry.locked, "2.12.0", latest]),
          {},
          [native]
        );
        assert.equal(result.status, "error");
        assert.match(result.reason, /locked.*outside the supported releases/u);
        assert.equal(reportExitCode([result]), 2);
      }
    });

    it(`leaves an unknown ${entry.npm} major actionable for coordinated review`, () => {
      const result = classifyNpmCurrency(
        target,
        npmMetadata(entry.npm, "3.0.0", [entry.locked, "3.0.0"]),
        {},
        [native]
      );
      assert.equal(result.status, "actionable");
      assert.equal(result.latest, "3.0.0");
      assert.match(result.reason, /coordinated compatibility review/u);
    });

    it(`resolves a renamed direct native dependency for ${entry.npm}`, () => {
      const result = classifyNpmCurrency(target, metadata(), {}, [
        { ...native, declaredName: "desktop-native" },
      ]);
      assert.equal(result.status, "hold");
    });

    it(`rejects missing, ambiguous, or invalid direct native evidence for ${entry.npm}`, () => {
      for (const nativeTargets of [
        [],
        [{ ...native, section: "dev-dependencies" }],
        [{ ...native, locked: "invalid" }],
        [native, native],
      ]) {
        assert.throws(
          () => classifyNpmCurrency(target, metadata(), {}, nativeTargets),
          MonitorError
        );
      }
    });

    it(`rejects an unofficial registry alias for ${entry.npm}`, () => {
      assert.throws(
        () =>
          classifyNpmCurrency(
            { ...target, registryName: "unofficial" },
            npmMetadata("unofficial", entry.locked, [entry.locked]),
            {},
            [native]
          ),
        /official Tauri package/u
      );
    });

    it(`does not turn malformed ${entry.npm} metadata into a successful hold`, () => {
      const available = metadata();
      for (const invalid of [
        null,
        { ...available, name: "wrong-package" },
        { ...available, "dist-tags": {} },
        { ...available, "dist-tags": { latest: "2.12.0-rc.1" } },
        { ...available, versions: { ...available.versions, "2.12.0": null } },
        { ...available, versions: { ...available.versions, [entry.patch]: null } },
        {
          ...available,
          versions: {
            ...available.versions,
            [entry.patch]: { name: "wrong-package", version: entry.patch },
          },
        },
        {
          ...available,
          versions: {
            ...available.versions,
            [entry.patch]: { name: entry.npm, version: "2.99.0" },
          },
        },
        npmMetadata(entry.npm, "2.12.0", ["2.12.0"]),
      ]) {
        assert.throws(() => classifyNpmCurrency(target, invalid, {}, [native]), MonitorError);
      }
      const newerLock = classifyNpmCurrency(
        npmTarget(entry.npm, entry.patch),
        npmMetadata(entry.npm, entry.locked, [entry.locked]),
        {},
        [native]
      );
      assert.equal(newerLock.status, "error");
    });
  }

  it("releases the CLI hold at tauri-build 2.7.0, but not at 2.6.99", () => {
    const target = npmTarget("@tauri-apps/cli", "2.11.5");
    const metadata = npmMetadata(target.registryName, "2.12.0", ["2.11.5", "2.12.0"]);
    assert.equal(
      classifyNpmCurrency(target, metadata, {}, [cargoTarget("tauri-build", "2.6.99")]).status,
      "hold"
    );
    assert.equal(
      classifyNpmCurrency(target, metadata, {}, [cargoTarget("tauri-build", "2.7.0")]).status,
      "actionable"
    );
  });

  it("keeps coordinated native upgrades actionable when only the declared Rust minimum advances", () => {
    const minimumRust = parseProjectMsrv('[package]\nrust-version = "1.90"\n');
    const results = cases.flatMap((entry) => {
      const npmResult = classifyNpmCurrency(
        npmTarget(entry.npm, entry.locked),
        npmMetadata(entry.npm, "2.12.0", [entry.locked, "2.12.0"]),
        {},
        [cargoTarget(entry.native, entry.nativeLocked)]
      );
      const cargoMetadata = inspectCratesMetadata(
        {
          crate: { id: entry.native },
          versions: [
            { num: entry.nativeNext, yanked: false, rust_version: "1.90" },
            { num: entry.nativeLocked, yanked: false, rust_version: "1.88" },
          ],
        },
        entry.native,
        minimumRust
      );
      const cargoResult = classifyCargoCurrency(entry.nativeLocked, cargoMetadata, minimumRust.raw);
      assert.equal(npmResult.status, "hold");
      assert.equal(cargoResult.status, "actionable");
      return [npmResult, cargoResult];
    });
    assert.equal(reportExitCode(results), 1);
  });
});
