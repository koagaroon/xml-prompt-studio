import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const probePath = resolve(projectRoot, "scripts/generate-icon-assets.mjs");

/** @param {string} source */
function checkScriptProbe(source) {
  const config = ts.readConfigFile(resolve(projectRoot, "tsconfig.node.json"), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, projectRoot);
  assert.deepEqual(parsed.errors, []);
  assert.ok(parsed.fileNames.some((path) => resolve(path) === probePath));

  const host = ts.createCompilerHost(parsed.options);
  const readFile = host.readFile.bind(host);
  host.readFile = (path) => (resolve(path) === probePath ? source : readFile(path));
  host.writeFile = () => assert.fail("The compatibility probe must not emit files.");
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  const script = program.getSourceFile(probePath);
  assert.ok(script);
  return program.getSemanticDiagnostics(script);
}

describe("minimum Node API compatibility", () => {
  it("checks maintenance scripts and rejects APIs newer than Node 22.13", () => {
    const prelude = 'import process from "node:process";\n';
    assert.deepEqual(checkScriptProbe(`${prelude}process.cpuUsage();`), []);
    const diagnostics = checkScriptProbe(`${prelude}process.threadCpuUsage();`);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 2339);
    assert.match(
      ts.flattenDiagnosticMessageText(diagnostics[0].messageText, "\n"),
      /threadCpuUsage/u
    );
  }, 10_000);
});
