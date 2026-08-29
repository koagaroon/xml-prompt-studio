const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/u;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const ACTION_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const CRATES_IO_SOURCE_IDS = new Set([
  "registry+https://github.com/rust-lang/crates.io-index",
  "sparse+https://index.crates.io/",
]);

export class MonitorError extends Error {
  constructor(message) {
    super(message);
    this.name = "MonitorError";
  }
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseStableSemver(value) {
  if (typeof value !== "string" || value.length > 128) return null;
  const match = SEMVER_PATTERN.exec(value);
  if (match === null || match[4] !== undefined) return null;
  const parts = match.slice(1, 4).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return { raw: value, major: parts[0], minor: parts[1], patch: parts[2] };
}

export function compareSemver(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

export function newestStable(versions, major = null) {
  let newest = null;
  for (const value of versions) {
    const parsed = parseStableSemver(value);
    if (parsed === null || (major !== null && parsed.major !== major)) continue;
    if (newest === null || compareSemver(parsed, newest) > 0) newest = parsed;
  }
  return newest?.raw ?? null;
}

export function parseNpmAlias(value) {
  if (typeof value !== "string" || !value.startsWith("npm:")) return null;
  const target = value.slice(4);
  const separator = target.lastIndexOf("@");
  if (separator <= 0) throw new MonitorError(`Unsupported npm alias: ${value}`);
  const registryName = target.slice(0, separator);
  const range = target.slice(separator + 1);
  if (!PACKAGE_NAME_PATTERN.test(registryName) || range.length === 0) {
    throw new MonitorError(`Unsupported npm alias: ${value}`);
  }
  return { registryName, range };
}

function lockPackageName(path, metadata) {
  if (typeof metadata.name === "string") return metadata.name;
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  return index === -1 ? path : path.slice(index + marker.length);
}

export function collectNpmTargets(packageJson, lockfile) {
  if (!isRecord(packageJson) || !isRecord(lockfile) || !isRecord(lockfile.packages)) {
    throw new MonitorError("package.json or package-lock.json has an invalid shape.");
  }
  const lockRoot = lockfile.packages[""];
  if (!isRecord(lockRoot)) throw new MonitorError("package-lock.json has no root package entry.");

  const targetsByName = new Map();
  for (const [section, kind] of [
    ["dependencies", "runtime"],
    ["devDependencies", "development"],
    ["optionalDependencies", "optional"],
    ["peerDependencies", "peer"],
  ]) {
    const declared = packageJson[section];
    const lockedDeclarations = lockRoot[section];
    if (declared === undefined && lockedDeclarations === undefined) continue;
    if (
      isRecord(declared) &&
      Object.keys(declared).length === 0 &&
      lockedDeclarations === undefined
    ) {
      continue;
    }
    if (!isRecord(declared) || !isRecord(lockedDeclarations)) {
      throw new MonitorError(`${section} is missing from package.json or its lockfile root.`);
    }
    for (const [declaredName, requested] of Object.entries(declared)) {
      if (!PACKAGE_NAME_PATTERN.test(declaredName) || typeof requested !== "string") {
        throw new MonitorError(`Invalid npm dependency declaration in ${section}.`);
      }
      if (lockedDeclarations[declaredName] !== requested) {
        throw new MonitorError(`package-lock.json does not match ${section}.${declaredName}.`);
      }
      const alias = parseNpmAlias(requested);
      const registryName = alias?.registryName ?? declaredName;
      const lockEntry = lockfile.packages[`node_modules/${declaredName}`];
      if (!isRecord(lockEntry) || parseStableSemver(lockEntry.version) === null) {
        throw new MonitorError(`No stable locked version was found for ${declaredName}.`);
      }
      if (alias !== null && lockEntry.name !== registryName) {
        throw new MonitorError(`The lockfile identity for npm alias ${declaredName} is invalid.`);
      }
      const target = {
        declaredName,
        registryName,
        requested,
        locked: String(lockEntry.version),
        kind,
        major: null,
      };
      const existing = targetsByName.get(declaredName);
      if (
        existing !== undefined &&
        (existing.registryName !== target.registryName ||
          existing.requested !== target.requested ||
          existing.locked !== target.locked)
      ) {
        throw new MonitorError(
          `Direct npm dependency ${declaredName} has conflicting declarations.`
        );
      }
      targetsByName.set(declaredName, {
        ...(existing ?? target),
        kind: [...new Set([...(existing?.kind.split(" + ") ?? []), kind])].sort().join(" + "),
      });
    }
  }

  const targets = [...targetsByName.values()];

  const compatibilityAlias = targets.find(
    (target) => target.registryName === "@typescript/typescript6"
  );
  if (compatibilityAlias !== undefined) {
    const effectiveCompiler = lockfile.packages["node_modules/@typescript/old"];
    if (
      !isRecord(effectiveCompiler) ||
      effectiveCompiler.name !== "typescript" ||
      parseStableSemver(effectiveCompiler.version) === null
    ) {
      throw new MonitorError("The TypeScript 6 compatibility compiler lock entry is invalid.");
    }
    targets.push({
      declaredName: "typescript (effective TS6 compiler)",
      registryName: "typescript",
      requested: "major 6",
      locked: String(effectiveCompiler.version),
      kind: "toolchain",
      major: 6,
    });
  }

  return targets.sort((left, right) => left.declaredName.localeCompare(right.declaredName));
}

export function inspectNpmMetadata(metadata, expectedName, major = null) {
  if (
    !isRecord(metadata) ||
    metadata.name !== expectedName ||
    !isRecord(metadata["dist-tags"]) ||
    !isRecord(metadata.versions)
  ) {
    throw new MonitorError(`npm returned invalid metadata for ${expectedName}.`);
  }
  const latest =
    major === null
      ? metadata["dist-tags"].latest
      : newestStable(
          Object.entries(metadata.versions)
            .filter(([, entry]) => isRecord(entry) && typeof entry.deprecated !== "string")
            .map(([version]) => version),
          major
        );
  if (typeof latest !== "string" || parseStableSemver(latest) === null) {
    throw new MonitorError(`npm latest is not a stable release for ${expectedName}.`);
  }
  const selected = metadata.versions[latest];
  if (
    !isRecord(selected) ||
    selected.name !== expectedName ||
    selected.version !== latest ||
    typeof selected.deprecated === "string"
  ) {
    throw new MonitorError(`npm latest metadata is unusable for ${expectedName}.`);
  }
  return latest;
}

export function classifyVersion(locked, latest, currentReason = "Current stable release.") {
  const lockedVersion = parseStableSemver(locked);
  const latestVersion = parseStableSemver(latest);
  if (lockedVersion === null || latestVersion === null) {
    return { status: "error", reason: "A compared version is not stable semantic versioning." };
  }
  const comparison = compareSemver(lockedVersion, latestVersion);
  if (comparison < 0)
    return { status: "actionable", reason: "A newer stable release is available." };
  if (comparison > 0) {
    return { status: "error", reason: "The locked version is newer than registry metadata." };
  }
  return { status: "current", reason: currentReason };
}

export function validateInstallScriptPolicy(packageJson, lockfile, npmrc) {
  if (!isRecord(packageJson) || !isRecord(packageJson.allowScripts)) {
    throw new MonitorError("package.json must contain an allowScripts object.");
  }
  const strictAssignments =
    typeof npmrc === "string"
      ? npmrc
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith(";"))
          .map((line) => /^strict-allow-scripts\s*=\s*(\S+)\s*$/iu.exec(line))
          .filter((match) => match !== null)
          .map((match) => match[1].toLowerCase())
      : [];
  if (strictAssignments.length !== 1 || strictAssignments[0] !== "true") {
    throw new MonitorError(".npmrc must enable strict-allow-scripts.");
  }
  if (!isRecord(lockfile) || !isRecord(lockfile.packages)) {
    throw new MonitorError("package-lock.json has no packages map.");
  }

  const locked = [];
  for (const [path, metadata] of Object.entries(lockfile.packages)) {
    if (path === "" || !isRecord(metadata) || metadata.hasInstallScript !== true) continue;
    if (parseStableSemver(metadata.version) === null) {
      throw new MonitorError(`Install-script package ${path} has no stable locked version.`);
    }
    locked.push(`${lockPackageName(path, metadata)}@${metadata.version}`);
  }
  const allowed = Object.entries(packageJson.allowScripts).map(([packageId, enabled]) => {
    if (enabled !== true)
      throw new MonitorError(`Install-script approval ${packageId} is not true.`);
    return packageId;
  });
  locked.sort();
  allowed.sort();
  if (JSON.stringify(locked) !== JSON.stringify(allowed)) {
    throw new MonitorError(
      `allowScripts differs from locked install scripts (allowed: ${allowed.join(", ") || "none"}; locked: ${locked.join(", ") || "none"}).`
    );
  }
  return locked;
}

export function parseRustVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?$/u.exec(value);
  if (match === null) return null;
  const parts = [match[1], match[2] ?? "0", match[3] ?? "0"].map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return { raw: value, major: parts[0], minor: parts[1], patch: parts[2] };
}

export function parseProjectMsrv(manifestText) {
  if (typeof manifestText !== "string") throw new MonitorError("Cargo.toml is not text.");
  const packageStart = /^\[package\]\s*$/mu.exec(manifestText);
  const packageBody =
    packageStart === null ? "" : manifestText.slice(packageStart.index + packageStart[0].length);
  const nextSection = /^\[[^\]]+\]\s*$/mu.exec(packageBody);
  const packageSection =
    packageStart === null
      ? undefined
      : packageBody.slice(0, nextSection === null ? undefined : nextSection.index);
  const value =
    packageSection === undefined
      ? undefined
      : /^rust-version\s*=\s*"([^"]+)"\s*(?:#.*)?$/mu.exec(packageSection)?.[1];
  const parsed = parseRustVersion(value);
  if (parsed === null) throw new MonitorError("Cargo.toml has no valid package rust-version.");
  return parsed;
}

function cargoUpperBound(base, operator) {
  if (operator === "~") return { major: base.major, minor: base.minor + 1, patch: 0 };
  if (base.major > 0) return { major: base.major + 1, minor: 0, patch: 0 };
  if (base.minor > 0) return { major: 0, minor: base.minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: base.patch + 1 };
}

export function satisfiesCargoRequirement(version, requirement) {
  const candidate = parseStableSemver(version);
  if (candidate === null || typeof requirement !== "string") return false;
  const match = /^(=|\^|~)?\s*(\d+)\.(\d+)\.(\d+)$/u.exec(requirement.trim());
  if (match === null)
    throw new MonitorError(`Unsupported Cargo version requirement: ${requirement}.`);
  const base = {
    major: Number(match[2]),
    minor: Number(match[3]),
    patch: Number(match[4]),
  };
  if (match[1] === "=") return compareSemver(candidate, base) === 0;
  const upper = cargoUpperBound(base, match[1] ?? "^");
  return compareSemver(candidate, base) >= 0 && compareSemver(candidate, upper) < 0;
}

export function satisfiesNpmRequirement(version, requirement) {
  const candidate = parseStableSemver(version);
  if (candidate === null || typeof requirement !== "string") return false;
  const match = /^(\^|~)?(\d+)\.(\d+)\.(\d+)$/u.exec(requirement.trim());
  if (match === null) {
    throw new MonitorError(`Unsupported npm version requirement: ${requirement}.`);
  }
  const base = {
    major: Number(match[2]),
    minor: Number(match[3]),
    patch: Number(match[4]),
  };
  if (match[1] === undefined) return compareSemver(candidate, base) === 0;
  const upper = cargoUpperBound(base, match[1]);
  return compareSemver(candidate, base) >= 0 && compareSemver(candidate, upper) < 0;
}

export function collectCargoTargets(metadata) {
  if (
    !isRecord(metadata) ||
    metadata.version !== 1 ||
    !Array.isArray(metadata.packages) ||
    !isRecord(metadata.resolve) ||
    typeof metadata.resolve.root !== "string" ||
    !Array.isArray(metadata.resolve.nodes)
  ) {
    throw new MonitorError("cargo metadata returned an invalid format-version 1 document.");
  }

  const packageById = new Map();
  for (const packageEntry of metadata.packages) {
    if (!isRecord(packageEntry) || typeof packageEntry.id !== "string") {
      throw new MonitorError("cargo metadata returned an invalid package entry.");
    }
    packageById.set(packageEntry.id, packageEntry);
  }

  const rootPackage = packageById.get(metadata.resolve.root);
  const rootNode = metadata.resolve.nodes.find(
    (node) => isRecord(node) && node.id === metadata.resolve.root
  );
  if (
    !isRecord(rootPackage) ||
    !Array.isArray(rootPackage.dependencies) ||
    !isRecord(rootNode) ||
    !Array.isArray(rootNode.deps)
  ) {
    throw new MonitorError("cargo metadata is missing the root package or its resolve node.");
  }

  const declarationsByRegistryName = new Map();
  for (const dependency of rootPackage.dependencies) {
    if (!isRecord(dependency)) {
      throw new MonitorError("cargo metadata returned an invalid dependency declaration.");
    }
    if (typeof dependency.source !== "string") {
      throw new MonitorError(
        `Direct Cargo dependency ${String(dependency.name)} is not a registry dependency.`
      );
    }
    if (!CRATES_IO_SOURCE_IDS.has(dependency.source)) {
      throw new MonitorError(
        `Direct Cargo dependency ${String(dependency.name)} is not from crates.io.`
      );
    }
    if (dependency.optional === true) {
      throw new MonitorError(
        `Optional Cargo dependency ${String(dependency.name)} has no guaranteed locked edge.`
      );
    }
    if (
      typeof dependency.name !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(dependency.name) ||
      typeof dependency.req !== "string" ||
      (dependency.rename !== null &&
        dependency.rename !== undefined &&
        typeof dependency.rename !== "string") ||
      ![null, "build", "dev"].includes(dependency.kind)
    ) {
      throw new MonitorError("cargo metadata returned an invalid direct dependency.");
    }
    const declaredName = dependency.rename ?? dependency.name;
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(declaredName)) {
      throw new MonitorError("cargo metadata returned an invalid renamed dependency.");
    }
    const section =
      dependency.kind === "build"
        ? "build-dependencies"
        : dependency.kind === "dev"
          ? "dev-dependencies"
          : "dependencies";
    const existing = declarationsByRegistryName.get(dependency.name);
    if (
      existing !== undefined &&
      (existing.declaredName !== declaredName ||
        existing.requested !== dependency.req ||
        existing.section !== section)
    ) {
      throw new MonitorError(
        `Direct Cargo dependency ${dependency.name} has conflicting declarations.`
      );
    }
    declarationsByRegistryName.set(dependency.name, {
      declaredName,
      registryName: dependency.name,
      requested: dependency.req,
      section,
    });
  }

  const targetsByRegistryName = new Map();
  for (const dependencyEdge of rootNode.deps) {
    if (!isRecord(dependencyEdge) || typeof dependencyEdge.pkg !== "string") {
      throw new MonitorError("cargo metadata returned an invalid direct dependency edge.");
    }
    const lockedPackage = packageById.get(dependencyEdge.pkg);
    if (!isRecord(lockedPackage) || typeof lockedPackage.source !== "string") continue;
    if (!CRATES_IO_SOURCE_IDS.has(lockedPackage.source)) {
      throw new MonitorError(
        `Resolved Cargo dependency ${String(lockedPackage.name)} is not from crates.io.`
      );
    }
    if (
      typeof lockedPackage.name !== "string" ||
      typeof lockedPackage.version !== "string" ||
      parseStableSemver(lockedPackage.version) === null
    ) {
      throw new MonitorError("cargo metadata returned an invalid locked direct crate.");
    }
    const declaration = declarationsByRegistryName.get(lockedPackage.name);
    if (declaration === undefined) {
      throw new MonitorError(
        `Resolved Cargo dependency ${lockedPackage.name} has no root declaration.`
      );
    }
    if (!satisfiesCargoRequirement(lockedPackage.version, declaration.requested)) {
      throw new MonitorError(
        `Resolved Cargo dependency ${lockedPackage.name} does not satisfy its root declaration.`
      );
    }
    const existing = targetsByRegistryName.get(lockedPackage.name);
    if (existing !== undefined && existing.locked !== lockedPackage.version) {
      throw new MonitorError(
        `Direct Cargo dependency ${lockedPackage.name} resolves to multiple versions.`
      );
    }
    targetsByRegistryName.set(lockedPackage.name, {
      ...declaration,
      locked: lockedPackage.version,
    });
  }

  for (const registryName of declarationsByRegistryName.keys()) {
    if (!targetsByRegistryName.has(registryName)) {
      throw new MonitorError(`Direct Cargo dependency ${registryName} has no locked root edge.`);
    }
  }
  return [...targetsByRegistryName.values()].sort((left, right) =>
    left.declaredName.localeCompare(right.declaredName)
  );
}

export function inspectCratesMetadata(metadata, expectedName, projectMsrv) {
  if (!isRecord(metadata) || !isRecord(metadata.crate) || !Array.isArray(metadata.versions)) {
    throw new MonitorError(`crates.io returned invalid metadata for ${expectedName}.`);
  }
  if (String(metadata.crate.id).toLowerCase() !== expectedName.toLowerCase()) {
    throw new MonitorError(`crates.io returned the wrong crate for ${expectedName}.`);
  }
  if (parseRustVersion(projectMsrv?.raw) === null) {
    throw new MonitorError("The project MSRV is invalid.");
  }
  if (metadata.versions.length === 0 || metadata.versions.length > 10_000) {
    throw new MonitorError(`crates.io returned an invalid version list for ${expectedName}.`);
  }
  const versions = [];
  for (const entry of metadata.versions) {
    if (
      !isRecord(entry) ||
      typeof entry.num !== "string" ||
      !SEMVER_PATTERN.test(entry.num) ||
      typeof entry.yanked !== "boolean" ||
      (entry.rust_version !== null &&
        entry.rust_version !== undefined &&
        parseRustVersion(entry.rust_version) === null)
    ) {
      throw new MonitorError(`crates.io returned an invalid release entry for ${expectedName}.`);
    }
    if (entry.yanked || parseStableSemver(entry.num) === null) continue;
    versions.push({
      version: entry.num,
      rustVersion:
        typeof entry.rust_version === "string" ? parseRustVersion(entry.rust_version) : null,
    });
  }
  const latest = newestStable(versions.map((entry) => entry.version));
  if (latest === null)
    throw new MonitorError(`crates.io returned no stable release for ${expectedName}.`);
  const compatibleLatest = newestStable(
    versions
      .filter(
        (entry) => entry.rustVersion === null || compareSemver(entry.rustVersion, projectMsrv) <= 0
      )
      .map((entry) => entry.version)
  );
  if (compatibleLatest === null) {
    throw new MonitorError(`No stable ${expectedName} release supports Rust ${projectMsrv.raw}.`);
  }
  const latestEntry = versions.find((entry) => entry.version === latest);
  const candidateEntry = versions.find((entry) => entry.version === compatibleLatest);
  return {
    latest,
    compatibleLatest,
    latestRustVersion: latestEntry?.rustVersion?.raw ?? null,
    candidateRustVersion: candidateEntry?.rustVersion?.raw ?? null,
  };
}

export function classifyCargoCurrency(locked, inspection, projectMsrv) {
  const lockedVersion = parseStableSemver(locked);
  const candidate = parseStableSemver(inspection.compatibleLatest);
  const globalLatest = parseStableSemver(inspection.latest);
  if (lockedVersion === null || candidate === null || globalLatest === null) {
    return { latest: "unknown", status: "error", reason: "Cargo metadata is inconsistent." };
  }
  if (compareSemver(lockedVersion, candidate) > 0) {
    return {
      latest: inspection.compatibleLatest,
      status: "error",
      reason: `The locked release is not supported by the Rust ${projectMsrv} compatibility result.`,
    };
  }
  const newerIncompatible = compareSemver(globalLatest, candidate) > 0;
  if (compareSemver(lockedVersion, candidate) < 0) {
    const unknownNote =
      inspection.candidateRustVersion === null
        ? " The publisher omits rust_version."
        : " Direct crate metadata is compatible with the project MSRV.";
    const heldNote = newerIncompatible
      ? ` Newer ${inspection.latest} is held because it requires Rust ${inspection.latestRustVersion}, above project MSRV ${projectMsrv}.`
      : "";
    return {
      latest: inspection.compatibleLatest,
      status: "actionable",
      reason: `A newer stable release is available.${unknownNote} The exact resolved graph must be verified at Rust ${projectMsrv}.${heldNote}`,
    };
  }
  if (newerIncompatible) {
    return {
      latest: inspection.latest,
      status: "hold",
      reason: `The newer stable release requires Rust ${inspection.latestRustVersion}, above project MSRV ${projectMsrv}.`,
    };
  }
  return {
    latest: inspection.latest,
    status: "current",
    reason:
      inspection.candidateRustVersion === null
        ? `Current stable release; the publisher omits rust_version, while CI independently enforces the locked graph at Rust ${projectMsrv}.`
        : `Current stable release; direct crate metadata is compatible and CI independently enforces the locked graph at Rust ${projectMsrv}.`,
  };
}

export function parseActionReferences(sources) {
  const actions = new Map();
  const errors = [];
  for (const source of [...sources].sort((left, right) => left.path.localeCompare(right.path))) {
    if (typeof source.path !== "string" || typeof source.content !== "string") {
      throw new MonitorError("Workflow source has an invalid shape.");
    }
    const lines = source.content.split(/\r?\n/u);
    let blockScalarParentIndent = null;
    for (const [offset, line] of lines.entries()) {
      const lineIndent = /^\s*/u.exec(line)?.[0].length ?? 0;
      if (blockScalarParentIndent !== null) {
        if (line.trim() === "" || lineIndent > blockScalarParentIndent) continue;
        blockScalarParentIndent = null;
      }
      if (/^\s*(?:-\s*)?[A-Za-z0-9_-]+:\s*[|>][+-]?\s*(?:#.*)?$/u.test(line)) {
        blockScalarParentIndent = lineIndent;
        continue;
      }
      const match =
        /^\s*(?:-\s*)?uses:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*(?:#\s*(\S+))?\s*$/u.exec(line);
      if (match === null) {
        let unquotedUsesKey = false;
        let singleQuoted = false;
        let doubleQuoted = false;
        for (let position = 0; position < line.length; position += 1) {
          const character = line[position];
          if (doubleQuoted && character === "\\") {
            position += 1;
            continue;
          }
          if (!doubleQuoted && character === "'") {
            if (singleQuoted && line[position + 1] === "'") {
              position += 1;
              continue;
            }
            singleQuoted = !singleQuoted;
            continue;
          }
          if (!singleQuoted && character === '"') {
            doubleQuoted = !doubleQuoted;
            continue;
          }
          if (singleQuoted || doubleQuoted) continue;
          if (character === "#") break;
          if (line.slice(position, position + 4) !== "uses") continue;
          const before = line.slice(0, position).trim();
          const after = line.slice(position + 4);
          if (!/^\s*:/u.test(after)) continue;
          if (before === "" || before === "-" || before.endsWith("{") || before.endsWith(",")) {
            unquotedUsesKey = true;
            break;
          }
        }
        const quotedUsesKey = /^\s*(?:-\s*)?(?:"uses"|'uses')\s*:/u.test(line);
        if (unquotedUsesKey || quotedUsesKey) {
          errors.push({
            dependency: "unsupported uses syntax",
            location: `${source.path}:${offset + 1}`,
            reason: "A uses key could not be parsed safely.",
          });
        }
        continue;
      }
      const reference = match[1] ?? match[2] ?? match[3];
      if (reference.startsWith("./") || reference.startsWith("docker://")) continue;
      const separator = reference.lastIndexOf("@");
      const identifier = separator === -1 ? reference : reference.slice(0, separator);
      const pin = separator === -1 ? "" : reference.slice(separator + 1);
      const parts = identifier.split("/");
      const repository = parts.slice(0, 2).join("/");
      const declaredTag = match[4] ?? "";
      const location = `${source.path}:${offset + 1}`;
      if (
        parts.length < 2 ||
        !parts.slice(0, 2).every((part) => /^[A-Za-z0-9_.-]+$/u.test(part)) ||
        !FULL_SHA_PATTERN.test(pin) ||
        ACTION_TAG_PATTERN.exec(declaredTag) === null
      ) {
        errors.push({
          dependency: identifier || reference,
          location,
          reason:
            "External actions must use a full commit SHA followed by a stable vX.Y.Z comment.",
        });
        continue;
      }
      const existing = actions.get(repository);
      if (
        existing !== undefined &&
        (existing.pin !== pin.toLowerCase() || existing.declaredTag !== declaredTag)
      ) {
        errors.push({
          dependency: repository,
          location,
          reason: "The same action repository is pinned inconsistently across workflow files.",
        });
        continue;
      }
      actions.set(repository, {
        identifier: existing?.identifier ?? identifier,
        repository,
        pin: pin.toLowerCase(),
        declaredTag,
        locations: [...(existing?.locations ?? []), location],
      });
    }
  }
  const targets = [...actions.values()];
  targets.sort((left, right) => left.identifier.localeCompare(right.identifier));
  errors.sort((left, right) => left.location.localeCompare(right.location));
  return { targets, errors };
}

export function inspectGitHubReleases(releases) {
  if (!Array.isArray(releases) || releases.length === 0 || releases.length > 100) {
    throw new MonitorError("GitHub returned invalid release metadata.");
  }
  const stableTags = [];
  for (const release of releases) {
    if (
      !isRecord(release) ||
      typeof release.draft !== "boolean" ||
      typeof release.prerelease !== "boolean" ||
      typeof release.tag_name !== "string" ||
      release.tag_name.length > 128
    ) {
      throw new MonitorError("GitHub returned an invalid action release entry.");
    }
    if (!release.draft && !release.prerelease && ACTION_TAG_PATTERN.test(release.tag_name)) {
      stableTags.push(release.tag_name);
    }
  }
  const latestVersion = newestStable(stableTags.map((tag) => tag.slice(1)));
  if (latestVersion === null) throw new MonitorError("GitHub returned no stable action release.");
  return `v${latestVersion}`;
}

export function classifyActionCurrency(action, declaredSha, latestTag, latestSha) {
  if (!FULL_SHA_PATTERN.test(declaredSha) || !FULL_SHA_PATTERN.test(latestSha)) {
    return { status: "error", reason: "GitHub did not resolve an action tag to a commit SHA." };
  }
  if (action.pin.toLowerCase() !== declaredSha.toLowerCase()) {
    return {
      status: "error",
      reason: "The action tag comment does not resolve to the pinned SHA.",
    };
  }
  const declared = parseStableSemver(action.declaredTag.slice(1));
  const latest = parseStableSemver(latestTag.slice(1));
  if (declared === null || latest === null) {
    return { status: "error", reason: "An action release tag is not stable semantic versioning." };
  }
  const comparison = compareSemver(declared, latest);
  if (comparison < 0) {
    return { status: "actionable", reason: `Update the pin and comment to ${latestTag}.` };
  }
  if (comparison > 0) {
    return { status: "error", reason: "The declared action tag is newer than GitHub metadata." };
  }
  if (action.pin.toLowerCase() !== latestSha.toLowerCase()) {
    return {
      status: "error",
      reason: "The latest action tag no longer resolves to the pinned SHA.",
    };
  }
  return { status: "current", reason: "Current stable action tag and commit." };
}

export function findRolldownLock(lockfile) {
  if (!isRecord(lockfile) || !isRecord(lockfile.packages)) {
    throw new MonitorError("package-lock.json has no packages map.");
  }
  const vite = lockfile.packages["node_modules/vite"];
  if (
    !isRecord(vite) ||
    !isRecord(vite.dependencies) ||
    typeof vite.dependencies.rolldown !== "string"
  ) {
    throw new MonitorError("The Vite lock entry does not reference Rolldown.");
  }
  const nested = lockfile.packages["node_modules/vite/node_modules/rolldown"];
  const root = lockfile.packages["node_modules/rolldown"];
  const resolved = isRecord(nested) ? nested : root;
  if (!isRecord(resolved) || parseStableSemver(resolved.version) === null) {
    throw new MonitorError("The Vite-scoped Rolldown lock entry is invalid.");
  }
  const requested = String(vite.dependencies.rolldown);
  const locked = String(resolved.version);
  if (!satisfiesNpmRequirement(locked, requested)) {
    throw new MonitorError("The Vite-scoped Rolldown lock entry is outside Vite's requirement.");
  }
  return { locked, requested };
}

export function inspectNpmRangeMetadata(metadata, expectedName, requirement) {
  inspectNpmMetadata(metadata, expectedName);
  const candidates = Object.entries(metadata.versions)
    .filter(
      ([version, entry]) =>
        isRecord(entry) &&
        typeof entry.deprecated !== "string" &&
        parseStableSemver(version) !== null &&
        satisfiesNpmRequirement(version, requirement)
    )
    .map(([version]) => version);
  const latest = newestStable(candidates);
  if (latest === null) {
    throw new MonitorError(`npm returned no stable ${expectedName} release in ${requirement}.`);
  }
  const selected = metadata.versions[latest];
  if (!isRecord(selected) || selected.name !== expectedName || selected.version !== latest) {
    throw new MonitorError(`npm range metadata is unusable for ${expectedName}.`);
  }
  return latest;
}

export function inspectRolldownRelease(metadata, version) {
  if (!isRecord(metadata) || metadata.name !== "rolldown" || !isRecord(metadata.versions)) {
    throw new MonitorError("npm returned invalid Rolldown metadata.");
  }
  const release = metadata.versions[version];
  if (!isRecord(release) || !isRecord(release.optionalDependencies)) {
    throw new MonitorError(`Rolldown ${version} has no optional dependency metadata.`);
  }
  const nativeBindings = Object.entries(release.optionalDependencies)
    .filter(([name]) => name.startsWith("@rolldown/binding-"))
    .map(([name, expectedVersion]) => {
      if (typeof expectedVersion !== "string" || parseStableSemver(expectedVersion) === null) {
        throw new MonitorError(`Rolldown ${version} has invalid native binding metadata.`);
      }
      return `${name}@${expectedVersion}`;
    })
    .sort();
  if (nativeBindings.length === 0 || nativeBindings.length > 64) {
    throw new MonitorError(`Rolldown ${version} has an invalid native binding count.`);
  }
  return nativeBindings;
}

export function inspectPublishedBinding(metadata, expectedIdentity) {
  const separator = expectedIdentity.lastIndexOf("@");
  const expectedName = expectedIdentity.slice(0, separator);
  const expectedVersion = expectedIdentity.slice(separator + 1);
  return (
    isRecord(metadata) &&
    metadata.name === expectedName &&
    metadata.version === expectedVersion &&
    isRecord(metadata.dist) &&
    typeof metadata.dist.integrity === "string" &&
    metadata.dist.integrity.trim() !== ""
  );
}

export function classifyRolldownCurrency({
  locked,
  latest,
  lockedBindings,
  latestBindings,
  publishedBindings,
}) {
  const base = classifyVersion(locked, latest, "Current stable Rolldown release.");
  if (base.status === "error") return base;
  const published = new Set(publishedBindings);
  const missingLocked = [...lockedBindings].filter((binding) => !published.has(binding)).sort();
  if (missingLocked.length > 0) {
    return {
      status: "error",
      reason: `Locked Rolldown ${locked} references unavailable native packages: ${missingLocked.join(", ")}.`,
    };
  }
  const missingLatest = [...latestBindings].filter((binding) => !published.has(binding)).sort();
  if (missingLatest.length > 0) {
    return {
      status: "hold",
      reason: `Rolldown ${latest} references unpublished native packages: ${missingLatest.join(", ")}.`,
    };
  }
  return base;
}

export function reportExitCode(rows) {
  if (rows.some((row) => row.status === "error")) return 2;
  if (rows.some((row) => row.status === "actionable")) return 1;
  return 0;
}

export function sanitizeReportField(value) {
  const flattened = String(value)
    .replace(/[\r\n]+/gu, " ")
    .replace(/\\/gu, "\\\\")
    .replace(/\|/gu, "\\|")
    .replace(/`/gu, "\\`")
    .replace(/\[/gu, "\\[")
    .replace(/\]/gu, "\\]")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .trim();
  return flattened.length <= 240 ? flattened : `${flattened.slice(0, 239)}…`;
}

export function renderReport(rows) {
  if (!Array.isArray(rows) || rows.length > 100) {
    throw new MonitorError("Dependency report exceeds the 100-row safety limit.");
  }
  const statusOrder = { error: 0, actionable: 1, hold: 2, current: 3 };
  if (rows.some((row) => !Object.hasOwn(statusOrder, row.status))) {
    throw new MonitorError("Dependency report contains an invalid status.");
  }
  const sorted = [...rows].sort(
    (left, right) =>
      statusOrder[left.status] - statusOrder[right.status] ||
      left.ecosystem.localeCompare(right.ecosystem) ||
      left.dependency.localeCompare(right.dependency)
  );
  const counts = Object.fromEntries(
    ["current", "actionable", "hold", "error"].map((status) => [
      status,
      sorted.filter((row) => row.status === status).length,
    ])
  );
  const lines = [
    "# Dependency Watch",
    "",
    `current=${counts.current} actionable=${counts.actionable} hold=${counts.hold} error=${counts.error}`,
    "",
    "| Status | Ecosystem | Dependency | Locked | Latest | Detail |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of sorted) {
    lines.push(
      `| ${sanitizeReportField(row.status)} | ${sanitizeReportField(row.ecosystem)} | ${sanitizeReportField(row.dependency)} | ${sanitizeReportField(row.locked)} | ${sanitizeReportField(row.latest)} | ${sanitizeReportField(row.reason)} |`
    );
  }
  const report = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(report, "utf8") > 256 * 1024) {
    throw new MonitorError("Dependency report exceeds the output size limit.");
  }
  return report;
}

export async function readBoundedResponse(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new MonitorError("Remote metadata exceeded the response size limit.");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new MonitorError("Remote metadata exceeded the response size limit.");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

export async function mapWithConcurrency(values, limit, worker) {
  if (!Number.isInteger(limit) || limit < 1) throw new MonitorError("Invalid concurrency limit.");
  const results = new Array(values.length);
  let next = 0;
  async function run() {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => run()));
  return results;
}
