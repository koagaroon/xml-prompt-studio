import { Allowlist } from "audit-ci";

const severities = ["info", "low", "moderate", "high", "critical"];
const advisoryUrl = /^https:\/\/github\.com\/advisories\/(GHSA(?:-[a-z0-9]{4}){3})$/u;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {string} value */
function isPackageToken(value) {
  return value.length > 0 && !/[>|*\s]/u.test(value);
}

/** @param {unknown} value @returns {import("audit-ci").AllowlistRecord[]} */
export function readAuditPolicy(value) {
  if (!isRecord(value) || value.low !== true || !Array.isArray(value.allowlist)) {
    throw new Error("Audit policy must block every severity and provide an allowlist.");
  }
  for (const entry of value.allowlist) {
    if (!isRecord(entry) || Object.keys(entry).length !== 1) {
      throw new Error("Audit exceptions must be individual advisory-and-path records.");
    }
    const [key, rule] = Object.entries(entry)[0];
    const [id, path, extra] = key.split("|");
    if (
      !advisoryUrl.test(`https://github.com/advisories/${id}`) ||
      !path ||
      extra !== undefined ||
      key.includes("*") ||
      path.split(">").some((part) => !isPackageToken(part)) ||
      !isRecord(rule) ||
      typeof rule.active !== "boolean" ||
      typeof rule.notes !== "string" ||
      rule.notes.trim() === "" ||
      typeof rule.expiry !== "string" ||
      !Number.isFinite(Date.parse(rule.expiry))
    ) {
      throw new Error("Audit exceptions require an exact advisory/path, explanation, and expiry.");
    }
  }
  return /** @type {import("audit-ci").AllowlistRecord[]} */ (value.allowlist);
}

/**
 * @typedef {{url: string}} Advisory
 * @typedef {{name: string, severity: string, isDirect: boolean, via: (string | Advisory)[]}} Vulnerability
 */

/**
 * @param {string} output
 * @param {number | null} status
 * @param {import("audit-ci").AllowlistRecord[]} [exceptions]
 * @returns {string[]}
 */
export function checkAuditReport(output, status, exceptions = []) {
  if (status !== 0 && status !== 1) {
    throw new Error(`npm audit did not complete (exit ${status ?? "unknown"}).`);
  }
  /** @type {unknown} */
  const report = JSON.parse(output);
  if (
    !isRecord(report) ||
    report.auditReportVersion !== 2 ||
    "error" in report ||
    !isRecord(report.vulnerabilities) ||
    !isRecord(report.metadata) ||
    !isRecord(report.metadata.vulnerabilities)
  ) {
    throw new Error("npm audit returned an error or an unsupported report.");
  }
  const records = report.vulnerabilities;
  const counts = report.metadata.vulnerabilities;
  if (
    Object.keys(counts).length !== severities.length + 1 ||
    Object.keys(counts).some((key) => key !== "total" && !severities.includes(key))
  ) {
    throw new Error("npm audit returned unsupported vulnerability counts.");
  }
  for (const [name, entry] of Object.entries(records)) {
    if (
      !isPackageToken(name) ||
      !isRecord(entry) ||
      entry.name !== name ||
      typeof entry.severity !== "string" ||
      !severities.includes(entry.severity) ||
      typeof entry.isDirect !== "boolean" ||
      !Array.isArray(entry.via) ||
      entry.via.length === 0
    ) {
      throw new Error(`Invalid npm audit dependency: ${name}.`);
    }
    for (const via of entry.via) {
      if (
        typeof via === "string"
          ? !Object.hasOwn(records, via)
          : !isRecord(via) || typeof via.url !== "string" || !advisoryUrl.test(via.url)
      ) {
        throw new Error(`Invalid npm audit advisory or dependency link in ${name}.`);
      }
    }
  }
  const vulnerabilities = /** @type {Record<string, Vulnerability>} */ (records);
  for (const severity of severities) {
    if (
      counts[severity] !==
      Object.values(vulnerabilities).filter((v) => v.severity === severity).length
    ) {
      throw new Error("npm audit vulnerability counts do not match the report.");
    }
  }
  if (
    counts.total !== Object.keys(vulnerabilities).length ||
    status !== (Object.keys(vulnerabilities).length > 0 ? 1 : 0)
  ) {
    throw new Error("npm audit exit status or total does not match the report.");
  }

  // audit-ci shortens shared npm dependency paths; preserve every direct caller before matching.
  /** @type {Set<string>} */
  const visited = new Set();
  /** @type {Set<string>} */
  const paths = new Set();
  let steps = 0;
  /** @param {string} name @param {string[]} parents */
  function visit(name, parents) {
    if (parents.includes(name) || parents.length >= 256 || ++steps > 10_000) {
      throw new Error("npm audit dependency paths are cyclic or exceed the review limit.");
    }
    visited.add(name);
    const path = [...parents, name];
    for (const via of vulnerabilities[name].via) {
      if (typeof via === "string") visit(via, path);
      else paths.add(`${via.url.slice(via.url.lastIndexOf("/") + 1)}|${path.join(">")}`);
    }
  }
  for (const entry of Object.values(vulnerabilities)) {
    if (entry.isDirect) visit(entry.name, []);
  }
  if (visited.size !== Object.keys(vulnerabilities).length) {
    throw new Error("npm audit contains vulnerable dependencies without a direct dependency path.");
  }
  const allowed = new Set(new Allowlist(exceptions).paths);
  const blocked = [...paths].filter((path) => !allowed.has(path));
  if (blocked.length > 0) {
    throw new Error(`Unaccepted npm audit findings:\n${blocked.sort().join("\n")}`);
  }
  return [...paths].sort();
}
