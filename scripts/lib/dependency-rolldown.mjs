import {
  MonitorError,
  classifyRolldownCurrency,
  findRolldownLock,
  inspectNpmRangeMetadata,
  inspectPublishedBinding,
  inspectRolldownRelease,
  mapWithConcurrency,
} from "./dependency-currency.mjs";
import { METADATA_NOT_FOUND } from "./dependency-requests.mjs";

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
    const lockedBindings = inspectRolldownRelease(metadata, locked);
    const latestBindings = inspectRolldownRelease(metadata, latest);
    const bindingsToCheck = [...new Set([...lockedBindings, ...latestBindings])].sort();
    const publishedBindings = await mapWithConcurrency(bindingsToCheck, 6, async (binding) => {
      const separator = binding.lastIndexOf("@");
      const packageMetadata = await fetchBinding(
        binding.slice(0, separator),
        binding.slice(separator + 1)
      );
      if (packageMetadata === METADATA_NOT_FOUND) return null;
      if (!inspectPublishedBinding(packageMetadata, binding)) {
        throw new MonitorError(`Invalid published native package metadata for ${binding}.`);
      }
      return binding;
    });
    return [
      {
        ...identity,
        locked,
        latest,
        ...classifyRolldownCurrency({
          locked,
          latest,
          lockedBindings,
          latestBindings,
          publishedBindings: publishedBindings.filter((binding) => binding !== null),
        }),
      },
    ];
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
