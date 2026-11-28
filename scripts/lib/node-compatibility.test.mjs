import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, it } from "vitest";
import { verifyTypeScriptToolchains } from "../verify-typescript-toolchains.mjs";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const probePath = resolve(projectRoot, "scripts/generate-icon-assets.mjs");

const config = ts.readConfigFile(resolve(projectRoot, "tsconfig.node.json"), ts.sys.readFile);
assert.equal(config.error, undefined);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, projectRoot);
assert.deepEqual(parsed.errors, []);
assert.ok(parsed.fileNames.some((path) => resolve(path) === probePath));

/** @type {ts.Program | undefined} */
let cachedBaseProgram;

/** @param {string} source */
function checkScriptProbe(source) {
  const host = ts.createCompilerHost(parsed.options);
  const readFile = host.readFile.bind(host);
  host.readFile = (path) => (resolve(path) === probePath ? source : readFile(path));
  host.writeFile = () => assert.fail("The compatibility probe must not emit files.");
  const program = ts.createProgram(parsed.fileNames, parsed.options, host, cachedBaseProgram);
  cachedBaseProgram ??= program;
  const script = program.getSourceFile(probePath);
  assert.ok(script);
  return program.getSemanticDiagnostics(script);
}

describe("minimum Node API compatibility and TypeScript toolchain verification", () => {
  it("checks maintenance scripts and rejects Node 26-only APIs on Node 24", () => {
    const prelude = 'import v8 from "node:v8";\n';
    assert.deepEqual(checkScriptProbe(`${prelude}v8.getHeapStatistics();`), []);
    const diagnostics = checkScriptProbe(`${prelude}v8.startHeapProfile();`);
    assert.equal(diagnostics.length, 1);
    assert.match(
      ts.flattenDiagnosticMessageText(diagnostics[0].messageText, "\n"),
      /Property 'startHeapProfile' does not exist/u
    );
  }, 10_000);

  it("verifies stable major 7 and major 6 TypeScript toolchains and rejects prereleases or lockfile drift", async () => {
    const baseRoot = {
      devDependencies: {
        "typescript-release": "npm:typescript@~7.0.9",
        typescript: "npm:@typescript/typescript6@6.0.4",
      },
    };
    const baseLock = {
      packages: {
        "": {
          devDependencies: { ...baseRoot.devDependencies },
        },
      },
    };
    /** @param {URL} url */
    const validPkg = async (url) =>
      url.href.includes("typescript-release")
        ? { name: "typescript", version: "7.0.9", bin: { tsc: "./bin/tsc" } }
        : { name: "@typescript/typescript6", version: "6.0.4", bin: { tsc6: "bin/tsc6" } };

    const summaries = await verifyTypeScriptToolchains({
      rootPackageJson: baseRoot,
      packageLock: baseLock,
      readJsonFile: validPkg,
      verifyFileExists: async () => {},
    });
    assert.equal(summaries.length, 2);

    // Rejects prerelease installed compiler even when parseInt would parse major 7.
    await assert.rejects(
      () =>
        verifyTypeScriptToolchains({
          rootPackageJson: baseRoot,
          packageLock: baseLock,
          readJsonFile: async (url) =>
            url.href.includes("typescript-release")
              ? { name: "typescript", version: "7.0.10-beta.1", bin: { tsc: "./bin/tsc" } }
              : validPkg(url),
          verifyFileExists: async () => {},
        }),
      /stable major 7/u
    );

    // Rejects package.json vs package-lock.json spec drift.
    await assert.rejects(
      () =>
        verifyTypeScriptToolchains({
          rootPackageJson: baseRoot,
          packageLock: {
            packages: {
              "": {
                devDependencies: {
                  ...baseRoot.devDependencies,
                  "typescript-release": "npm:typescript@~7.0.2",
                },
              },
            },
          },
          readJsonFile: validPkg,
          verifyFileExists: async () => {},
        }),
      /does not match package\.json/u
    );
  });
});
