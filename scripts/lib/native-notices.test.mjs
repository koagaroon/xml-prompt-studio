import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
  NATIVE_NOTICE_TARGET,
  TAURI_BUILD_FEATURES,
  assertNativeCompilerEnvironment,
  collectNativePackages,
  fingerprintNativeInputs,
  loadNativeInventory,
  nativePackageKey,
  nativeFeatureArguments,
  parseCargoMetadata,
  parseNativeInventory,
  renderNativeNotices,
  sha256,
  validateNativeArtifacts,
  validateNativeGraph,
  validateNativeTexts,
  validateNativeToolchain,
} from "./native-notices.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const registry = "registry+https://github.com/rust-lang/crates.io-index";
const licenseText = "Copyright fixture\nPermission fixture\n";
const textHash = sha256(licenseText);
const textRef = {
  file: `texts/${textHash}.txt`,
  sha256: textHash,
  original: "LICENSE",
  source: "https://example.com/LICENSE",
};
const originalText = "<html><body>Copyright fixture</body></html>\n";

/** @returns {import("./native-notices.mjs").CargoMetadata} */
function graph() {
  const identities = [
    "app@1.0.0",
    "library@1.0.0",
    "library@2.0.0",
    "builder@1.0.0",
    "macro@1.0.0",
    "macro-helper@1.0.0",
    "dev-only@1.0.0",
    "other-platform@1.0.0",
  ];
  /** @param {string} pkg @param {string | null} kind */
  const edge = (pkg, kind = null) => ({ pkg, dep_kinds: [{ kind }] });
  return {
    packages: identities.map((id) => {
      const [name, version] = id.split("@");
      return {
        id,
        name,
        version,
        source: name === "app" ? null : registry,
        license: "MIT",
        manifest_path: `/fixture/${name}/${version}/Cargo.toml`,
        targets: [{ kind: name === "macro" ? ["proc-macro"] : ["lib"] }],
      };
    }),
    resolve: {
      root: "app@1.0.0",
      nodes: identities.map((id) => ({
        id,
        features: [],
        deps:
          id === "app@1.0.0"
            ? [
                edge("library@1.0.0"),
                edge("builder@1.0.0", "build"),
                edge("macro@1.0.0"),
                edge("dev-only@1.0.0", "dev"),
              ]
            : id === "library@1.0.0"
              ? [edge("library@2.0.0")]
              : id === "macro@1.0.0"
                ? [edge("macro-helper@1.0.0")]
                : [],
      })),
    },
  };
}

/** @param {ReturnType<typeof collectNativePackages>} [packages] @returns {import("./native-notices.mjs").NativeInventory} */
function inventory(packages = collectNativePackages(graph())) {
  return {
    schemaVersion: 1,
    target: NATIVE_NOTICE_TARGET,
    allFeatures: true,
    tauriBuildFeatures: [...TAURI_BUILD_FEATURES],
    inputFingerprint: "0".repeat(64),
    packages: packages.map((entry) => ({
      name: entry.name,
      version: entry.version,
      source: entry.source,
      license: entry.license,
      features: entry.features,
      usage: entry.usage,
      selectedLicense: "MIT",
      texts: [textRef],
      artifacts: [],
    })),
    artifacts: [],
    toolchain: {
      version: "1.98.0",
      commit: "a".repeat(40),
      source: "https://example.com/rust",
      original: "sources/rust.html.txt",
      originalSha256: sha256(originalText),
      derivation: "Complete fixture text",
      texts: [{ ...textRef, original: "COPYRIGHT-library.html" }],
    },
  };
}

describe("native notice graph coverage", () => {
  it("follows resolved package IDs, retaining multiple versions and build support while excluding dev-only and unselected-platform packages", () => {
    const packages = collectNativePackages(parseCargoMetadata(graph()));
    assert.deepEqual(
      packages.map((entry) => [nativePackageKey(entry), entry.usage]),
      [
        ["builder@1.0.0", "build-support"],
        ["library@1.0.0", "runtime"],
        ["library@2.0.0", "runtime"],
        ["macro-helper@1.0.0", "build-support"],
        ["macro@1.0.0", "build-support"],
      ]
    );
    assert.doesNotThrow(() => validateNativeGraph(inventory(), packages));
  });

  it("keeps a dependency reached through both a build edge and a normal edge in runtime coverage", () => {
    const metadata = graph();
    metadata.resolve.nodes[0].deps.push({ pkg: "builder@1.0.0", dep_kinds: [{ kind: null }] });
    assert.equal(
      collectNativePackages(metadata).find(({ name }) => name === "builder")?.usage,
      "runtime"
    );
  });

  it("fails closed on a null resolution, missing edge target, unknown dependency kind or missing license", () => {
    assert.throws(() => parseCargoMetadata({ ...graph(), resolve: null }), /Cargo resolution/u);
    const dangling = graph();
    dangling.resolve.nodes[0].deps.push({ pkg: "missing@1.0.0", dep_kinds: [{ kind: null }] });
    assert.throws(() => collectNativePackages(dangling), /Missing resolved Cargo package/u);
    const unknown = graph();
    unknown.resolve.nodes[0].deps[0].dep_kinds[0].kind = "unknown";
    assert.throws(() => parseCargoMetadata(unknown), /Unknown Cargo dependency kind/u);
    const missingLicense = graph();
    missingLicense.packages[1].license = null;
    assert.throws(() => collectNativePackages(missingLicense), /Unreviewed Cargo license\/source/u);
  });

  it("detects an omitted transitive dependency and passes again when that one entry is restored", () => {
    const packages = collectNativePackages(graph());
    const reviewed = inventory(packages);
    const removed = reviewed.packages.splice(2, 1)[0];
    assert.throws(
      () => validateNativeGraph(reviewed, packages),
      /Uncovered native dependency: library@2\.0\.0/u
    );
    reviewed.packages.push(removed);
    assert.doesNotThrow(() => validateNativeGraph(reviewed, packages));
  });

  it("rejects changed versions, licenses, sources, features and stale inventory rows", () => {
    const packages = collectNativePackages(graph());
    for (const change of [
      { version: "2.0.1" },
      { license: "Apache-2.0" },
      { source: "git+https://example.com/repo" },
      { features: ["new-feature"] },
    ]) {
      const actual = structuredClone(packages);
      Object.assign(actual[2], change);
      assert.throws(
        () => validateNativeGraph(inventory(packages), actual),
        /Uncovered native dependency|Native dependency .* changed/u
      );
    }
    assert.throws(
      () => validateNativeGraph(inventory(packages), packages.slice(1)),
      /stale dependencies/u
    );
  });

  it("requires the SDK loader notice even if its artifact record and wrapper reference are both removed", () => {
    const packages = collectNativePackages(graph());
    packages[0].name = "webview2-com-sys";
    assert.throws(
      () => validateNativeGraph(inventory(packages), packages),
      /Missing WebView2 static loader attribution/u
    );
  });
});

describe("native notice inputs and texts", () => {
  it("refuses compiler and wrapper environment overrides before validating a different PATH compiler", () => {
    for (const name of [
      "RUSTC",
      "CARGO_BUILD_RUSTC",
      "RUSTC_WRAPPER",
      "RUSTC_WORKSPACE_WRAPPER",
      "CARGO_BUILD_RUSTC_WRAPPER",
      "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER",
    ]) {
      assert.throws(
        () => assertNativeCompilerEnvironment({ [name]: "custom-compiler" }),
        /Unverified native compiler override/u
      );
    }
    assert.doesNotThrow(() =>
      assertNativeCompilerEnvironment({ RUSTUP_TOOLCHAIN: "stable", RUSTC_WRAPPER: "" })
    );
    const refused = spawnSync(process.execPath, ["scripts/check-native-notices.mjs"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: "",
        TAURI_ENV_TARGET_TRIPLE: NATIVE_NOTICE_TARGET,
        RUSTC: "custom-compiler",
      },
    });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Unverified native compiler override: RUSTC/u);
    assert.ok(!refused.stderr.includes("spawnSync cargo"));
  });

  it("applies the exposed TAURI_CONFIG feature overlay as a replacement and preserves the injected build feature", () => {
    const base = { build: { features: ["tauri/tray-icon"] } };
    assert.deepEqual(nativeFeatureArguments(base), ["tauri/custom-protocol", "tauri/tray-icon"]);
    assert.deepEqual(
      nativeFeatureArguments(base, { build: { features: ["tauri/protocol-asset"] } }),
      ["tauri/custom-protocol", "tauri/protocol-asset"]
    );
    assert.deepEqual(
      nativeFeatureArguments(base, { app: { windows: [] } }),
      nativeFeatureArguments(base)
    );
    assert.deepEqual(nativeFeatureArguments(base, { build: { features: null } }), [
      "tauri/custom-protocol",
    ]);
    assert.throws(
      () => nativeFeatureArguments(base, { build: { features: "invalid" } }),
      /expected an array/u
    );
  });

  it("requires the full compiler copyright inventory even when generic license files remain", () => {
    const { inventory: complete } = loadNativeInventory(root);
    const missing = structuredClone(complete);
    missing.toolchain.texts = missing.toolchain.texts.filter(
      ({ original }) => original !== "COPYRIGHT-library.html"
    );
    assert.ok(missing.toolchain.texts.length > 0);
    assert.throws(
      () => parseNativeInventory(missing),
      /Missing complete Rust standard-library copyright text/u
    );
    assert.doesNotThrow(() => parseNativeInventory(complete));
  });

  it("requires Tauri's injected production feature in the reviewed profile", () => {
    const data = inventory();
    data.tauriBuildFeatures = [];
    assert.throws(() => parseNativeInventory(data), /Unreviewed Tauri automatic build features/u);
    const { inventory: reviewed } = loadNativeInventory(root);
    for (const name of ["tauri", "tauri-macros"]) {
      assert.ok(
        reviewed.packages.find((entry) => entry.name === name)?.features.includes("custom-protocol")
      );
    }
  });
  it("fingerprints dependency and toolchain inputs across newline styles, independently of unrelated window settings", () => {
    /** @type {Record<string, string>} */
    const inputs = {
      "src-tauri/Cargo.toml": "manifest\n",
      "src-tauri/Cargo.lock": "lock\n",
      "rust-toolchain.toml": "toolchain\n",
      "src-tauri/tauri.conf.json": JSON.stringify({ build: {}, app: { width: 1080 } }),
    };
    const baseline = fingerprintNativeInputs((path) => inputs[path]);
    assert.equal(
      baseline,
      fingerprintNativeInputs((path) => inputs[path].replace(/\n/gu, "\r\n"))
    );
    inputs["src-tauri/tauri.conf.json"] = JSON.stringify({ build: {}, app: { width: 900 } });
    assert.equal(
      baseline,
      fingerprintNativeInputs((path) => inputs[path])
    );
    for (const path of ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "rust-toolchain.toml"]) {
      assert.notEqual(
        baseline,
        fingerprintNativeInputs((file) => inputs[file] + (file === path ? "changed" : ""))
      );
    }
    inputs["src-tauri/tauri.conf.json"] = JSON.stringify({ build: { features: ["new-feature"] } });
    assert.notEqual(
      baseline,
      fingerprintNativeInputs((path) => inputs[path])
    );
  });

  it("validates reviewed license selections rather than accepting unknown expressions or an incomplete AND choice", () => {
    for (const [license, selectedLicense] of [
      ["unknown", "MIT"],
      ["MIT", "unknown"],
      ["Apache-2.0 AND MIT", "MIT"],
    ]) {
      const data = inventory();
      Object.assign(data.packages[0], { license, selectedLicense });
      assert.throws(() => parseNativeInventory(data), /Unreviewed native license choice/u);
    }
    const dual = inventory();
    Object.assign(dual.packages[0], {
      license: "MIT OR Apache-2.0",
      selectedLicense: "Apache-2.0",
    });
    assert.doesNotThrow(() => parseNativeInventory(dual));
  });

  it("rejects unsafe paths, duplicate package identities and empty text inventories", () => {
    const traversal = inventory();
    traversal.toolchain.original = "../outside.txt";
    assert.throws(() => parseNativeInventory(traversal), /Unsafe native notice/u);
    const duplicate = inventory();
    duplicate.packages.push(duplicate.packages[0]);
    assert.throws(() => parseNativeInventory(duplicate), /duplicate native inventory/u);
    const missing = inventory();
    missing.packages[0].texts = [];
    assert.throws(() => parseNativeInventory(missing), /no reviewed license texts/u);
  });

  it("checks complete local texts and original compiler attribution with content hashes", () => {
    const reviewed = parseNativeInventory(inventory());
    const read = (/** @type {string} */ file) =>
      file.startsWith("sources/") ? originalText : licenseText;
    const texts = validateNativeTexts(reviewed, read);
    assert.equal(texts.size, 1);
    assert.equal(texts.get(textRef.file), licenseText);
    assert.throws(
      () => validateNativeTexts(reviewed, (file) => (file === textRef.file ? "" : read(file))),
      /Missing or changed native license text/u
    );
    assert.throws(
      () =>
        validateNativeTexts(reviewed, (file) =>
          file === textRef.file ? licenseText.replace("Permission", "Changed") : read(file)
        ),
      /Missing or changed native license text/u
    );
    assert.throws(
      () =>
        validateNativeTexts(reviewed, (file) =>
          file.startsWith("sources/") ? "truncated" : read(file)
        ),
      /original Rust standard-library notice changed/u
    );
    assert.doesNotThrow(() =>
      validateNativeTexts(reviewed, (file) => read(file).replace(/\n/gu, "\r\n"))
    );
  });

  it("rejects a changed native binary even when the crate version is unchanged", () => {
    const reviewed = inventory();
    const bytes = Buffer.from("reviewed loader");
    reviewed.artifacts.push({
      id: "loader",
      name: "Fixture loader",
      version: "1.0.0",
      package: nativePackageKey(reviewed.packages[0]),
      path: "x64/loader.lib",
      sha256: sha256(bytes),
      license: "MIT",
      source: "https://example.com/sdk.zip",
      archiveSha256: "1".repeat(64),
      archivePath: "build/x64/loader.lib",
      provenance: "https://example.com/source",
      texts: [textRef],
    });
    reviewed.packages[0].artifacts.push("loader");
    const valid = parseNativeInventory(reviewed);
    assert.doesNotThrow(() =>
      validateNativeArtifacts(valid, collectNativePackages(graph()), () => bytes)
    );
    assert.throws(
      () =>
        validateNativeArtifacts(valid, collectNativePackages(graph()), () =>
          Buffer.from("different loader")
        ),
      /Bundled native artifact changed/u
    );
    reviewed.artifacts = [];
    assert.throws(() => parseNativeInventory(reviewed), /Missing native artifact/u);
  });

  it("binds standard-library notices to the compiler version and exact source commit", () => {
    const reviewed = inventory();
    const correct = `release: 1.98.0\ncommit-hash: ${"a".repeat(40)}\n`;
    assert.doesNotThrow(() => validateNativeToolchain(reviewed, correct));
    assert.doesNotThrow(() => validateNativeToolchain(reviewed, correct.replace(/\n/gu, "\r\n")));
    for (const changed of [
      correct.replace("1.98.0", "1.99.0"),
      correct.replace("a".repeat(40), "b".repeat(40)),
    ]) {
      assert.throws(
        () => validateNativeToolchain(reviewed, changed),
        /do not cover the active compiler/u
      );
    }
  });

  it("renders each complete shared text once with package references and source download links", () => {
    const reviewed = inventory();
    const texts = new Map([[textRef.file, licenseText]]);
    const result = renderNativeNotices(reviewed, texts);
    assert.equal(result, renderNativeNotices(reviewed, texts));
    assert.equal(result.split(licenseText).length - 1, 1);
    assert.ok(result.includes("https://crates.io/api/v1/crates/library/2.0.0/download"));
    assert.ok(result.includes("Other native targets are unverified"));
    assert.ok(result.includes("Rust standard library 1.98.0"));
    assert.ok(!result.includes("/fixture/"));
  });

  it("loads the reviewed project notices without running Cargo and retains all complete local texts", () => {
    const { inventory: reviewed, texts } = loadNativeInventory(root);
    const output = renderNativeNotices(reviewed, texts);
    for (const text of texts.values()) assert.ok(output.includes(text));
    assert.ok(output.includes("Copyright (c) 2021 Bill Avery"));
    assert.ok(output.includes("Copyright (C) Microsoft Corporation. All rights reserved."));
    assert.ok(output.includes("Rust standard library 1.98.0"));
    assert.ok(!output.includes(root));
    const source = readFileSync(
      new URL(`../../licenses/native/${reviewed.toolchain.original}`, import.meta.url),
      "utf8"
    );
    assert.ok(source.includes("Copyright notices for The Rust Standard Library"));
  });

  it("allows an ordinary non-Windows source-build hook without Cargo and reports unverified coverage", () => {
    const result = spawnSync(process.execPath, ["scripts/check-native-notices.mjs"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      env: { ...process.env, PATH: "", TAURI_ENV_TARGET_TRIPLE: "aarch64-apple-darwin" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /coverage is unverified for aarch64-apple-darwin/u);
    assert.match(result.stderr, /Source builds remain available/u);
  });
});
