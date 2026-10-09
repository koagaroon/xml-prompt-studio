import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { MonitorError, parseStableSemver, reportExitCode } from "./dependency-currency.mjs";
import { createJsonRequester } from "./dependency-requests.mjs";
import {
  checkToolchains,
  inspectRustReleases,
  parseNpmToolchainPin,
  parseRustToolchainPin,
  supportsNodeMinimum,
} from "./dependency-toolchains.mjs";

const manifest = { packageManager: "npm@11.19.0", engines: { node: "^24.21.0" } };
const toolchain = '[toolchain]\nchannel = "1.98.0"\nprofile = "minimal"\n';

/** @param {string} version @param {string} node @returns {{ name: string, version: string, engines: { node: string }, deprecated?: string }} */
function npmRelease(version, node) {
  return { name: "npm", version, engines: { node } };
}

/** @param {string} latest @param {string} requirement */
function npmMetadata(latest = "12.2.0", requirement = "^22.22.2 || ^24.15.0 || >=26.0.0") {
  return {
    name: "npm",
    "dist-tags": { latest },
    versions: {
      "11.19.0": npmRelease("11.19.0", "^20.17.0 || >=22.9.0"),
      [latest]: npmRelease(latest, requirement),
    },
  };
}

/** @param {string} version */
function rustRelease(version) {
  return { tag_name: version, draft: false, prerelease: false };
}

/** @param {{ npm?: unknown, rust?: unknown, packageJson?: unknown, rustToolchain?: unknown }} options */
async function inspect({
  npm = npmMetadata(),
  rust = [rustRelease("1.99.0")],
  packageJson = manifest,
  rustToolchain = toolchain,
} = {}) {
  const request = createJsonRequester(async (url) =>
    Response.json(String(url).endsWith("/npm") ? npm : rust)
  );
  const options = { headers: { Accept: "application/json" }, maxBytes: 16 * 1024 };
  return await checkToolchains(packageJson, rustToolchain, {
    fetchNpmMetadata: () => request("https://example.test/npm", options),
    fetchRustReleases: () => request("https://example.test/rust", options),
  });
}

describe("build-tool pins", () => {
  it("reads npm's manifest pin and Rust's compiler independently from a minimum version", () => {
    assert.equal(parseNpmToolchainPin(manifest), "11.19.0");
    assert.equal(parseRustToolchainPin(toolchain), "1.98.0");
    assert.equal(
      parseRustToolchainPin("[toolchain] # compiler\nchannel = '1.98.0' # reviewed\n"),
      "1.98.0"
    );
  });

  it.each([
    {},
    null,
    { packageManager: "npm@latest" },
    { packageManager: "pnpm@11.19.0" },
    { packageManager: "npm@11.19.0-rc.1" },
    { packageManager: "npm@^11.19.0" },
  ])("rejects an absent or moving npm pin: %j", (value) =>
    assert.throws(() => parseNpmToolchainPin(value), MonitorError)
  );

  it.each([
    "",
    '[toolchain]\nchannel = "stable"\n',
    '[toolchain]\nchannel = "1.99.0-beta.1"\n',
    '[toolchain]\nchannel = "1.98"\n',
    '[other]\nchannel = "1.98.0"\n',
    '[toolchain]\nprofile = "minimal"\n[other]\nchannel = "1.98.0"\n',
    `${toolchain}[toolchain]\nchannel = "1.99.0"\n`,
    `${toolchain}"channel" = "1.99.0"\n`,
  ])("rejects absent, moving, or ambiguous Rust compiler evidence: %j", (value) => {
    assert.throws(() => parseRustToolchainPin(value), MonitorError);
  });
});

describe("npm Node engine compatibility", () => {
  const minimum = parseStableSemver("24.21.0");
  assert.ok(minimum);

  it("accepts the boundary and refuses a requirement one patch above it", () => {
    assert.equal(supportsNodeMinimum(minimum, ">=24.21.0"), true);
    assert.equal(supportsNodeMinimum(minimum, ">=24.21.1"), false);
    assert.equal(supportsNodeMinimum(minimum, "^22.22.2 || ^24.15.0 || >=26.0.0"), true);
    assert.equal(supportsNodeMinimum(minimum, ">=24.0.0 <25.0.0"), true);
    assert.equal(supportsNodeMinimum(minimum, "^22.0.0 || ^26.0.0"), false);
  });

  it.each([null, "", "*", ">=24", ">=24.21.0 || nonsense", ">=24.21.0 ||", "^024.21.0"])(
    "refuses unsupported metadata even when an earlier clause accepts the minimum: %j",
    (range) => assert.throws(() => supportsNodeMinimum(minimum, range), MonitorError)
  );
});

describe("toolchain request-to-report classification", () => {
  it("reports both current build tools without changing the project minimum", async () => {
    const rows = await inspect({
      npm: npmMetadata("11.19.0"),
      rust: [rustRelease("1.98.0")],
    });
    assert.deepEqual(
      rows.map(({ status }) => status),
      ["current", "current"]
    );
    assert.deepEqual(
      rows.map(({ ecosystem }) => ecosystem),
      ["npm toolchain", "Rust toolchain"]
    );
    assert.equal(reportExitCode(rows), 0);
    assert.equal(manifest.engines.node, "^24.21.0");
  });

  it("reports a compatible major npm upgrade for explicit compatibility review", async () => {
    const rows = await inspect();
    assert.equal(rows[0].locked, "11.19.0");
    assert.equal(rows[0].latest, "12.2.0");
    assert.equal(rows[0].status, "actionable");
    assert.match(rows[0].reason, /major update requires a compatibility review/u);
    assert.equal(rows[1].locked, "1.98.0");
    assert.equal(rows[1].latest, "1.99.0");
    assert.equal(rows[1].status, "actionable");
    assert.match(rows[1].reason, /separately from the Cargo source-build minimum/u);
    assert.equal(reportExitCode(rows), 1);
  });

  it("reports a same-major npm update without a major-migration warning", async () => {
    const rows = await inspect({ npm: npmMetadata("11.20.0") });
    assert.equal(rows[0].status, "actionable");
    assert.doesNotMatch(rows[0].reason, /major update/u);
  });

  it("holds a newer npm above the declared Node minimum", async () => {
    const rows = await inspect({
      npm: npmMetadata("12.2.0", ">=24.21.1"),
      rust: [rustRelease("1.98.0")],
    });
    assert.equal(rows[0].status, "hold");
    assert.match(rows[0].reason, /source-build minimum 24\.21\.0/u);
    assert.equal(reportExitCode(rows), 0);
  });

  it("keeps a compatible maintenance update actionable when latest needs a newer Node", async () => {
    const npm = npmMetadata("12.2.0", ">=26.0.0");
    npm.versions["11.20.0"] = npmRelease("11.20.0", ">=24.15.0");
    npm.versions["11.21.0"] = { ...npmRelease("11.21.0", ">=24.15.0"), deprecated: "withdrawn" };
    npm.versions["13.0.0"] = npmRelease("13.0.0", ">=24.15.0");
    const rows = await inspect({ npm });
    assert.equal(rows[0].status, "actionable");
    assert.equal(rows[0].latest, "11.20.0");
    assert.match(rows[0].reason, /npm 12\.2\.0 is held/u);
  });

  it("rejects a pinned npm that already violates the declared Node minimum", async () => {
    const npm = npmMetadata();
    npm.versions["11.19.0"].engines.node = ">=24.21.1";
    const rows = await inspect({ npm });
    assert.equal(rows[0].status, "error");
    assert.match(rows[0].reason, /pinned npm.*does not support/u);
    assert.equal(reportExitCode(rows), 2);
  });

  it("evaluates the oldest declared Node alternative", async () => {
    const rows = await inspect({
      packageJson: { ...manifest, engines: { node: "^26.0.0 || ^22.22.0" } },
    });
    assert.equal(rows[0].status, "hold");
    assert.match(rows[0].reason, /minimum 22\.22\.0/u);
  });

  it.each([
    ["null", null],
    ["wrong package", { ...npmMetadata(), name: "another-package" }],
    ["prerelease latest", npmMetadata("12.3.0-rc.1")],
    [
      "missing engines",
      { ...npmMetadata(), versions: { "12.2.0": { name: "npm", version: "12.2.0" } } },
    ],
    [
      "wrong release",
      { ...npmMetadata(), versions: { "12.2.0": { name: "npm", version: "12.1.0" } } },
    ],
    ["invalid range", npmMetadata("12.2.0", "^24.0.0 || unknown")],
  ])("reports malformed npm metadata (%s) as an error", async (_label, npm) => {
    const rows = await inspect({ npm });
    assert.equal(rows[0].status, "error");
    assert.equal(rows[1].status, "actionable");
    assert.equal(reportExitCode(rows), 2);
  });

  it("rejects a pin newer than official metadata for either tool", async () => {
    const rows = await inspect({
      npm: npmMetadata("11.18.0"),
      rust: [rustRelease("1.97.0")],
    });
    assert.deepEqual(
      rows.map(({ status }) => status),
      ["error", "error"]
    );
  });

  it("keeps malformed local pins separate from healthy toolchain evidence", async () => {
    const rows = await inspect({ rustToolchain: '[toolchain]\nchannel = "stable"\n' });
    assert.equal(rows[0].status, "actionable");
    assert.equal(rows[1].status, "error");
    assert.equal(rows[1].locked, "unknown");
  });

  it("reports malformed Rust metadata without discarding npm results", async () => {
    const rows = await inspect({ rust: [{ tag_name: "1.99.0", draft: false }] });
    assert.equal(rows[0].status, "actionable");
    assert.equal(rows[1].status, "error");
    assert.match(rows[1].reason, /invalid Rust release entry/u);
    assert.equal(reportExitCode(rows), 2);
  });

  it.each(["network", "invalid JSON", "HTTP failure"])(
    "reports %s failures instead of current or held toolchain status",
    async (failure) => {
      const request = createJsonRequester(
        async () => {
          if (failure === "network") throw new TypeError("offline");
          return new Response(failure === "invalid JSON" ? "{" : "forbidden", {
            status: failure === "HTTP failure" ? 403 : 200,
          });
        },
        async () => {}
      );
      const rows = await checkToolchains(manifest, toolchain, {
        fetchNpmMetadata: () =>
          request("https://example.test/npm", { headers: {}, maxBytes: 1024 }),
        fetchRustReleases: async () => [rustRelease("1.98.0")],
      });
      assert.equal(rows[0].status, "error");
      assert.equal(rows[1].status, "current");
      assert.match(rows[0].reason, /Remote metadata/u);
    }
  );
});

describe("official Rust release selection", () => {
  it("ignores draft and prerelease releases, including mislabeled prerelease tags", () => {
    assert.equal(
      inspectRustReleases([
        { ...rustRelease("2.0.0"), draft: true },
        { ...rustRelease("1.100.0"), prerelease: true },
        rustRelease("1.101.0-beta.1"),
        rustRelease("1.99.0"),
        rustRelease("1.98.1"),
      ]),
      "1.99.0"
    );
  });

  it.each([null, [], [{}], [{ tag_name: "1.99.0", draft: false }], [rustRelease("nightly")]])(
    "rejects malformed or absent stable Rust evidence: %j",
    (releases) => assert.throws(() => inspectRustReleases(releases), MonitorError)
  );
});
