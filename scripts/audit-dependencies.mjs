import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkAuditReport, readAuditPolicy } from "./lib/dependency-audit.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
try {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run this check with npm run audit:dependencies.");
  const policy = readAuditPolicy(
    JSON.parse(readFileSync(new URL("../audit-ci.json", import.meta.url), "utf8"))
  );
  for (const production of [true, false]) {
    const scope = production ? "production" : "complete";
    console.log(`Auditing the ${scope} npm dependency graph (registry request).`);
    const result = spawnSync(
      process.execPath,
      [
        npmCli,
        "audit",
        "--json",
        "--audit-level=info",
        "--include=prod",
        "--include=optional",
        "--include=peer",
        production ? "--omit=dev" : "--include=dev",
      ],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      }
    );
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`npm audit terminated with ${result.signal}.`);
    const accepted = checkAuditReport(result.stdout, result.status, production ? [] : policy);
    if (accepted.length > 0) {
      console.warn(
        `WARN: Accepted temporary development audit exceptions:\n${accepted.join("\n")}`
      );
      console.warn(
        "The underlying audit still reports these findings; review audit-ci.json before expiry."
      );
    } else {
      console.log(`No vulnerabilities reported in the ${scope} npm dependency graph.`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Dependency audit failed.");
  process.exitCode = 1;
}
