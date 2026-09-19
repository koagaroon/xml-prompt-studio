import { MonitorError, readBoundedResponse } from "./dependency-currency.mjs";

export const METADATA_NOT_FOUND = Symbol("HTTP 404");

/** @param {number} milliseconds */
function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

/** @param {typeof fetch} fetchMetadata @param {(milliseconds: number) => Promise<void>} delay */
export function createJsonRequester(fetchMetadata = fetch, delay = sleep) {
  /** @type {Map<string, Promise<unknown>>} */
  const responseCache = new Map();

  /** @param {string} url @param {{ headers: Record<string, string>, maxBytes: number, allowNotFound?: boolean }} options @returns {Promise<unknown>} */
  return async function requestJson(url, { headers, maxBytes, allowNotFound = false }) {
    const cacheKey = JSON.stringify([headers, url, maxBytes, allowNotFound]);
    if (responseCache.has(cacheKey)) return await responseCache.get(cacheKey);

    const request = (async () => {
      let lastStatus = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const response = await fetchMetadata(url, {
            headers,
            redirect: "error",
            signal: AbortSignal.timeout(20_000),
          });
          lastStatus = response.status;
          if (allowNotFound && response.status === 404) return METADATA_NOT_FOUND;
          if (!response.ok) {
            if ((response.status === 429 || response.status >= 500) && attempt < 3) {
              await delay(attempt * 300);
              continue;
            }
            throw new MonitorError(`Remote metadata request returned HTTP ${response.status}.`);
          }
          const text = await readBoundedResponse(response, maxBytes);
          try {
            return JSON.parse(text);
          } catch {
            throw new MonitorError("Remote metadata was not valid JSON.");
          }
        } catch (error) {
          if (error instanceof MonitorError) throw error;
          if (attempt === 3) break;
          await delay(attempt * 300);
        }
      }
      const suffix = lastStatus === null ? "" : ` (HTTP ${lastStatus})`;
      throw new MonitorError(`Remote metadata request failed${suffix}.`);
    })();
    responseCache.set(cacheKey, request);
    return await request;
  };
}
