import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { checkAuditReport, readAuditPolicy } from "./dependency-audit.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const policySource = readFileSync(new URL("../../audit-ci.json", import.meta.url), "utf8");
const advisory = "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm";
const expiry = new Date("2026-11-02T00:00:00Z");

/** @param {string} name @param {(string | {url: string})[]} via @param {boolean} [isDirect] @param {string} [severity] */
function entry(name, via, isDirect = false, severity = "high") {
  return { name, severity, isDirect, via };
}

/** @param {Record<string, import("./dependency-audit.mjs").Vulnerability>} [vulnerabilities] */
function report(vulnerabilities = {}) {
  /** @type {Record<string, number>} */
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const value of Object.values(vulnerabilities)) {
    counts[value.severity] += 1;
    counts.total += 1;
  }
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: counts } };
}

function stylelintReport() {
  return report({
    braces: entry("braces", [{ url: advisory }]),
    micromatch: entry("micromatch", ["braces"]),
    "fast-glob": entry("fast-glob", ["micromatch"]),
    globby: entry("globby", ["fast-glob", "micromatch"]),
    stylelint: entry("stylelint", ["fast-glob", "globby", "micromatch"], true),
    "stylelint-config-recommended": entry("stylelint-config-recommended", ["stylelint"]),
    "stylelint-config-standard": entry(
      "stylelint-config-standard",
      ["stylelint", "stylelint-config-recommended"],
      true
    ),
  });
}

describe("dependency audit policy", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("accepts only the reviewed advisory on all twelve complete Stylelint paths", () => {
    const paths = checkAuditReport(
      JSON.stringify(stylelintReport()),
      1,
      readAuditPolicy(JSON.parse(policySource))
    );
    assert.equal(paths.length, 12);
    assert.ok(paths.includes("GHSA-vfj7-8cjw-p6xm|stylelint>micromatch>braces"));
    assert.ok(
      paths.includes(
        "GHSA-vfj7-8cjw-p6xm|stylelint-config-standard>stylelint-config-recommended>stylelint>globby>fast-glob>micromatch>braces"
      )
    );
    assert.ok(paths.every((path) => !path.endsWith(">")));
  });

  it("rejects the same finding in production without consulting development exceptions", () => {
    assert.throws(() => checkAuditReport(JSON.stringify(stylelintReport()), 1), /Unaccepted/u);
  });

  it.each(["globby", "micromatch", "braces"])(
    "rejects a newly direct %s caller, including shared graph nodes",
    (name) => {
      const input = stylelintReport();
      input.vulnerabilities[name].isDirect = true;
      assert.throws(
        () => checkAuditReport(JSON.stringify(input), 1, readAuditPolicy(JSON.parse(policySource))),
        /Unaccepted/u
      );
    }
  );

  it("rejects another development tool sharing the same vulnerable dependency", () => {
    const input = stylelintReport();
    input.vulnerabilities["another-tool"] = entry("another-tool", ["micromatch"], true);
    assert.throws(
      () =>
        checkAuditReport(
          JSON.stringify(report(input.vulnerabilities)),
          1,
          readAuditPolicy(JSON.parse(policySource))
        ),
      /another-tool>micromatch>braces/u
    );
  });

  it("binds the exception to its advisory even on an otherwise approved path", () => {
    const input = stylelintReport();
    input.vulnerabilities.braces.via = [
      { url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" },
    ];
    assert.throws(
      () => checkAuditReport(JSON.stringify(input), 1, readAuditPolicy(JSON.parse(policySource))),
      /GHSA-aaaa-bbbb-cccc\|stylelint>/u
    );
  });

  it("rejects a changed intermediate dependency under an existing approved root", () => {
    const input = stylelintReport();
    input.vulnerabilities.stylelint.via.push("new-helper");
    input.vulnerabilities["new-helper"] = entry("new-helper", ["micromatch"]);
    assert.throws(
      () =>
        checkAuditReport(
          JSON.stringify(report(input.vulnerabilities)),
          1,
          readAuditPolicy(JSON.parse(policySource))
        ),
      /stylelint>new-helper>micromatch>braces/u
    );
  });

  it.each(["info", "low", "moderate", "high", "critical"])(
    "rejects an unrelated %s advisory",
    (severity) => {
      const input = report({
        other: entry(
          "other",
          [{ url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" }],
          true,
          severity
        ),
      });
      assert.throws(
        () => checkAuditReport(JSON.stringify(input), 1, readAuditPolicy(JSON.parse(policySource))),
        /GHSA-aaaa-bbbb-cccc/u
      );
    }
  );

  it("accepts immediately before expiry and rejects at the exact expiry instant", () => {
    const raw = JSON.stringify(stylelintReport());
    vi.setSystemTime(new Date(expiry.getTime() - 1));
    assert.equal(checkAuditReport(raw, 1, readAuditPolicy(JSON.parse(policySource))).length, 12);
    vi.setSystemTime(expiry);
    assert.throws(
      () => checkAuditReport(raw, 1, readAuditPolicy(JSON.parse(policySource))),
      /Unaccepted/u
    );
  });

  it("passes a clean report after upstream fixes remove the finding", () => {
    vi.setSystemTime(expiry);
    assert.deepEqual(
      checkAuditReport(JSON.stringify(report()), 0, readAuditPolicy(JSON.parse(policySource))),
      []
    );
  });

  it.each([
    "",
    "{",
    "null",
    "[]",
    "{}",
    '{"error":{"code":"ENOAUDIT"}}',
    '{"auditReportVersion":3}',
    '{"auditReportVersion":2,"vulnerabilities":[],"metadata":{"vulnerabilities":{}}}',
  ])("rejects malformed or unavailable audit output: %s", (output) => {
    assert.throws(() => checkAuditReport(output, 1));
  });

  it.each([null, 2, 137])(
    "rejects an unsuccessful process even with clean JSON (exit %s)",
    (status) => {
      assert.throws(() => checkAuditReport(JSON.stringify(report()), status), /did not complete/u);
    }
  );

  it("rejects inconsistent counts and exit status", () => {
    const input = stylelintReport();
    const rules = readAuditPolicy(JSON.parse(policySource));
    assert.throws(() => checkAuditReport(JSON.stringify(input), 0, rules), /exit status/u);
    input.metadata.vulnerabilities.high -= 1;
    assert.throws(() => checkAuditReport(JSON.stringify(input), 1, rules), /counts/u);
    assert.throws(() => checkAuditReport(JSON.stringify(report()), 1), /exit status/u);
  });

  it("rejects an array severity instead of coercing it into a known level", () => {
    const input = stylelintReport();
    const malformed = {
      ...input,
      vulnerabilities: {
        ...input.vulnerabilities,
        braces: { ...input.vulnerabilities.braces, severity: ["high"] },
      },
      metadata: { vulnerabilities: { ...input.metadata.vulnerabilities, high: 6 } },
    };
    assert.throws(
      () =>
        checkAuditReport(JSON.stringify(malformed), 1, readAuditPolicy(JSON.parse(policySource))),
      /Invalid npm audit dependency/u
    );
  });

  it("rejects unsupported severity counters even when known counts are zero", () => {
    const input = report();
    input.metadata.vulnerabilities.fatal = 1;
    assert.throws(
      () => checkAuditReport(JSON.stringify(input), 0),
      /unsupported vulnerability counts/u
    );
  });

  it.each(["", "stylelint>micromatch", "stylelint|micromatch", "style lint", "stylelint*"])(
    "rejects ambiguous package name %s",
    (name) => {
      const input = report({
        [name]: entry(name, ["braces"], true),
        braces: entry("braces", [{ url: advisory }]),
      });
      assert.throws(
        () => checkAuditReport(JSON.stringify(input), 1, readAuditPolicy(JSON.parse(policySource))),
        /Invalid npm audit dependency/u
      );
    }
  );

  it("rejects unsupported severity, dangling links, cycles and orphan entries", () => {
    /** @type {Record<string, import("./dependency-audit.mjs").Vulnerability>[]} */
    const invalidGraphs = [
      { a: entry("a", [{ url: advisory }], true, "unknown") },
      { a: entry("a", ["missing"], true) },
      { a: entry("a", ["b"], true), b: entry("b", ["a"]) },
      { a: entry("a", [{ url: advisory }]) },
    ];
    for (const graph of invalidGraphs)
      assert.throws(() => checkAuditReport(JSON.stringify(report(graph)), 1));
  });

  it.each([
    "module",
    "advisory",
    "wildcard",
    "truncated",
    "permanent",
    "invalid-expiry",
    "unexplained",
  ])("rejects a %s exception", (kind) => {
    const record = { active: true, notes: "Reviewed", expiry: expiry.toISOString() };
    let key = "GHSA-vfj7-8cjw-p6xm|stylelint>micromatch>braces";
    if (kind === "module") key = "braces";
    if (kind === "advisory") key = "GHSA-vfj7-8cjw-p6xm";
    if (kind === "wildcard") key = "GHSA-vfj7-8cjw-p6xm|stylelint>*";
    if (kind === "truncated") key += ">";
    if (kind === "permanent") record.expiry = "";
    if (kind === "invalid-expiry") record.expiry = "invalid";
    if (kind === "unexplained") record.notes = " ";
    assert.throws(() => readAuditPolicy({ low: true, allowlist: [{ [key]: record }] }));
  });
});

describe("audit command orchestration", () => {
  /** @param {{output: string, status: number}} production @param {{output: string, status: number}} complete */
  function run(production, complete) {
    const directory = mkdtempSync(join(tmpdir(), "dependency-audit-"));
    try {
      const npmCli = join(directory, "npm-fixture.mjs");
      writeFileSync(
        npmCli,
        `import { appendFileSync } from 'node:fs';
const calls = new URL('./calls.jsonl', import.meta.url);
appendFileSync(calls, JSON.stringify(process.argv.slice(2)) + '\\n', 'utf8');
const cases = ${JSON.stringify({ production, complete })};
const result = process.argv.includes('--omit=dev') ? cases.production : cases.complete;
process.stdout.write(result.output);
process.exitCode = result.status;
`,
        { encoding: "utf8", flag: "wx" }
      );
      const env = { ...process.env };
      // Windows folds environment-key case; remove inherited variants before selecting the fixture.
      for (const key of Object.keys(env)) {
        if (
          ["npm_execpath", "npm_config_omit", "npm_config_include", "node_env"].includes(
            key.toLowerCase()
          )
        )
          delete env[key];
      }
      const result = spawnSync(process.execPath, [join(root, "scripts/audit-dependencies.mjs")], {
        cwd: directory,
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
        env: {
          ...env,
          npm_execpath: npmCli,
          npm_config_omit: "dev",
          npm_config_include: "dev",
          NODE_ENV: "production",
        },
      });
      assert.equal(result.error, undefined);
      assert.ok(existsSync(join(directory, "calls.jsonl")), result.stderr || result.stdout);
      const calls = readFileSync(join(directory, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      return { ...result, calls };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  const clean = { output: JSON.stringify(report()), status: 0 };

  it("runs production first, includes every dependency class explicitly, and resolves files from the project", () => {
    const result = run(clean, clean);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.length, 2);
    assert.ok(result.calls[0].includes("--omit=dev"));
    assert.ok(result.calls[1].includes("--include=dev"));
    for (const call of result.calls) {
      for (const flag of [
        "--include=prod",
        "--include=optional",
        "--include=peer",
        "--audit-level=info",
        "--json",
      ])
        assert.ok(call.includes(flag));
    }
  });

  it("blocks production findings before running the complete audit, even for the excepted advisory", () => {
    const result = run({ output: JSON.stringify(stylelintReport()), status: 1 }, clean);
    assert.equal(result.status, 1);
    assert.equal(result.calls.length, 1);
    assert.match(result.stderr, /Unaccepted/u);
  });

  it.each(["{", '{"error":{"code":"ENOAUDIT"}}'])(
    "propagates a complete-audit failure (%s)",
    (output) => {
      const result = run(clean, { output, status: 1 });
      assert.equal(result.status, 1);
      assert.equal(result.calls.length, 2);
    }
  );
});
