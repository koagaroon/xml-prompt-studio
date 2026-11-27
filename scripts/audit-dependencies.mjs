import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkAuditReport, readAuditPolicy } from "./lib/dependency-audit.mjs";
import { collectReleasePackages } from "./lib/dependency-release.mjs";
import {
  evaluateOsvAdvisories,
  queryReleaseAdvisories,
  readOsvAuditPolicy,
} from "./lib/dependency-release-audit.mjs";
import { createJsonRequester } from "./lib/dependency-requests.mjs";
import { loadNativeInventory } from "./lib/native-notices.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
try {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run this check with npm run audit:dependencies.");
  const rawPolicy = JSON.parse(readFileSync(new URL("../audit-ci.json", import.meta.url), "utf8"));
  const policy = readAuditPolicy(rawPolicy);
  const osvPolicy = readOsvAuditPolicy(rawPolicy);
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

  console.log("Auditing the Windows runtime package inventory (OSV request).");
  const npmLock = JSON.parse(
    readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")
  );
  const cargoLock = readFileSync(new URL("../src-tauri/Cargo.lock", import.meta.url), "utf8");
  const { inventory: nativeInventory } = loadNativeInventory(root);
  const runtimePackages = collectReleasePackages({ npmLock, cargoLock, nativeInventory });
  const requestJson = createJsonRequester();
  const osvResults = await queryReleaseAdvisories(runtimePackages, (jsonBody) =>
    requestJson("https://api.osv.dev/v1/querybatch", {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "xml-prompt-studio-dependency-audit/1.0",
      },
      maxBytes: 4 * 1024 * 1024,
      jsonBody,
    })
  );
  const osvEvaluation = evaluateOsvAdvisories(osvResults, osvPolicy, "current");
  if (osvEvaluation.unaccepted.length > 0) {
    throw new Error(
      `Unaccepted Windows runtime OSV findings:\n${osvEvaluation.unaccepted.join("\n")}`
    );
  }
  if (osvEvaluation.accepted.length > 0) {
    console.warn(
      `WARN: Accepted temporary Windows runtime OSV exceptions:\n${osvEvaluation.accepted.join("\n")}`
    );
    console.warn(
      "The underlying OSV query still reports these findings; review audit-ci.json before expiry."
    );
  } else {
    console.log("No vulnerabilities reported in the Windows runtime package inventory.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Dependency audit failed.");
  process.exitCode = 1;
}
