import {
  MonitorError,
  isRecord,
  mapWithConcurrency,
  parseStableSemver,
  sanitizeReportField,
} from "./dependency-currency.mjs";
import { queryReleaseAdvisories } from "./dependency-release-audit.mjs";

export const RELEASE_REPOSITORY = "koagaroon/xml-prompt-studio";
const snapshotPaths = [
  "package-lock.json",
  "src-tauri/Cargo.lock",
  "licenses/native/manifest.json",
];
const cratesSource = "registry+https://github.com/rust-lang/crates.io-index";
const shaPattern = /^[0-9a-f]{40}$/u;
const npmNamePattern = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/u;

/** @typedef {{ ecosystem: "npm" | "crates.io", name: string, version: string }} ReleasePackage */
/** @typedef {{ npmLock: unknown, cargoLock: string, nativeInventory: unknown }} ReleaseSnapshot */

/** @param {unknown} data */
export function inspectWindowsRelease(data) {
  if (
    !isRecord(data) ||
    data.draft !== false ||
    data.prerelease !== false ||
    typeof data.tag_name !== "string" ||
    !/^v\d+\.\d+\.\d+$/u.test(data.tag_name) ||
    parseStableSemver(data.tag_name.slice(1)) === null ||
    typeof data.published_at !== "string" ||
    !Number.isFinite(Date.parse(data.published_at)) ||
    !Array.isArray(data.assets) ||
    data.assets.length > 100
  )
    throw new MonitorError("Latest stable Windows release metadata is invalid.");
  const assets = data.assets.filter(
    (asset) => isRecord(asset) && asset.name === "xml-prompt-studio.exe"
  );
  const asset = assets[0];
  if (
    assets.length !== 1 ||
    !isRecord(asset) ||
    asset.state !== "uploaded" ||
    !Number.isSafeInteger(asset.size) ||
    Number(asset.size) <= 0
  ) {
    throw new MonitorError("Latest stable release has no unique uploaded Windows executable.");
  }
  if (
    asset.digest != null &&
    (typeof asset.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(asset.digest))
  ) {
    throw new MonitorError("Published Windows executable digest is invalid.");
  }
  return {
    tag: data.tag_name,
    published: data.published_at,
    digest: asset.digest ?? "unavailable",
  };
}

/** @param {string} tag @param {(path: string) => Promise<unknown>} fetchGitHub */
export async function resolveReleaseCommit(tag, fetchGitHub) {
  const ref = await fetchGitHub(
    "/repos/" + RELEASE_REPOSITORY + "/git/ref/tags/" + encodeURIComponent(tag)
  );
  if (!isRecord(ref) || ref.ref !== "refs/tags/" + tag) {
    throw new MonitorError("The published release tag could not be verified.");
  }
  let object = ref.object;
  const seen = new Set();
  for (let depth = 0; depth < 6; depth += 1) {
    if (!isRecord(object) || typeof object.sha !== "string" || !shaPattern.test(object.sha)) {
      throw new MonitorError("Release tag has an invalid Git object identity.");
    }
    if (object.type === "commit") return object.sha;
    if (object.type !== "tag" || seen.has(object.sha)) {
      throw new MonitorError("Release tag does not resolve to a commit.");
    }
    seen.add(object.sha);
    const annotated = await fetchGitHub("/repos/" + RELEASE_REPOSITORY + "/git/tags/" + object.sha);
    if (!isRecord(annotated) || annotated.sha !== object.sha) {
      throw new MonitorError("Annotated release tag identity is inconsistent.");
    }
    object = annotated.object;
  }
  throw new MonitorError("Release tag exceeded the dereference limit.");
}

/** @param {unknown} data @param {string} path */
export function decodeSnapshotFile(data, path) {
  if (
    !isRecord(data) ||
    data.type !== "file" ||
    data.path !== path ||
    data.encoding !== "base64" ||
    typeof data.content !== "string" ||
    data.content.length > 3 * 1024 * 1024 ||
    !Number.isSafeInteger(data.size) ||
    Number(data.size) <= 0 ||
    Number(data.size) > 2 * 1024 * 1024
  ) {
    throw new MonitorError("Release snapshot file is missing, oversized, or invalid: " + path);
  }
  const content = data.content.replace(/[\r\n]/gu, "");
  const bytes = Buffer.from(content, "base64");
  if (bytes.toString("base64") !== content || bytes.length !== data.size) {
    throw new MonitorError("Release snapshot file encoding is invalid: " + path);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MonitorError("Release snapshot file is not UTF-8: " + path);
  }
}

/** @param {string} text */
function cargoLockedIdentities(text) {
  if (typeof text !== "string" || text.length > 2 * 1024 * 1024) {
    throw new MonitorError("Cargo release lock is not bounded text.");
  }
  const sections = text
    .replace(/\r\n/gu, "\n")
    .split(/^\[\[package\]\]\s*$/mu)
    .slice(1);
  if (sections.length === 0 || sections.length > 2000) {
    throw new MonitorError("Cargo release lock has an invalid package inventory.");
  }
  const identities = new Set();
  for (const section of sections) {
    const name = /^name = "([A-Za-z0-9_-]+)"$/mu.exec(section)?.[1];
    const version = /^version = "([^"]+)"$/mu.exec(section)?.[1];
    const source = /^source = "([^"]+)"$/mu.exec(section)?.[1];
    if (!name || parseStableSemver(version) === null) {
      throw new MonitorError("Cargo release lock contains an unsupported package identity.");
    }
    identities.add(JSON.stringify([name, version, source]));
  }
  return identities;
}

/** @param {ReleaseSnapshot} snapshot @returns {ReleasePackage[]} */
export function collectReleasePackages({ npmLock, cargoLock, nativeInventory }) {
  if (
    !isRecord(npmLock) ||
    npmLock.lockfileVersion !== 3 ||
    !isRecord(npmLock.packages) ||
    Object.keys(npmLock.packages).length > 5000 ||
    !isRecord(npmLock.packages[""]) ||
    !isRecord(npmLock.packages[""].dependencies) ||
    Object.keys(npmLock.packages[""].dependencies).length === 0
  ) {
    throw new MonitorError("Release npm lock has an invalid runtime inventory.");
  }
  for (const name of Object.keys(npmLock.packages[""].dependencies)) {
    const entry = npmLock.packages["node_modules/" + name];
    if (!isRecord(entry) || entry.dev)
      throw new MonitorError("Release npm runtime root is missing: " + name);
  }
  if (!isRecord(npmLock.packages["node_modules/vite"])) {
    throw new MonitorError("Release npm lock has no Vite emitted-helper identity.");
  }
  /** @type {Map<string, ReleasePackage>} */
  const packages = new Map();
  /** @param {ReleasePackage} entry */
  const add = (entry) =>
    packages.set(JSON.stringify([entry.ecosystem, entry.name, entry.version]), entry);
  for (const [path, value] of Object.entries(npmLock.packages)) {
    if (path === "") continue;
    if (!isRecord(value) || (value.dev !== undefined && typeof value.dev !== "boolean")) {
      throw new MonitorError("Release npm lock contains an invalid package entry.");
    }
    // Match the shipped notice scope, including Vite's generated modulepreload helper.
    if (value.dev === true && path !== "node_modules/vite") continue;
    const name = value.name ?? path.slice(path.lastIndexOf("node_modules/") + 13);
    if (
      !path.startsWith("node_modules/") ||
      typeof name !== "string" ||
      name.length > 214 ||
      !npmNamePattern.test(name) ||
      typeof value.version !== "string" ||
      parseStableSemver(value.version) === null ||
      typeof value.resolved !== "string" ||
      !value.resolved.startsWith("https://registry.npmjs.org/")
    ) {
      throw new MonitorError("Release npm runtime package identity or registry is unsupported.");
    }
    add({ ecosystem: "npm", name, version: value.version });
  }
  if (
    !isRecord(nativeInventory) ||
    nativeInventory.schemaVersion !== 1 ||
    nativeInventory.target !== "x86_64-pc-windows-msvc" ||
    nativeInventory.allFeatures !== true ||
    !Array.isArray(nativeInventory.packages) ||
    nativeInventory.packages.length === 0 ||
    nativeInventory.packages.length > 2000
  ) {
    throw new MonitorError("Release native inventory has an unsupported Windows coverage profile.");
  }
  const locked = cargoLockedIdentities(cargoLock);
  let runtimeCount = 0;
  for (const entry of nativeInventory.packages) {
    if (
      !isRecord(entry) ||
      !["runtime", "build-support"].includes(String(entry.usage)) ||
      typeof entry.name !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(entry.name) ||
      typeof entry.version !== "string" ||
      parseStableSemver(entry.version) === null ||
      entry.source !== cratesSource ||
      !locked.has(JSON.stringify([entry.name, entry.version, entry.source]))
    ) {
      throw new MonitorError(
        "Release native inventory does not match its locked Cargo identities."
      );
    }
    if (entry.usage === "runtime") {
      runtimeCount += 1;
      add({ ecosystem: "crates.io", name: entry.name, version: entry.version });
    }
  }
  if (runtimeCount === 0)
    throw new MonitorError("Release native inventory contains no runtime packages.");
  return [...packages.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** @param {ReleasePackage[]} released @param {ReleasePackage[]} development */
export function compareReleasePackages(released, development) {
  /** @param {ReleasePackage[]} entries */
  function group(entries) {
    /** @type {Map<string, Set<string>>} */
    const result = new Map();
    for (const entry of entries) {
      const key = entry.ecosystem + " " + entry.name;
      if (!result.has(key)) result.set(key, new Set());
      result.get(key)?.add(entry.version);
    }
    return result;
  }
  const previous = group(released);
  const current = group(development);
  return [...new Set([...previous.keys(), ...current.keys()])].sort().flatMap((name) => {
    const before = [...(previous.get(name) ?? [])].sort().join(", ") || "absent";
    const after = [...(current.get(name) ?? [])].sort().join(", ") || "absent";
    return before === after ? [] : [{ name, before, after }];
  });
}

/**
 * @param {ReleaseSnapshot} development
 * @param {string} revision
 * @param {{ fetchGitHub: (path: string) => Promise<unknown>, queryBatch: (payload: { queries: { package: { ecosystem: string, name: string }, version: string, page_token?: string }[] }) => Promise<unknown> }} requests
 * @returns {Promise<{ rows: import("./dependency-currency.mjs").CurrencyRow[], detail: string }>}
 */
export async function checkReleasedDependencies(development, revision, requests) {
  /** @type {import("./dependency-currency.mjs").CurrencyRow[]} */
  const rows = [];
  const lines = ["", "## Published Windows release", ""];
  let tag = "unknown";
  try {
    if (!shaPattern.test(revision))
      throw new MonitorError("Development checkout commit is unavailable.");
    const release = inspectWindowsRelease(
      await requests.fetchGitHub("/repos/" + RELEASE_REPOSITORY + "/releases/latest")
    );
    tag = release.tag;
    const commit = await resolveReleaseCommit(tag, requests.fetchGitHub);
    lines.push(
      "Latest stable: " + tag + " at " + commit + "; published " + release.published + ".",
      "Published asset: xml-prompt-studio.exe; GitHub digest: " + release.digest + ".",
      "Development comparison uses working-tree inputs based on " + revision + ".",
      "Tag and asset metadata identify the release; this check does not download or verify the executable.",
      ""
    );
    const files = await mapWithConcurrency(snapshotPaths, 3, async (path) =>
      decodeSnapshotFile(
        await requests.fetchGitHub(
          "/repos/" + RELEASE_REPOSITORY + "/contents/" + path + "?ref=" + commit
        ),
        path
      )
    );
    let snapshot;
    try {
      snapshot = {
        npmLock: JSON.parse(files[0]),
        cargoLock: files[1],
        nativeInventory: JSON.parse(files[2]),
      };
    } catch {
      throw new MonitorError("Release snapshot contains invalid JSON.");
    }
    const packages = collectReleasePackages(snapshot);
    const changes = compareReleasePackages(packages, collectReleasePackages(development));
    lines.push(
      "Compared npm runtime packages (including Vite's emitted helper) and reviewed Windows runtime crates.",
      "Unreleased package-version differences: " +
        changes.length +
        ". These are release-planning context, not release approval.",
      "",
      "| Component | Published release | Development checkout |",
      "| --- | --- | --- |"
    );
    for (const change of changes)
      lines.push(
        "| " +
          [change.name, change.before, change.after].map(sanitizeReportField).join(" | ") +
          " |"
      );
    lines.push(
      "",
      "### Released dependency advisories",
      "",
      "OSV queries exact released npm/crates.io versions. Matches require applicability review; absence of matches is not a security guarantee.",
      "Matches may include maintenance notices. Vite is included for its emitted helper only; package-level advisories can concern development functionality that is not shipped.",
      "Coverage excludes Rust standard-library code, bundled non-package assets, the external WebView2 runtime, build-only packages, and older/prerelease releases. Current full-build npm audits and Dependabot alerts remain separate.",
      ""
    );
    const matches = (await queryReleaseAdvisories(packages, requests.queryBatch)).filter(
      (entry) => entry.advisories.length > 0
    );
    rows.push({
      ecosystem: "Released advisories",
      dependency: tag + " Windows runtime packages",
      locked: commit,
      latest: matches.length + " package matches",
      status: matches.length ? "actionable" : "current",
      reason: matches.length
        ? "OSV package matches need applicability review; they may concern maintenance notices or unshipped code. See release details."
        : "No OSV matches for " +
          packages.length +
          " released package versions; bounded scope, not proof of safety.",
    });
    lines.push(
      "Queried " +
        packages.length +
        " package versions; " +
        matches.length +
        " have advisory matches."
    );
    for (const entry of matches) {
      lines.push(
        "- " +
          sanitizeReportField(entry.ecosystem + " " + entry.name + "@" + entry.version) +
          ": " +
          entry.advisories
            .map(
              (id) => "[" + id + "](https://osv.dev/vulnerability/" + encodeURIComponent(id) + ")"
            )
            .join(", ")
      );
    }
  } catch (error) {
    const reason =
      error instanceof MonitorError
        ? error.message
        : "Released dependency inspection failed unexpectedly.";
    rows.push({
      ecosystem: "Released advisories",
      dependency: tag + " Windows release",
      locked: "unknown",
      latest: "unknown",
      status: "error",
      reason,
    });
    lines.push("Release inspection incomplete: " + sanitizeReportField(reason));
  }
  const detail = lines.join("\n") + "\n";
  if (Buffer.byteLength(detail, "utf8") > 192 * 1024) {
    return {
      rows: [
        {
          ecosystem: "Released advisories",
          dependency: tag,
          locked: "unknown",
          latest: "unknown",
          status: "error",
          reason: "Released dependency report exceeded its size limit.",
        },
      ],
      detail: "\nRelease detail exceeded its size limit; no clean result was produced.\n",
    };
  }
  return { rows, detail };
}
