import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  checkReleasedDependencies,
  collectReleasePackages,
  compareReleasePackages,
  decodeSnapshotFile,
  inspectWindowsRelease,
  resolveReleaseCommit,
} from "./dependency-release.mjs";

const commit = "a".repeat(40);
const annotated = "b".repeat(40);
const source = "registry+https://github.com/rust-lang/crates.io-index";
const release = {
  tag_name: "v1.0.0",
  draft: false,
  prerelease: false,
  published_at: "2026-01-01T00:00:00Z",
  target_commitish: "master",
  assets: [
    {
      name: "xml-prompt-studio.exe",
      state: "uploaded",
      size: 123,
      digest: "sha256:" + "c".repeat(64),
    },
  ],
};
/** @param {string} name @param {string} version @param {boolean} dev */
const npmEntry = (name, version, dev = false) => ({
  version,
  dev,
  resolved: "https://registry.npmjs.org/" + name + "/-/package.tgz",
});
/** @param {string} version @returns {import("./dependency-release.mjs").ReleaseSnapshot} */
function snapshot(version = "1.0.0") {
  return {
    npmLock: {
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { react: "^" + version } },
        "node_modules/react": npmEntry("react", version),
        "node_modules/vite": npmEntry("vite", "8.0.0", true),
        "node_modules/eslint": npmEntry("eslint", "10.0.0", true),
        "node_modules/parent/node_modules/react": npmEntry("react", version),
      },
    },
    cargoLock:
      'version = 4\n\n[[package]]\nname = "tauri"\nversion = "2.0.0"\nsource = "' +
      source +
      '"\n\n[[package]]\nname = "build-tool"\nversion = "1.0.0"\nsource = "' +
      source +
      '"\n',
    nativeInventory: {
      schemaVersion: 1,
      target: "x86_64-pc-windows-msvc",
      allFeatures: true,
      packages: [
        { name: "tauri", version: "2.0.0", source, usage: "runtime" },
        { name: "build-tool", version: "1.0.0", source, usage: "build-support" },
      ],
    },
  };
}
/** @param {string} path @param {string} text */
const content = (path, text) => ({
  type: "file",
  path,
  encoding: "base64",
  size: Buffer.byteLength(text),
  content: Buffer.from(text).toString("base64"),
});
/** @param {string} path */
async function fetchGitHub(path) {
  if (path.endsWith("/releases/latest")) return release;
  if (path.includes("/git/ref/tags/"))
    return { ref: "refs/tags/v1.0.0", object: { type: "tag", sha: annotated } };
  if (path.endsWith("/git/tags/" + annotated))
    return { sha: annotated, object: { type: "commit", sha: commit } };
  assert.ok(path.endsWith("?ref=" + commit), "snapshot reads must use the immutable tag commit");
  const data = snapshot();
  if (path.includes("contents/package-lock.json"))
    return content("package-lock.json", JSON.stringify(data.npmLock));
  if (path.includes("contents/src-tauri/Cargo.lock"))
    return content("src-tauri/Cargo.lock", data.cargoLock);
  if (path.includes("contents/licenses/native/manifest.json"))
    return content("licenses/native/manifest.json", JSON.stringify(data.nativeInventory));
  throw new Error("Unexpected request: " + path);
}

describe("released Windows dependency scope", () => {
  it("requires a stable published release and unique uploaded executable", () => {
    assert.equal(inspectWindowsRelease(release).tag, "v1.0.0");
    for (const invalid of [
      null,
      { ...release, prerelease: true },
      { ...release, assets: [] },
      { ...release, tag_name: "v1.0.0-rc.1" },
      { ...release, assets: [...release.assets, ...release.assets] },
      { ...release, assets: [{ ...release.assets[0], digest: "invalid" }] },
    ]) {
      assert.throws(() => inspectWindowsRelease(invalid));
    }
  });

  it("resolves annotated and lightweight tags without using target_commitish", async () => {
    assert.equal(await resolveReleaseCommit("v1.0.0", fetchGitHub), commit);
    assert.equal(
      await resolveReleaseCommit("v1.0.0", async () => ({
        ref: "refs/tags/v1.0.0",
        object: { type: "commit", sha: commit },
      })),
      commit
    );
    await assert.rejects(
      () =>
        resolveReleaseCommit("v1.0.0", async () => ({
          ref: "refs/heads/v1.0.0",
          object: { type: "commit", sha: commit },
        })),
      /tag could not be verified/u
    );
    await assert.rejects(
      () =>
        resolveReleaseCommit("v1.0.0", async (path) =>
          path.includes("/git/ref/")
            ? { ref: "refs/tags/v1.0.0", object: { type: "tag", sha: annotated } }
            : { sha: annotated, object: { type: "tag", sha: annotated } }
        ),
      /does not resolve/u
    );
  });

  it("rejects malformed, oversized, wrong-path, and invalid UTF-8 snapshot content", () => {
    const valid = content("package-lock.json", "{}");
    assert.equal(decodeSnapshotFile(valid, "package-lock.json"), "{}");
    for (const invalid of [
      { ...valid, size: 1 },
      { ...valid, path: "other" },
      { ...valid, content: "!" },
      { ...valid, size: 2 * 1024 * 1024 + 1 },
      { ...valid, size: 1, content: "/w==" },
    ]) {
      assert.throws(() => decodeSnapshotFile(invalid, "package-lock.json"));
    }
  });

  it("includes Vite emitted helpers and runtime crates, excludes build-only packages, and deduplicates copies", () => {
    assert.deepEqual(collectReleasePackages(snapshot()), [
      { ecosystem: "crates.io", name: "tauri", version: "2.0.0" },
      { ecosystem: "npm", name: "react", version: "1.0.0" },
      { ecosystem: "npm", name: "vite", version: "8.0.0" },
    ]);
  });

  it("fails on inconsistent or unknown native coverage instead of claiming a clean release", () => {
    const valid = snapshot();
    assert.throws(
      () =>
        collectReleasePackages({
          ...valid,
          cargoLock: valid.cargoLock.replace('version = "2.0.0"', 'version = "2.0.1"'),
        }),
      /does not match/u
    );
    assert.throws(
      () =>
        collectReleasePackages({ ...valid, nativeInventory: { schemaVersion: 2, packages: [] } }),
      /coverage profile/u
    );
    assert.throws(() => collectReleasePackages({ ...valid, cargoLock: "" }), /inventory/u);
    assert.throws(
      () => collectReleasePackages({ ...valid, npmLock: { lockfileVersion: 2 } }),
      /runtime inventory/u
    );
  });

  it("compares version sets including added/removed packages without treating duplicate paths as changes", () => {
    const released = collectReleasePackages(snapshot());
    const development = collectReleasePackages(snapshot("1.0.1"));
    assert.deepEqual(compareReleasePackages(released, development), [
      { name: "npm react", before: "1.0.0", after: "1.0.1" },
    ]);
    const changes = compareReleasePackages(
      released,
      development.filter((entry) => entry.name !== "tauri")
    );
    assert.equal(changes[0].after, "absent");
    assert.deepEqual(compareReleasePackages(released, released), []);
  });

  it("queries released versions even when the development checkout has updated them", async () => {
    const result = await checkReleasedDependencies(snapshot("1.0.1"), "d".repeat(40), {
      fetchGitHub,
      queryBatch: async ({ queries }) => {
        assert.equal(queries.find((query) => query.package.name === "react")?.version, "1.0.0");
        return {
          results: queries.map((query) =>
            query.package.name === "react" ? { vulns: [{ id: "GHSA-abcd-1234-abcd" }] } : {}
          ),
        };
      },
    });
    assert.equal(result.rows[0].status, "actionable");
    assert.match(result.detail, /v1\.0\.0 at a{40}/u);
    assert.match(result.detail, /npm react \| 1\.0\.0 \| 1\.0\.1/u);
    assert.match(result.detail, /https:\/\/osv\.dev\/vulnerability\/GHSA-abcd-1234-abcd/u);
  });

  it("keeps release differences informational when the released advisory query is clean", async () => {
    const result = await checkReleasedDependencies(snapshot("1.0.1"), commit, {
      fetchGitHub,
      queryBatch: async ({ queries }) => ({ results: queries.map(() => ({})) }),
    });
    assert.equal(result.rows[0].status, "current");
    assert.match(result.detail, /Unreleased package-version differences: 1/u);
    assert.match(result.detail, /not a security guarantee/u);
  });

  it("reports incomplete remote evidence as an error", async () => {
    const result = await checkReleasedDependencies(snapshot(), commit, {
      fetchGitHub,
      queryBatch: async () => ({ results: null }),
    });
    assert.equal(result.rows[0].status, "error");
    assert.match(result.detail, /inspection incomplete/u);
  });
});
