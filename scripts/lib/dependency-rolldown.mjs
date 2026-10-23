import {
  MonitorError,
  classifyRolldownCurrency,
  classifyVersion,
  compareSemver,
  findRolldownLock,
  inspectNpmRangeMetadata,
  inspectPublishedBinding,
  inspectRolldownRelease,
  isRecord,
  mapWithConcurrency,
  parseStableSemver,
  satisfiesNpmRequirement,
} from "./dependency-currency.mjs";
import { METADATA_NOT_FOUND } from "./dependency-requests.mjs";

const maintainedPackages = ["@rolldown/binding-win32-x64-msvc", "@rolldown/binding-linux-x64-gnu"];
const maxUpdateCandidates = 8;
const buildHostNote = " Build hosts: Windows x64 MSVC and Linux x64 GNU.";

/** @param {string[]} bindings @param {string} version */
function maintainedBindings(bindings, version) {
  return maintainedPackages.map((name) => {
    const binding = bindings.find((identity) => identity.startsWith(`${name}@`));
    if (binding === undefined) {
      throw new MonitorError(`Rolldown ${version} has no maintained-host binding for ${name}.`);
    }
    return binding;
  });
}

/** @param {unknown} metadata @param {string} requirement @param {string} locked */
function updateCandidates(metadata, requirement, locked) {
  if (!isRecord(metadata) || !isRecord(metadata.versions)) {
    throw new MonitorError("npm returned invalid Rolldown versions.");
  }
  const candidates = [];
  for (const [version, release] of Object.entries(metadata.versions)) {
    const parsed = parseStableSemver(version);
    if (
      parsed !== null &&
      classifyVersion(locked, version).status === "actionable" &&
      satisfiesNpmRequirement(version, requirement) &&
      (!isRecord(release) || typeof release.deprecated !== "string")
    ) {
      candidates.push(parsed);
    }
  }
  return candidates.sort((left, right) => compareSemver(right, left));
}

/**
 * @param {unknown} lockfile
 * @param {{ fetchMetadata: () => Promise<unknown>, fetchBinding: (name: string, version: string) => Promise<unknown> }} requests
 * @returns {Promise<import("./dependency-currency.mjs").CurrencyRow[]>}
 */
export async function checkRolldown(lockfile, { fetchMetadata, fetchBinding }) {
  let locked = "unknown";
  const identity = { ecosystem: "npm / Vite", dependency: "rolldown native package set" };
  try {
    const resolution = findRolldownLock(lockfile);
    locked = resolution.locked;
    const metadata = await fetchMetadata();
    const latest = inspectNpmRangeMetadata(metadata, "rolldown", resolution.requested);
    const comparison = classifyVersion(locked, latest);
    if (comparison.status === "error") return [{ ...identity, locked, latest, ...comparison }];
    const lockedBindings = inspectRolldownRelease(metadata, locked);
    const lockedMaintained = maintainedBindings(lockedBindings, locked);
    /** @type {Map<string, Promise<boolean>>} */
    const publicationCache = new Map();
    /** @param {string} binding */
    async function isPublished(binding) {
      let publication = publicationCache.get(binding);
      if (publication === undefined) {
        publication = (async () => {
          const separator = binding.lastIndexOf("@");
          const packageMetadata = await fetchBinding(
            binding.slice(0, separator),
            binding.slice(separator + 1)
          );
          if (packageMetadata === METADATA_NOT_FOUND) return false;
          if (!inspectPublishedBinding(packageMetadata, binding)) {
            throw new MonitorError(`Invalid published native package metadata for ${binding}.`);
          }
          return true;
        })();
        publicationCache.set(binding, publication);
      }
      return await publication;
    }
    /** @param {string[]} bindings */
    async function publishedBindings(bindings) {
      const inspected = await mapWithConcurrency(bindings, 6, async (binding) =>
        (await isPublished(binding)) ? binding : null
      );
      return inspected.filter((binding) => binding !== null);
    }
    const publishedLocked = await publishedBindings(lockedMaintained);
    const lockedResult = classifyRolldownCurrency({
      locked,
      latest: locked,
      lockedBindings: lockedMaintained,
      latestBindings: lockedMaintained,
      publishedBindings: publishedLocked,
    });
    if (lockedResult.status === "error") {
      return [{ ...identity, locked, latest, ...lockedResult }];
    }

    const candidates = updateCandidates(metadata, resolution.requested, locked);
    const held = [];
    let selected = locked;
    let selectedBindings = lockedBindings;
    let selectedResult = lockedResult;
    // Bound the search, but never classify unsearched compatible updates as a successful hold.
    for (const candidate of candidates.slice(0, maxUpdateCandidates)) {
      const bindings = inspectRolldownRelease(metadata, candidate.raw);
      const maintained = maintainedBindings(bindings, candidate.raw);
      const result = classifyRolldownCurrency({
        locked,
        latest: candidate.raw,
        lockedBindings: lockedMaintained,
        latestBindings: maintained,
        publishedBindings: [...publishedLocked, ...(await publishedBindings(maintained))],
      });
      if (result.status === "hold") {
        held.push({ version: candidate.raw, result });
      } else {
        selected = candidate.raw;
        selectedBindings = bindings;
        selectedResult = result;
        break;
      }
    }
    if (selected === locked && candidates.length > maxUpdateCandidates) {
      throw new MonitorError(
        `Rolldown publication search reached its ${maxUpdateCandidates}-candidate limit; older compatible updates remain unchecked.`
      );
    }

    // Other hosts do not select the candidate; inspect them only for the lock and selected release.
    const otherBindings = [...new Set([...lockedBindings, ...selectedBindings])].filter(
      (binding) => !maintainedPackages.some((name) => binding.startsWith(`${name}@`))
    );
    const otherChecks = await mapWithConcurrency(otherBindings, 6, async (binding) => {
      try {
        return { binding, published: await isPublished(binding) };
      } catch {
        return { binding, published: null };
      }
    });
    const missingOther = otherChecks
      .filter(({ published }) => published === false)
      .map(({ binding }) => binding.replace("@rolldown/binding-", ""))
      .sort();
    const unverifiedOther = otherChecks
      .filter(({ published }) => published === null)
      .map(({ binding }) => binding.replace("@rolldown/binding-", ""))
      .sort();
    const information =
      (missingOther.length === 0
        ? ""
        : ` Other-platform publication gaps (informational): ${missingOther.join(", ")}.`) +
      (unverifiedOther.length === 0
        ? ""
        : ` Other-platform checks incomplete (informational): ${unverifiedOther.join(", ")}.`);
    const newestHold = held[0];
    const heldReason =
      newestHold === undefined
        ? ""
        : `${newestHold.result.reason}${held.length > 1 ? ` ${held.length - 1} other newer releases are also held.` : ""}`;
    if (selected === locked && newestHold !== undefined) {
      return [{ ...identity, locked, latest, status: "hold", reason: heldReason + information }];
    }
    const rows = [
      {
        ...identity,
        locked,
        latest: selected,
        ...selectedResult,
        reason: selectedResult.reason + buildHostNote + information,
      },
    ];
    if (newestHold !== undefined) {
      rows.push({
        ...identity,
        dependency: "rolldown newer publication hold",
        locked,
        latest: newestHold.version,
        status: "hold",
        reason: heldReason,
      });
    }
    return rows;
  } catch (error) {
    return [
      {
        ...identity,
        locked,
        latest: "unknown",
        status: "error",
        reason:
          error instanceof MonitorError
            ? error.message
            : "The dependency monitor encountered an unexpected error.",
      },
    ];
  }
}
