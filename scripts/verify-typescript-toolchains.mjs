import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseStableSemver } from "./lib/dependency-currency.mjs";

/**
 * @typedef {{
 *   alias: string,
 *   specPattern: RegExp,
 *   label: string,
 *   packageUrl: URL,
 *   expectedPackageName: string,
 *   expectedBinName: string,
 *   expectedBinPath: string,
 *   expectedMajor: number,
 *   getEffectiveVersion: () => unknown,
 *   expectedEffectiveMajor: number | null,
 * }} ToolchainSpec
 */

export const DEFAULT_TOOLCHAINS = /** @type {const} @satisfies {readonly ToolchainSpec[]} */ ([
  {
    alias: "typescript-release",
    specPattern: /^npm:typescript@~7\.\d+\.\d+$/u,
    label: "release",
    packageUrl: new URL("../node_modules/typescript-release/package.json", import.meta.url),
    expectedPackageName: "typescript",
    expectedBinName: "tsc",
    expectedBinPath: "bin/tsc",
    expectedMajor: 7,
    getEffectiveVersion: () => undefined,
    expectedEffectiveMajor: null,
  },
  {
    alias: "typescript",
    specPattern: /^npm:@typescript\/typescript6@[~^]?6\.\d+\.\d+$/u,
    label: "API compatibility",
    packageUrl: new URL("../node_modules/typescript/package.json", import.meta.url),
    expectedPackageName: "@typescript/typescript6",
    expectedBinName: "tsc6",
    expectedBinPath: "bin/tsc6",
    expectedMajor: 6,
    getEffectiveVersion: () => createRequire(import.meta.url)("typescript").version,
    expectedEffectiveMajor: 6,
  },
]);

/**
 * @param {{
 *   rootPackageJson: Record<string, unknown>,
 *   packageLock?: Record<string, unknown>,
 *   toolchains?: readonly ToolchainSpec[],
 *   readJsonFile?: (url: URL) => Promise<Record<string, unknown>>,
 *   verifyFileExists?: (url: URL) => Promise<void>,
 * }} options
 * @returns {Promise<string[]>}
 */
export async function verifyTypeScriptToolchains({
  rootPackageJson,
  packageLock,
  toolchains = DEFAULT_TOOLCHAINS,
  readJsonFile = async (url) => JSON.parse(await readFile(url, "utf8")),
  verifyFileExists = async (url) => {
    await readFile(url);
  },
}) {
  const devDependencies =
    typeof rootPackageJson.devDependencies === "object" && rootPackageJson.devDependencies !== null
      ? /** @type {Record<string, unknown>} */ (rootPackageJson.devDependencies)
      : {};
  const lockRootDevDeps =
    packageLock &&
    typeof packageLock.packages === "object" &&
    packageLock.packages !== null &&
    typeof (/** @type {Record<string, unknown>} */ (packageLock.packages)[""]) === "object" &&
    /** @type {Record<string, unknown>} */ (packageLock.packages)[""] !== null
      ? /** @type {Record<string, unknown>} */ (
          /** @type {Record<string, unknown>} */ (
            /** @type {Record<string, unknown>} */ (packageLock.packages)[""]
          ).devDependencies ?? {}
        )
      : null;

  /** @type {string[]} */
  const summaries = [];

  for (const toolchain of toolchains) {
    const declaredSpec = devDependencies[toolchain.alias];

    if (typeof declaredSpec !== "string" || !toolchain.specPattern.test(declaredSpec)) {
      throw new Error(
        `Expected ${toolchain.alias} to match ${String(toolchain.specPattern)}, got ${String(declaredSpec)}`
      );
    }

    if (lockRootDevDeps !== null && lockRootDevDeps[toolchain.alias] !== declaredSpec) {
      throw new Error(
        `package-lock.json devDependencies.${toolchain.alias} (${String(lockRootDevDeps[toolchain.alias])}) does not match package.json (${declaredSpec})`
      );
    }

    const packageJson = await readJsonFile(toolchain.packageUrl);
    const version = packageJson.version;
    const parsedVersion = parseStableSemver(version);
    const compilerBin =
      typeof packageJson.bin === "object" && packageJson.bin !== null
        ? /** @type {Record<string, unknown>} */ (packageJson.bin)[toolchain.expectedBinName]
        : undefined;
    const normalizedCompilerBin =
      typeof compilerBin === "string" ? compilerBin.replace(/^\.\//u, "") : "";

    if (
      packageJson.name !== toolchain.expectedPackageName ||
      normalizedCompilerBin !== toolchain.expectedBinPath ||
      typeof compilerBin !== "string"
    ) {
      throw new Error(
        `Expected the ${toolchain.label} compiler package to be ${toolchain.expectedPackageName} with ${toolchain.expectedBinName} at ${toolchain.expectedBinPath}, got ${String(packageJson.name)} with ${String(compilerBin)}`
      );
    }

    await verifyFileExists(new URL(compilerBin, toolchain.packageUrl));

    if (parsedVersion === null || parsedVersion.major !== toolchain.expectedMajor) {
      throw new Error(
        `Expected the ${toolchain.label} TypeScript compiler to be stable major ${toolchain.expectedMajor}, got ${String(version)}`
      );
    }

    const effectiveVersion = toolchain.getEffectiveVersion();

    if (toolchain.expectedEffectiveMajor !== null) {
      const parsedEffective = parseStableSemver(effectiveVersion);

      if (parsedEffective === null || parsedEffective.major !== toolchain.expectedEffectiveMajor) {
        throw new Error(
          `Expected the ${toolchain.label} TypeScript engine to be stable major ${toolchain.expectedEffectiveMajor}, got ${String(effectiveVersion)}`
        );
      }
    }

    const versionSummary =
      effectiveVersion === undefined
        ? parsedVersion.raw
        : `wrapper ${parsedVersion.raw}, engine ${String(effectiveVersion)}`;
    summaries.push(`TypeScript ${toolchain.label}: ${versionSummary}`);
  }

  return summaries;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [rootPackageJson, packageLock] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then((raw) => JSON.parse(raw)),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8").then((raw) =>
      JSON.parse(raw)
    ),
  ]);
  const summaries = await verifyTypeScriptToolchains({ rootPackageJson, packageLock });
  for (const line of summaries) {
    console.log(line);
  }
}
