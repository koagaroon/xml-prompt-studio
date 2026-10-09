import {
  MonitorError,
  classifyVersion,
  compareSemver,
  inspectNpmMetadata,
  isRecord,
  minimumNodeVersion,
  newestStable,
  parseStableSemver,
  satisfiesNpmRequirement,
} from "./dependency-currency.mjs";

/** @param {unknown} packageJson */
export function parseNpmToolchainPin(packageJson) {
  const match =
    isRecord(packageJson) && typeof packageJson.packageManager === "string"
      ? /^npm@(\d+\.\d+\.\d+)$/u.exec(packageJson.packageManager)
      : null;
  const version = parseStableSemver(match?.[1]);
  if (version === null) {
    throw new MonitorError("packageManager must pin an exact stable npm version.");
  }
  return version.raw;
}

/** @param {unknown} manifestText */
export function parseRustToolchainPin(manifestText) {
  if (typeof manifestText !== "string" || manifestText.length > 32 * 1024) {
    throw new MonitorError("rust-toolchain.toml is not bounded text.");
  }
  const sections = [...manifestText.matchAll(/^[\t ]*\[toolchain\][\t ]*(?:#.*)?$/gmu)];
  if (sections.length !== 1) {
    throw new MonitorError("rust-toolchain.toml must have one toolchain section.");
  }
  const body = manifestText.slice(sections[0].index + sections[0][0].length);
  const nextSection = /^[\t ]*\[/mu.exec(body);
  const section = body.slice(0, nextSection === null ? undefined : nextSection.index);
  const pins = [...section.matchAll(/^[\t ]*(?:channel|"channel"|'channel')[\t ]*=(.*)$/gmu)];
  const value =
    pins.length === 1 ? /^[\t ]*(["'])(\d+\.\d+\.\d+)\1[\t ]*(?:#.*)?$/u.exec(pins[0][1]) : null;
  const version = parseStableSemver(value?.[2]);
  if (version === null) {
    throw new MonitorError("rust-toolchain.toml must pin one exact stable compiler channel.");
  }
  return version.raw;
}

/** @param {import("./dependency-currency.mjs").ParsedVersion} nodeVersion @param {unknown} requirement */
export function supportsNodeMinimum(nodeVersion, requirement) {
  if (typeof requirement !== "string" || requirement.length === 0 || requirement.length > 1024) {
    throw new MonitorError("npm metadata has no bounded Node engine range.");
  }
  const clauses = requirement.split("||").map((clause) => {
    const terms = clause.trim().split(/\s+/u);
    return terms.map((term) => {
      const match = /^(<=|>=|<|>|\^|~|=)?(\d+\.\d+\.\d+)$/u.exec(term);
      const version = parseStableSemver(match?.[2]);
      if (match === null || version === null) {
        throw new MonitorError("npm metadata uses an unsupported Node engine range.");
      }
      const operator = match[1] ?? "=";
      const comparison = compareSemver(nodeVersion, version);
      if (operator === "^") return satisfiesNpmRequirement(nodeVersion.raw, `^${version.raw}`);
      if (operator === "~") return satisfiesNpmRequirement(nodeVersion.raw, `~${version.raw}`);
      if (operator === ">=") return comparison >= 0;
      if (operator === "<=") return comparison <= 0;
      if (operator === ">") return comparison > 0;
      if (operator === "<") return comparison < 0;
      return comparison === 0;
    });
  });
  return clauses.some((terms) => terms.every(Boolean));
}

/** @param {unknown} metadata @param {string} version */
function npmNodeRequirement(metadata, version) {
  const release =
    isRecord(metadata) && isRecord(metadata.versions) ? metadata.versions[version] : null;
  if (
    !isRecord(release) ||
    release.name !== "npm" ||
    release.version !== version ||
    !isRecord(release.engines) ||
    typeof release.engines.node !== "string"
  ) {
    throw new MonitorError(`npm ${version} has invalid release or Node engine metadata.`);
  }
  return release.engines.node;
}

/** @param {unknown} metadata @param {string} locked @param {string} latest @param {import("./dependency-currency.mjs").ParsedVersion} minimum */
function compatibleNpmRelease(metadata, locked, latest, minimum) {
  if (!isRecord(metadata) || !isRecord(metadata.versions)) {
    throw new MonitorError("npm metadata has no release inventory.");
  }
  const candidates = Object.entries(metadata.versions)
    .filter(
      ([version, release]) =>
        parseStableSemver(version) !== null &&
        classifyVersion(locked, version).status === "actionable" &&
        classifyVersion(version, latest).status !== "error" &&
        (!isRecord(release) || typeof release.deprecated !== "string")
    )
    .map(([version]) => version)
    .sort((left, right) => {
      const first = parseStableSemver(left);
      const second = parseStableSemver(right);
      return first === null || second === null ? 0 : compareSemver(second, first);
    });
  for (const version of candidates) {
    if (supportsNodeMinimum(minimum, npmNodeRequirement(metadata, version))) return version;
  }
  return locked;
}

/** @param {string} locked @param {unknown} metadata @param {import("./dependency-currency.mjs").ParsedVersion} minimum @returns {import("./dependency-currency.mjs").CurrencyResult & { latest: string }} */
export function classifyNpmToolchain(locked, metadata, minimum) {
  const latest = inspectNpmMetadata(metadata, "npm");
  const result = classifyVersion(locked, latest, "Current stable npm build tool.");
  if (result.status === "error") return { latest, ...result };
  if (!supportsNodeMinimum(minimum, npmNodeRequirement(metadata, locked))) {
    throw new MonitorError(
      `The pinned npm ${locked} does not support the Node ${minimum.raw} minimum.`
    );
  }
  const latestRequirement = npmNodeRequirement(metadata, latest);
  const latestCompatible = supportsNodeMinimum(minimum, latestRequirement);
  const candidate = latestCompatible
    ? latest
    : compatibleNpmRelease(metadata, locked, latest, minimum);
  const update = classifyVersion(locked, candidate);
  if (update.status === "actionable") {
    const majorUpdate = parseStableSemver(locked)?.major !== parseStableSemver(candidate)?.major;
    return {
      latest: candidate,
      status: "actionable",
      reason: `A newer stable npm build tool supports Node ${minimum.raw}.${majorUpdate ? " This major update requires a compatibility review." : ""}${latestCompatible ? "" : ` npm ${latest} is held because it requires Node ${latestRequirement}.`}`,
    };
  }
  if (!latestCompatible) {
    return {
      latest,
      status: "hold",
      reason: `npm ${latest} requires Node ${latestRequirement}; review the source-build minimum ${minimum.raw} before updating.`,
    };
  }
  return { latest, ...result };
}

/** @param {unknown} releases */
export function inspectRustReleases(releases) {
  if (!Array.isArray(releases) || releases.length === 0 || releases.length > 100) {
    throw new MonitorError("GitHub returned invalid Rust release metadata.");
  }
  const stableVersions = [];
  for (const release of releases) {
    if (
      !isRecord(release) ||
      typeof release.draft !== "boolean" ||
      typeof release.prerelease !== "boolean" ||
      typeof release.tag_name !== "string" ||
      release.tag_name.length > 128
    ) {
      throw new MonitorError("GitHub returned an invalid Rust release entry.");
    }
    if (!release.draft && !release.prerelease && /^\d+\.\d+\.\d+$/u.test(release.tag_name)) {
      stableVersions.push(release.tag_name);
    }
  }
  const latest = newestStable(stableVersions);
  if (latest === null) throw new MonitorError("GitHub returned no stable Rust compiler release.");
  return latest;
}

/** @param {string} ecosystem @param {string} dependency @param {string} locked @param {unknown} error @returns {import("./dependency-currency.mjs").CurrencyRow} */
function toolchainError(ecosystem, dependency, locked, error) {
  return {
    ecosystem,
    dependency,
    locked,
    latest: "unknown",
    status: "error",
    reason:
      error instanceof MonitorError
        ? error.message
        : "The build-tool monitor encountered an unexpected error.",
  };
}

/**
 * @param {unknown} packageJson
 * @param {unknown} rustToolchain
 * @param {{ fetchNpmMetadata: () => Promise<unknown>, fetchRustReleases: () => Promise<unknown> }} requests
 * @returns {Promise<import("./dependency-currency.mjs").CurrencyRow[]>}
 */
export async function checkToolchains(packageJson, rustToolchain, requests) {
  return await Promise.all([
    (async () => {
      let locked = "unknown";
      try {
        locked = parseNpmToolchainPin(packageJson);
        const minimum = minimumNodeVersion(packageJson);
        return {
          ecosystem: "npm toolchain",
          dependency: "npm (packageManager)",
          locked,
          ...classifyNpmToolchain(locked, await requests.fetchNpmMetadata(), minimum),
        };
      } catch (error) {
        return toolchainError("npm toolchain", "npm (packageManager)", locked, error);
      }
    })(),
    (async () => {
      let locked = "unknown";
      try {
        locked = parseRustToolchainPin(rustToolchain);
        const latest = inspectRustReleases(await requests.fetchRustReleases());
        const result = classifyVersion(locked, latest, "Current stable pinned Rust compiler.");
        return {
          ecosystem: "Rust toolchain",
          dependency: "rustc (rust-toolchain.toml)",
          locked,
          latest,
          ...result,
          reason:
            result.status === "actionable"
              ? "A newer stable build compiler is available; review compiler notices and validation separately from the Cargo source-build minimum."
              : result.reason,
        };
      } catch (error) {
        return toolchainError("Rust toolchain", "rustc (rust-toolchain.toml)", locked, error);
      }
    })(),
  ]);
}
