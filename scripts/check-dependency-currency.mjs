import { execFile } from "node:child_process";
import { appendFile, readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MonitorError,
  classifyActionCurrency,
  classifyCargoCurrency,
  classifyNpmCurrency,
  collectCargoTargets,
  collectNpmTargets,
  inspectCratesMetadata,
  inspectGitHubReleases,
  isRecord,
  mapWithConcurrency,
  parseActionReferences,
  parseProjectMsrv,
  renderReport,
  reportExitCode,
  validateInstallScriptPolicy,
} from "./lib/dependency-currency.mjs";
import { createJsonRequester } from "./lib/dependency-requests.mjs";
import { checkRolldown } from "./lib/dependency-rolldown.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const userAgent = "xml-prompt-studio-dependency-watch/1.0";
const requestJson = createJsonRequester();

/** @param {string} ecosystem @param {string} dependency @param {string} locked @param {unknown} error @returns {import("./lib/dependency-currency.mjs").CurrencyRow} */
function errorRow(ecosystem, dependency, locked, error) {
  return {
    ecosystem,
    dependency,
    locked,
    latest: "unknown",
    status: "error",
    reason:
      error instanceof MonitorError
        ? error.message
        : "The dependency monitor encountered an unexpected error.",
  };
}

/** @param {string} path */
async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new MonitorError(`Unable to read ${relative(projectRoot, path)}.`);
  }
}

/** @param {string} path @returns {Promise<unknown>} */
async function readJson(path) {
  try {
    return JSON.parse(await readText(path));
  } catch (error) {
    if (error instanceof MonitorError) throw error;
    throw new MonitorError(`${relative(projectRoot, path)} contains invalid JSON.`);
  }
}

const npmHeaders = {
  Accept: "application/vnd.npm.install-v1+json",
  "User-Agent": userAgent,
};
const cratesHeaders = { Accept: "application/json", "User-Agent": userAgent };
/** @type {Record<string, string>} */
const githubHeaders = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": userAgent,
};
if (typeof process.env.GITHUB_TOKEN === "string" && process.env.GITHUB_TOKEN.trim() !== "") {
  githubHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN.trim()}`;
}

/** @param {string} packageName @param {string | null} version */
function npmUrl(packageName, version = null) {
  const base = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
  return version === null ? base : `${base}/${encodeURIComponent(version)}`;
}

/** @param {string} packageName */
async function fetchNpmMetadata(packageName) {
  return await requestJson(npmUrl(packageName), {
    headers: npmHeaders,
    maxBytes: 64 * 1024 * 1024,
  });
}

/** @param {unknown} packageJson @param {unknown} lockfile @param {string} npmrc @returns {Promise<import("./lib/dependency-currency.mjs").CurrencyRow[]>} */
async function checkNpm(packageJson, lockfile, npmrc) {
  let targets;
  try {
    targets = collectNpmTargets(packageJson, lockfile);
  } catch (error) {
    return [errorRow("npm", "direct dependency graph", "unknown", error)];
  }

  const rows = await mapWithConcurrency(targets, 6, async (target) => {
    const dependency =
      target.declaredName === target.registryName
        ? target.declaredName
        : `${target.declaredName} -> ${target.registryName}`;
    try {
      const metadata = await fetchNpmMetadata(target.registryName);
      return {
        ecosystem: target.kind === "toolchain" ? "npm toolchain" : "npm",
        dependency,
        locked: target.locked,
        ...classifyNpmCurrency(target, metadata, packageJson),
      };
    } catch (error) {
      return errorRow("npm", dependency, target.locked, error);
    }
  });

  try {
    const approvals = validateInstallScriptPolicy(packageJson, lockfile, npmrc);
    rows.push({
      ecosystem: "npm policy",
      dependency: "strict install-script allowlist",
      locked: `${approvals.length} approved`,
      latest: `${approvals.length} required`,
      status: "current",
      reason: "The allowlist exactly matches lockfile packages with install scripts.",
    });
  } catch (error) {
    rows.push(errorRow("npm policy", "strict install-script allowlist", "unknown", error));
  }
  return rows;
}

/** @param {string} manifestPath @returns {Promise<string>} */
function runCargoMetadata(manifestPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "cargo",
      ["metadata", "--format-version", "1", "--locked", "--manifest-path", manifestPath],
      {
        cwd: projectRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 240_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error !== null) {
          rejectPromise(
            new MonitorError("cargo metadata failed; the direct dependency graph is unavailable.")
          );
          return;
        }
        resolvePromise(stdout);
      }
    );
  });
}

/** @param {string} manifestText @param {string} manifestPath @returns {Promise<import("./lib/dependency-currency.mjs").CurrencyRow[]>} */
async function checkCargo(manifestText, manifestPath) {
  let targets;
  let projectMsrv;
  try {
    const metadataText = await runCargoMetadata(manifestPath);
    targets = collectCargoTargets(JSON.parse(metadataText));
    projectMsrv = parseProjectMsrv(manifestText);
  } catch (error) {
    return [errorRow("Cargo", "direct dependency graph", "unknown", error)];
  }
  return await mapWithConcurrency(targets, 4, async (target) => {
    try {
      const metadata = await requestJson(
        `https://crates.io/api/v1/crates/${encodeURIComponent(target.registryName)}`,
        { headers: cratesHeaders, maxBytes: 16 * 1024 * 1024 }
      );
      const inspection = inspectCratesMetadata(metadata, target.registryName, projectMsrv);
      const result = classifyCargoCurrency(target.locked, inspection, projectMsrv.raw);
      return {
        ecosystem: "Cargo",
        dependency:
          target.declaredName === target.registryName
            ? target.declaredName
            : `${target.declaredName} -> ${target.registryName}`,
        locked: target.locked,
        latest: result.latest,
        status: result.status,
        reason: result.reason,
      };
    } catch (error) {
      return errorRow("Cargo", target.declaredName, target.locked, error);
    }
  });
}

/** @param {string} directory @returns {Promise<import("./lib/dependency-currency.mjs").ActionSource[]>} */
async function readActionSources(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw new MonitorError("Unable to read GitHub Actions sources.");
  }
  const sources = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...(await readActionSources(path)));
    } else if (entry.isFile() && /\.ya?ml$/u.test(entry.name)) {
      sources.push({
        path: relative(projectRoot, path).split(sep).join("/"),
        content: await readText(path),
      });
    }
  }
  return sources;
}

/** @param {string} path */
async function fetchGitHubJson(path) {
  return await requestJson(`https://api.github.com${path}`, {
    headers: githubHeaders,
    maxBytes: 8 * 1024 * 1024,
  });
}

/** @param {string} repository @param {string} tag */
async function resolveGitHubCommit(repository, tag) {
  const metadata = await fetchGitHubJson(`/repos/${repository}/commits/${encodeURIComponent(tag)}`);
  if (!isRecord(metadata) || typeof metadata.sha !== "string") {
    throw new MonitorError("GitHub returned invalid tag dereference metadata.");
  }
  return metadata.sha;
}

/** @returns {Promise<import("./lib/dependency-currency.mjs").CurrencyRow[]>} */
async function checkActions() {
  let parsed;
  try {
    const sources = (
      await Promise.all([
        readActionSources(resolve(projectRoot, ".github", "workflows")),
        readActionSources(resolve(projectRoot, ".github", "actions")),
      ])
    ).flat();
    parsed = parseActionReferences(sources);
  } catch (error) {
    return [errorRow("GitHub Actions", "workflow sources", "unknown", error)];
  }

  const rows = parsed.errors.map((error) =>
    errorRow(
      "GitHub Actions",
      `${error.dependency} (${error.location})`,
      "invalid",
      new MonitorError(error.reason)
    )
  );
  rows.push(
    ...(await mapWithConcurrency(parsed.targets, 4, async (target) => {
      try {
        const releases = await fetchGitHubJson(`/repos/${target.repository}/releases?per_page=100`);
        const latestTag = inspectGitHubReleases(releases);
        const declaredSha = await resolveGitHubCommit(target.repository, target.declaredTag);
        const latestSha =
          latestTag === target.declaredTag
            ? declaredSha
            : await resolveGitHubCommit(target.repository, latestTag);
        return {
          ecosystem: "GitHub Actions",
          dependency: target.identifier,
          locked: `${target.declaredTag} @ ${target.pin.slice(0, 12)}`,
          latest: latestTag,
          ...classifyActionCurrency(target, declaredSha, latestTag, latestSha),
        };
      } catch (error) {
        return errorRow(
          "GitHub Actions",
          `${target.identifier} (${target.locations.join(", ")})`,
          target.declaredTag,
          error
        );
      }
    }))
  );
  return rows;
}

async function main() {
  const paths = {
    packageJson: resolve(projectRoot, "package.json"),
    packageLock: resolve(projectRoot, "package-lock.json"),
    npmrc: resolve(projectRoot, ".npmrc"),
    cargoManifest: resolve(projectRoot, "src-tauri", "Cargo.toml"),
  };
  let packageJson;
  let lockfile;
  let npmrc;
  let cargoManifest;
  try {
    [packageJson, lockfile, npmrc, cargoManifest] = await Promise.all([
      readJson(paths.packageJson),
      readJson(paths.packageLock),
      readText(paths.npmrc),
      readText(paths.cargoManifest),
    ]);
  } catch (error) {
    const rows = [errorRow("Monitor", "local project metadata", "unknown", error)];
    console.log(renderReport(rows));
    process.exitCode = reportExitCode(rows);
    return;
  }

  const rows = (
    await Promise.all([
      checkNpm(packageJson, lockfile, npmrc),
      checkCargo(cargoManifest, paths.cargoManifest),
      checkActions(),
      checkRolldown(lockfile, {
        fetchMetadata: () => fetchNpmMetadata("rolldown"),
        fetchBinding: (name, version) =>
          requestJson(npmUrl(name, version), {
            headers: { ...npmHeaders, Accept: "application/json" },
            maxBytes: 2 * 1024 * 1024,
            allowNotFound: true,
          }),
      }),
    ])
  ).flat();
  const report = renderReport(rows);
  console.log(report);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (typeof summaryPath === "string" && summaryPath.trim() !== "") {
    try {
      await appendFile(summaryPath, report, { encoding: "utf8" });
    } catch {
      rows.push(
        errorRow(
          "Monitor",
          "GitHub job summary",
          "unknown",
          new MonitorError("Unable to write the bounded report to the GitHub job summary.")
        )
      );
      console.log(renderReport(rows));
    }
  }
  process.exitCode = reportExitCode(rows);
}

await main();
