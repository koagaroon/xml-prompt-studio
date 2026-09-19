import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const NATIVE_NOTICE_TARGET = "x86_64-pc-windows-msvc";
// Tauri CLI build_options adds this dependency feature to both debug and release builds.
export const TAURI_BUILD_FEATURES = ["tauri/custom-protocol"];
const compilerOverrides = [
  "RUSTC",
  "CARGO_BUILD_RUSTC",
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "CARGO_BUILD_RUSTC_WRAPPER",
  "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER",
];
const registrySource = "registry+https://github.com/rust-lang/crates.io-index";
const licenseChoices = new Map([
  ["0BSD OR MIT OR Apache-2.0", ["MIT"]],
  ["Unlicense OR MIT", ["MIT"]],
  ["BSD-3-Clause", ["BSD-3-Clause"]],
  ["MIT OR Apache-2.0", ["MIT", "Apache-2.0"]],
  ["Apache-2.0 OR MIT", ["MIT", "Apache-2.0"]],
  ["MIT/Apache-2.0", ["MIT"]],
  ["BSD-3-Clause AND MIT", ["BSD-3-Clause AND MIT"]],
  ["BSD-3-Clause/MIT", ["BSD-3-Clause"]],
  ["MIT", ["MIT"]],
  ["BSL-1.0", ["BSL-1.0"]],
  ["MPL-2.0", ["MPL-2.0"]],
  ["Apache-2.0 AND MIT", ["Apache-2.0 AND MIT"]],
  ["CC0-1.0 OR MIT-0 OR Apache-2.0", ["CC0-1.0"]],
  ["Apache-2.0 / MIT", ["MIT"]],
  ["Zlib", ["Zlib"]],
  ["Unicode-3.0", ["Unicode-3.0"]],
  ["MIT OR Zlib OR Apache-2.0", ["MIT"]],
  ["MIT OR Apache-2.0 OR Zlib", ["MIT"]],
  ["Unlicense/MIT", ["MIT"]],
  ["Apache-2.0", ["Apache-2.0"]],
  ["Zlib OR Apache-2.0 OR MIT", ["MIT"]],
  ["(MIT OR Apache-2.0) AND Unicode-3.0", ["MIT AND Unicode-3.0"]],
]);

/**
 * @typedef {{ file: string, sha256: string, original: string, source: string }} NativeText
 * @typedef {{ name: string, version: string, source: string, license: string, features: string[], usage: string, selectedLicense: string, texts: NativeText[], artifacts: string[] }} NativePackage
 * @typedef {{ id: string, name: string, version: string, package: string, path: string, sha256: string, license: string, source: string, archiveSha256: string, archivePath: string, provenance: string, texts: NativeText[] }} NativeArtifact
 * @typedef {{ version: string, commit: string, source: string, original: string, originalSha256: string, derivation: string, texts: NativeText[] }} NativeToolchain
 * @typedef {{ schemaVersion: number, target: string, allFeatures: boolean, tauriBuildFeatures: string[], inputFingerprint: string, packages: NativePackage[], artifacts: NativeArtifact[], toolchain: NativeToolchain }} NativeInventory
 * @typedef {{ id: string, name: string, version: string, source: string | null, license: string | null, manifest_path: string, targets: { kind: string[] }[] }} CargoPackage
 * @typedef {{ id: string, features: string[], deps: { pkg: string, dep_kinds: { kind: string | null }[] }[] }} CargoNode
 * @typedef {{ packages: CargoPackage[], resolve: { root: string, nodes: CargoNode[] } }} CargoMetadata
 */

/** @param {string} value */
export const normalizeNativeText = (value) => value.replace(/\r\n/gu, "\n");
/** @param {string | Buffer} value */
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
/** @param {unknown} value @param {string} label */
function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid native notice ${label}: expected an object.`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {unknown} value @param {string} label */
function string(value, label) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/u.test(value)) {
    throw new Error(`Invalid native notice ${label}: expected a nonempty single-line string.`);
  }
  return value;
}
/** @param {unknown} value @param {string} label */
function array(value, label) {
  if (!Array.isArray(value)) throw new Error(`Invalid native notice ${label}: expected an array.`);
  return /** @type {unknown[]} */ (value);
}
/** @param {unknown} value @param {string} label */
function strings(value, label) {
  const result = array(value, label).map((entry) => string(entry, label));
  if (new Set(result).size !== result.length) throw new Error(`Duplicate native notice ${label}.`);
  return result;
}
/** @param {unknown} value @param {string} label */
function digest(value, label) {
  const result = string(value, label);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new Error(`Invalid native notice ${label} SHA-256.`);
  return result;
}
/** @param {unknown} value @param {string} label */
function relativePath(value, label) {
  const result = string(value, label);
  if (
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(result) ||
    result.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error(`Unsafe native notice ${label}: ${result}`);
  }
  return result;
}
/** @param {unknown} value @param {string} label */
function sourceUrl(value, label) {
  const result = string(value, label);
  const url = new URL(result);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`Invalid native notice ${label}: expected a public HTTPS source.`);
  }
  return result;
}
/** @param {{name: string, version: string}} entry */
export const nativePackageKey = (entry) => `${entry.name}@${entry.version}`;
/** @param {{name: string, version: string}} left @param {{name: string, version: string}} right */
const comparePackages = (left, right) =>
  nativePackageKey(left) < nativePackageKey(right)
    ? -1
    : nativePackageKey(left) > nativePackageKey(right)
      ? 1
      : 0;

/** @param {unknown} value @returns {NativeText[]} */
function parseTexts(value) {
  const result = array(value, "texts").map((entry) => {
    const item = record(entry, "text");
    const hash = digest(item.sha256, "text");
    const file = relativePath(item.file, "text file");
    if (file !== `texts/${hash}.txt`)
      throw new Error(`Native text filename must match its hash: ${file}`);
    return {
      file,
      sha256: hash,
      original: relativePath(item.original, "original filename"),
      source: sourceUrl(item.source, "text source"),
    };
  });
  if (!result.length) throw new Error("Native notice entry has no reviewed license texts.");
  return result;
}

/** @param {unknown} value @returns {NativeInventory} */
export function parseNativeInventory(value) {
  const data = record(value, "inventory");
  if (
    data.schemaVersion !== 1 ||
    data.target !== NATIVE_NOTICE_TARGET ||
    data.allFeatures !== true
  ) {
    throw new Error("Unsupported native notice schema or target/feature profile.");
  }
  const tauriBuildFeatures = strings(data.tauriBuildFeatures, "Tauri build profile").sort();
  if (JSON.stringify(tauriBuildFeatures) !== JSON.stringify(TAURI_BUILD_FEATURES)) {
    throw new Error("Unreviewed Tauri automatic build features.");
  }
  const packages = array(data.packages, "packages").map((entry) => {
    const item = record(entry, "package");
    const name = string(item.name, "package name");
    const version = string(item.version, "package version");
    if (
      !/^[A-Za-z0-9_-]+$/u.test(name) ||
      !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/u.test(version)
    ) {
      throw new Error(`Invalid native package identity: ${name}@${version}`);
    }
    if (item.source !== registrySource)
      throw new Error(`Unreviewed native package source: ${name}`);
    const usage = string(item.usage, "package usage");
    if (!["runtime", "build-support"].includes(usage))
      throw new Error(`Unknown native usage: ${usage}`);
    const license = string(item.license, "declared license");
    const selectedLicense = string(item.selectedLicense, "reviewed license selection");
    if (!licenseChoices.get(license)?.includes(selectedLicense))
      throw new Error(
        `Unreviewed native license choice: ${name}: ${license} -> ${selectedLicense}`
      );
    return {
      name,
      version,
      source: registrySource,
      license,
      features: strings(item.features, "features").sort(),
      usage,
      selectedLicense,
      texts: parseTexts(item.texts),
      artifacts: strings(item.artifacts, "artifact references"),
    };
  });
  const artifacts = array(data.artifacts, "artifacts").map((entry) => {
    const item = record(entry, "artifact");
    const license = string(item.license, "artifact license");
    if (![...licenseChoices.values()].some((choices) => choices.includes(license))) {
      throw new Error(`Unreviewed native artifact license: ${license}`);
    }
    return {
      id: string(item.id, "artifact id"),
      name: string(item.name, "artifact name"),
      version: string(item.version, "artifact version"),
      package: string(item.package, "artifact package"),
      path: relativePath(item.path, "artifact path"),
      sha256: digest(item.sha256, "artifact"),
      license,
      source: sourceUrl(item.source, "artifact source"),
      archiveSha256: digest(item.archiveSha256, "source archive"),
      archivePath: relativePath(item.archivePath, "archive path"),
      provenance: sourceUrl(item.provenance, "artifact provenance"),
      texts: parseTexts(item.texts),
    };
  });
  if (
    !packages.length ||
    new Set(packages.map(nativePackageKey)).size !== packages.length ||
    new Set(artifacts.map(({ id }) => id)).size !== artifacts.length
  ) {
    throw new Error("Empty or duplicate native inventory entries.");
  }
  const packageMap = new Map(packages.map((entry) => [nativePackageKey(entry), entry]));
  const artifactMap = new Map(artifacts.map((entry) => [entry.id, entry]));
  for (const entry of packages)
    for (const id of entry.artifacts) {
      if (artifactMap.get(id)?.package !== nativePackageKey(entry))
        throw new Error(`Missing native artifact: ${id}`);
    }
  for (const entry of artifacts) {
    if (!packageMap.get(entry.package)?.artifacts.includes(entry.id)) {
      throw new Error(`Unlinked native artifact: ${entry.id}`);
    }
  }
  const compiler = record(data.toolchain, "Rust standard-library attribution");
  const version = string(compiler.version, "Rust version");
  const commit = string(compiler.commit, "Rust source commit");
  if (!/^\d+\.\d+\.\d+$/u.test(version) || !/^[a-f0-9]{40}$/u.test(commit))
    throw new Error("Invalid Rust notice version/commit.");
  const toolchain = {
    version,
    commit,
    source: sourceUrl(compiler.source, "Rust source"),
    original: relativePath(compiler.original, "Rust original notice"),
    originalSha256: digest(compiler.originalSha256, "Rust original notice"),
    derivation: string(compiler.derivation, "Rust notice derivation"),
    texts: parseTexts(compiler.texts),
  };
  if (
    toolchain.texts.filter(({ original }) => original === "COPYRIGHT-library.html").length !== 1
  ) {
    throw new Error(
      "Missing complete Rust standard-library copyright text for the offline viewer."
    );
  }
  return {
    schemaVersion: 1,
    target: NATIVE_NOTICE_TARGET,
    allFeatures: true,
    tauriBuildFeatures,
    inputFingerprint: digest(data.inputFingerprint, "input fingerprint"),
    packages,
    artifacts,
    toolchain,
  };
}

/** @param {(path: string) => string} readText */
export function fingerprintNativeInputs(readText) {
  const inputs = ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "rust-toolchain.toml"].map(
    (path) => [path, normalizeNativeText(readText(path))]
  );
  const config = record(JSON.parse(readText("src-tauri/tauri.conf.json")), "Tauri config");
  const build = record(config.build, "Tauri build config");
  inputs.push([
    "Tauri build features",
    JSON.stringify(strings(build.features ?? [], "Tauri features").sort()),
  ]);
  inputs.push(["Tauri automatic build features", JSON.stringify(TAURI_BUILD_FEATURES)]);
  return sha256(JSON.stringify(inputs));
}

/** @param {string} root */
export function nativeInputFingerprint(root) {
  return fingerprintNativeInputs((path) => readFileSync(join(root, path), "utf8"));
}

/** @param {Record<string, string | undefined>} environment */
export function assertNativeCompilerEnvironment(environment) {
  const configured = Object.entries(environment).filter(
    ([key, value]) => value?.trim() && compilerOverrides.includes(key.toUpperCase())
  );
  if (configured.length)
    throw new Error(
      `Unverified native compiler override: ${configured.map(([key]) => key).join(", ")}. Remove the override to use the reviewed pinned compiler profile, or review that custom compiler and its notices separately.`
    );
}

/** @param {unknown} config @param {unknown} [overlay] */
export function nativeFeatureArguments(config, overlay) {
  const build = record(record(config, "Tauri config").build, "Tauri build config");
  let features = build.features;
  if (overlay !== undefined) {
    const overrides = record(overlay, "TAURI_CONFIG overlay");
    if (overrides.build === null) features = [];
    else if (overrides.build !== undefined) {
      const overrideBuild = record(overrides.build, "TAURI_CONFIG build overlay");
      if (Object.hasOwn(overrideBuild, "features")) features = overrideBuild.features;
    }
  }
  return [
    ...new Set([...TAURI_BUILD_FEATURES, ...strings(features ?? [], "Tauri features")]),
  ].sort();
}

/** @param {NativeInventory} inventory @param {(file: string) => string} readText */
export function validateNativeTexts(inventory, readText) {
  const texts = new Map();
  for (const entry of [...inventory.packages, ...inventory.artifacts, inventory.toolchain])
    for (const ref of entry.texts) {
      if (texts.has(ref.file)) continue;
      const text = normalizeNativeText(readText(ref.file));
      if (!text.trim() || sha256(text) !== ref.sha256)
        throw new Error(`Missing or changed native license text: ${ref.file}`);
      texts.set(ref.file, text);
    }
  if (
    sha256(normalizeNativeText(readText(inventory.toolchain.original))) !==
    inventory.toolchain.originalSha256
  ) {
    throw new Error("The original Rust standard-library notice changed.");
  }
  return /** @type {Map<string, string>} */ (texts);
}

/** @param {string} root */
export function loadNativeInventory(root) {
  const directory = join(root, "licenses/native");
  const inventory = parseNativeInventory(
    JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"))
  );
  if (inventory.inputFingerprint !== nativeInputFingerprint(root)) {
    throw new Error(
      "Native notices are stale after a Cargo/toolchain input change. Run npm run native-notices:check -- --print-inventory and review licenses/native/manifest.json and its texts."
    );
  }
  return {
    inventory,
    texts: validateNativeTexts(inventory, (file) => readFileSync(join(directory, file), "utf8")),
  };
}

/** @param {unknown} value @returns {CargoMetadata} */
export function parseCargoMetadata(value) {
  const data = record(value, "Cargo metadata");
  const resolve = record(data.resolve, "Cargo resolution");
  const packages = array(data.packages, "Cargo packages").map((entry) => {
    const item = record(entry, "Cargo package");
    return {
      id: string(item.id, "Cargo package id"),
      name: string(item.name, "Cargo package name"),
      version: string(item.version, "Cargo package version"),
      source: item.source === null ? null : string(item.source, "Cargo source"),
      license: item.license === null ? null : string(item.license, "Cargo license"),
      manifest_path: string(item.manifest_path, "Cargo manifest path"),
      targets: array(item.targets, "Cargo targets").map((target) => ({
        kind: strings(record(target, "Cargo target").kind, "Cargo target kinds"),
      })),
    };
  });
  const nodes = array(resolve.nodes, "Cargo nodes").map((entry) => {
    const item = record(entry, "Cargo node");
    return {
      id: string(item.id, "Cargo node id"),
      features: strings(item.features, "Cargo features").sort(),
      deps: array(item.deps, "Cargo edges").map((edge) => {
        const dep = record(edge, "Cargo edge");
        const kinds = array(dep.dep_kinds, "Cargo dependency kinds").map((kind) => {
          const value = record(kind, "Cargo dependency kind").kind;
          if (value !== null && value !== "build" && value !== "dev")
            throw new Error("Unknown Cargo dependency kind.");
          return { kind: value };
        });
        if (!kinds.length) throw new Error("Missing Cargo dependency kind.");
        return { pkg: string(dep.pkg, "Cargo edge package"), dep_kinds: kinds };
      }),
    };
  });
  if (
    new Set(packages.map(({ id }) => id)).size !== packages.length ||
    new Set(nodes.map(({ id }) => id)).size !== nodes.length
  ) {
    throw new Error("Duplicate Cargo package or resolution id.");
  }
  return { packages, resolve: { root: string(resolve.root, "Cargo root"), nodes } };
}

/** @param {CargoMetadata} metadata */
export function collectNativePackages(metadata) {
  const packages = new Map(metadata.packages.map((entry) => [entry.id, entry]));
  const nodes = new Map(metadata.resolve.nodes.map((entry) => [entry.id, entry]));
  const root = metadata.resolve.root;
  const seen = new Set();
  const ids = new Set();
  const runtime = new Set([root]);
  const todo = [{ id: root, isRuntime: true }];
  while (todo.length) {
    const current = todo.pop();
    if (!current) break;
    const { id, isRuntime } = current;
    const visit = `${id}:${isRuntime}`;
    if (seen.has(visit)) continue;
    seen.add(visit);
    ids.add(id);
    const entry = packages.get(id);
    const node = nodes.get(id);
    if (!entry || !node) throw new Error(`Missing resolved Cargo package: ${id}`);
    const isProcMacro = entry.targets.some(({ kind }) => kind.includes("proc-macro"));
    if (isRuntime && !isProcMacro) runtime.add(id);
    for (const dep of node.deps)
      for (const { kind } of dep.dep_kinds) {
        if (kind !== "dev")
          todo.push({ id: dep.pkg, isRuntime: isRuntime && !isProcMacro && kind === null });
      }
  }
  return [...ids]
    .filter((id) => id !== root)
    .map((id) => {
      const entry = packages.get(id);
      const node = nodes.get(id);
      if (!entry || !node) throw new Error(`Missing resolved Cargo package: ${id}`);
      if (!entry.license || entry.source !== registrySource)
        throw new Error(`Unreviewed Cargo license/source: ${entry.name}@${entry.version}`);
      return {
        name: entry.name,
        version: entry.version,
        source: entry.source,
        license: entry.license,
        features: [...node.features].sort(),
        usage: runtime.has(id) ? "runtime" : "build-support",
        manifestPath: entry.manifest_path,
      };
    })
    .sort(comparePackages);
}

/** @param {NativeInventory} inventory @param {ReturnType<typeof collectNativePackages>} actual */
export function validateNativeGraph(inventory, actual) {
  const expected = new Map(inventory.packages.map((entry) => [nativePackageKey(entry), entry]));
  for (const entry of actual) {
    const key = nativePackageKey(entry);
    const reviewed = expected.get(key);
    if (!reviewed)
      throw new Error(
        `Uncovered native dependency: ${key}. Review its notices before building Windows.`
      );
    for (const field of /** @type {const} */ (["source", "license", "usage", "features"])) {
      if (JSON.stringify(entry[field]) !== JSON.stringify(reviewed[field]))
        throw new Error(`Native dependency ${field} changed: ${key}`);
    }
    expected.delete(key);
  }
  if (expected.size)
    throw new Error(`Native inventory has stale dependencies: ${[...expected.keys()].join(", ")}`);
  const webview = actual.find(({ name }) => name === "webview2-com-sys");
  if (
    webview &&
    !inventory.artifacts.some(
      (entry) =>
        entry.package === nativePackageKey(webview) && entry.path === "x64/WebView2LoaderStatic.lib"
    )
  ) {
    throw new Error(
      "Missing WebView2 static loader attribution; the wrapper's MIT license does not replace the SDK license."
    );
  }
}

/** @param {NativeInventory} inventory @param {string} versionOutput */
export function validateNativeToolchain(inventory, versionOutput) {
  versionOutput = normalizeNativeText(versionOutput);
  const release = /^release: (\S+)$/mu.exec(versionOutput)?.[1];
  const commit = /^commit-hash: (\S+)$/mu.exec(versionOutput)?.[1];
  if (release !== inventory.toolchain.version || commit !== inventory.toolchain.commit) {
    throw new Error(
      "Rust standard-library notices do not cover the active compiler. Use the pinned toolchain or review updated toolchain notices."
    );
  }
}

/** @param {NativeInventory} inventory @param {ReturnType<typeof collectNativePackages>} packages @param {(file: string) => Buffer} readBytes */
export function validateNativeArtifacts(inventory, packages, readBytes) {
  const byKey = new Map(packages.map((entry) => [nativePackageKey(entry), entry]));
  for (const artifact of inventory.artifacts) {
    const entry = byKey.get(artifact.package);
    if (
      !entry ||
      sha256(readBytes(join(dirname(entry.manifestPath), artifact.path))) !== artifact.sha256
    ) {
      throw new Error(`Bundled native artifact changed or is missing: ${artifact.id}`);
    }
  }
}

/** @param {NativeInventory} inventory @param {Map<string, string>} texts */
export function renderNativeNotices(inventory, texts) {
  const files = [...texts.keys()].sort();
  const labels = new Map(files.map((file, index) => [file, `Native text ${index + 1}`]));
  /** @param {NativeText[]} refs */
  const references = (refs) =>
    refs
      .map((ref) => `${labels.get(ref.file)}: ${ref.original}\n  Text source: ${ref.source}`)
      .join("\n");
  const sections = [
    `Native dependency notices — ${inventory.target}\n\n` +
      "This reviewed inventory includes the locked Windows runtime dependency graph and a conservative set of build-support crates, including procedural macros. Build-support inclusion does not mean every crate is linked into the executable. All declared application features are covered.\n" +
      "The original, unmodified source for each Cargo package is available from its versioned source download below, including packages under the Mozilla Public License.\n" +
      "Other native targets are unverified. The separately installed WebView2 Runtime and Windows system components are not redistributed by this app. The WebView2 loader linked into the executable and Rust standard-library notices are listed separately.\n",
  ];
  for (const entry of [...inventory.packages].sort(comparePackages)) {
    sections.push(
      `${entry.name} ${entry.version}\nUsage: ${entry.usage}\nDeclared license: ${entry.license}\nReviewed license: ${entry.selectedLicense}\n` +
        `Source: https://crates.io/api/v1/crates/${entry.name}/${entry.version}/download\n${references(entry.texts)}`
    );
  }
  for (const entry of inventory.artifacts) {
    sections.push(
      `${entry.name} ${entry.version}\nLicense: ${entry.license}\nSource: ${entry.source}\n` +
        `Bundled by: ${entry.package} (${entry.path})\nProvenance: ${entry.provenance}\n${references(entry.texts)}`
    );
  }
  sections.push(
    `Rust standard library ${inventory.toolchain.version}\nSource commit: ${inventory.toolchain.commit}\nSource: ${inventory.toolchain.source}\n` +
      "The complete upstream standard-library copyright inventory is included as a conservative superset; it also describes other targets and build support. See its per-file exceptions and component license texts.\n" +
      `${references(inventory.toolchain.texts)}`
  );
  for (const file of files) sections.push(`${labels.get(file)}\n\n${texts.get(file)}`);
  return sections.join("\n\n" + "-".repeat(72) + "\n\n");
}
