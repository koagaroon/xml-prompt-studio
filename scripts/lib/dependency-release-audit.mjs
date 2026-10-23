import { MonitorError, isRecord, parseStableSemver } from "./dependency-currency.mjs";

/**
 * @typedef {{ ecosystem: "npm" | "crates.io", name: string, version: string }} ReleasePackage
 * @typedef {ReleasePackage & { advisories: string[] }} ReleaseAdvisoryResult
 * @typedef {{ package: { ecosystem: "npm" | "crates.io", name: string }, version: string, page_token?: string }} AdvisoryQuery
 * @typedef {{ queries: AdvisoryQuery[] }} AdvisoryBatch
 * @typedef {{ index: number, pages: number, pageToken?: string, tokens: Set<string> }} PendingPackage
 */

export const RELEASE_AUDIT_LIMITS = Object.freeze({
  packages: 2000,
  batchSize: 100,
  pagesPerPackage: 8,
  requests: 64,
  advisoriesPerPage: 2000,
  advisories: 10_000,
  pageTokenLength: 2048,
});

const NPM_NAME = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/u;
const CRATE_NAME = /^[A-Za-z0-9_-]+$/u;
const ADVISORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** @param {unknown} packages @returns {ReleaseAdvisoryResult[]} */
function validatePackages(packages) {
  if (!Array.isArray(packages) || packages.length > RELEASE_AUDIT_LIMITS.packages) {
    throw new MonitorError("Release advisory package inventory is invalid or exceeds its limit.");
  }
  const identities = new Set();
  return Array.from(packages, (entry) => {
    if (
      !isRecord(entry) ||
      (entry.ecosystem !== "npm" && entry.ecosystem !== "crates.io") ||
      typeof entry.name !== "string" ||
      typeof entry.version !== "string" ||
      parseStableSemver(entry.version) === null ||
      (entry.ecosystem === "npm"
        ? entry.name.length > 214 || !NPM_NAME.test(entry.name)
        : entry.name.length > 64 || !CRATE_NAME.test(entry.name))
    ) {
      throw new MonitorError("Release advisory queries require valid, exactly locked packages.");
    }
    const identity = JSON.stringify([entry.ecosystem, entry.name, entry.version]);
    if (identities.has(identity)) {
      throw new MonitorError("Release advisory package inventory contains duplicate identities.");
    }
    identities.add(identity);
    return {
      ecosystem: entry.ecosystem,
      name: entry.name,
      version: entry.version,
      advisories: [],
    };
  });
}

/** @param {unknown} response @param {number} expectedCount @returns {Record<string, unknown>[]} */
function validateResults(response, expectedCount) {
  if (
    !isRecord(response) ||
    Object.keys(response).some((key) => key !== "results") ||
    !Array.isArray(response.results) ||
    response.results.length !== expectedCount ||
    Array.from(response.results).some(
      (result) =>
        !isRecord(result) ||
        Object.keys(result).some((key) => key !== "vulns" && key !== "next_page_token")
    )
  ) {
    throw new MonitorError("Release advisory response does not match the requested package batch.");
  }
  return /** @type {Record<string, unknown>[]} */ (response.results);
}

/**
 * Return every input package, in input order. IDs are review signals, not an exploitability verdict.
 * Transport timeouts, retries, and response byte limits belong to the injected requester.
 * @param {ReleasePackage[]} packages
 * @param {(payload: AdvisoryBatch) => Promise<unknown>} queryBatch
 * @returns {Promise<ReleaseAdvisoryResult[]>}
 */
export async function queryReleaseAdvisories(packages, queryBatch) {
  const results = validatePackages(packages);
  if (typeof queryBatch !== "function") {
    throw new MonitorError("Release advisory query transport is unavailable.");
  }
  const advisoryIds = results.map(() => new Set());
  let requests = 0;
  let advisoryCount = 0;

  for (let start = 0; start < results.length; start += RELEASE_AUDIT_LIMITS.batchSize) {
    /** @type {PendingPackage[]} */
    let pending = results.slice(start, start + RELEASE_AUDIT_LIMITS.batchSize).map((_, offset) => ({
      index: start + offset,
      pages: 0,
      tokens: new Set(),
    }));

    while (pending.length > 0) {
      if (requests >= RELEASE_AUDIT_LIMITS.requests) {
        throw new MonitorError(
          "Release advisory queries exceeded the request limit; coverage is incomplete."
        );
      }
      requests += 1;
      const queries = pending.map((state) => {
        const entry = results[state.index];
        /** @type {AdvisoryQuery} */
        const query = {
          package: { ecosystem: entry.ecosystem, name: entry.name },
          version: entry.version,
        };
        if (state.pageToken !== undefined) query.page_token = state.pageToken;
        return query;
      });
      const page = validateResults(await queryBatch({ queries }), queries.length);
      /** @type {PendingPackage[]} */
      const remaining = [];

      for (let position = 0; position < pending.length; position += 1) {
        const state = pending[position];
        const entry = results[state.index];
        const result = page[position];
        state.pages += 1;

        if (Object.hasOwn(result, "vulns")) {
          if (
            !Array.isArray(result.vulns) ||
            result.vulns.length > RELEASE_AUDIT_LIMITS.advisoriesPerPage
          ) {
            throw new MonitorError("Release advisory result is invalid or exceeds the page limit.");
          }
          advisoryCount += result.vulns.length;
          if (advisoryCount > RELEASE_AUDIT_LIMITS.advisories) {
            throw new MonitorError(
              "Release advisory results exceeded the total limit; coverage is incomplete."
            );
          }
          for (const advisory of result.vulns) {
            if (
              !isRecord(advisory) ||
              typeof advisory.id !== "string" ||
              !ADVISORY_ID.test(advisory.id)
            ) {
              throw new MonitorError("Release advisory response contains an invalid advisory ID.");
            }
            if (!advisoryIds[state.index].has(advisory.id)) {
              advisoryIds[state.index].add(advisory.id);
              entry.advisories.push(advisory.id);
            }
          }
        }

        if (!Object.hasOwn(result, "next_page_token")) continue;
        const token = result.next_page_token;
        if (
          typeof token !== "string" ||
          token.length === 0 ||
          token.length > RELEASE_AUDIT_LIMITS.pageTokenLength ||
          token.trim().length === 0
        ) {
          throw new MonitorError("Release advisory response contains an invalid pagination token.");
        }
        if (state.tokens.has(token)) {
          throw new MonitorError(
            "Release advisory pagination repeated a token; coverage is incomplete."
          );
        }
        if (state.pages >= RELEASE_AUDIT_LIMITS.pagesPerPackage) {
          throw new MonitorError(
            "Release advisory pagination exceeded the page limit; coverage is incomplete."
          );
        }
        state.tokens.add(token);
        state.pageToken = token;
        remaining.push(state);
      }
      pending = remaining;
    }
  }

  return results;
}
