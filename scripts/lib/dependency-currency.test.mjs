import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  MonitorError,
  classifyActionCurrency,
  classifyCargoCurrency,
  classifyNpmCurrency,
  classifyRolldownCurrency,
  classifyVersion,
  collectCargoTargets,
  collectNpmTargets,
  compareSemver,
  findRolldownLock,
  inspectCratesMetadata,
  inspectGitHubReleases,
  inspectNpmMetadata,
  inspectNpmRangeMetadata,
  inspectPublishedBinding,
  inspectRolldownRelease,
  newestStable,
  parseActionReferences,
  parseNpmAlias,
  parseProjectMsrv,
  parseStableSemver,
  readBoundedResponse,
  renderReport,
  reportExitCode,
  sanitizeReportField,
  satisfiesCargoRequirement,
  satisfiesNpmRequirement,
  validateInstallScriptPolicy,
} from "./dependency-currency.mjs";

const SHA_ONE = "1111111111111111111111111111111111111111";
const SHA_TWO = "2222222222222222222222222222222222222222";

describe("stable semantic versions", () => {
  it("parses stable versions and rejects prereleases or malformed values", () => {
    assert.deepEqual(parseStableSemver("12.3.4+build.7"), {
      raw: "12.3.4+build.7",
      major: 12,
      minor: 3,
      patch: 4,
    });
    assert.equal(parseStableSemver("1.2.3-rc.1"), null);
    assert.equal(parseStableSemver("01.2.3"), null);
    assert.equal(parseStableSemver("1.2"), null);
  });

  it("compares and selects stable releases without admitting prereleases", () => {
    const newer = parseStableSemver("2.0.0");
    const older = parseStableSemver("1.99.99");
    assert.ok(newer !== null && older !== null);
    assert.equal(compareSemver(newer, older), 1);
    assert.equal(newestStable(["2.0.0-beta.1", "1.9.0", "1.10.0"]), "1.10.0");
    assert.equal(newestStable(["6.0.3", "7.0.2", "6.1.0"], 6), "6.1.0");
  });
});

describe("npm dependency inspection", () => {
  it("parses unscoped and scoped npm aliases", () => {
    assert.deepEqual(parseNpmAlias("npm:typescript@~7.0.2"), {
      registryName: "typescript",
      range: "~7.0.2",
    });
    assert.deepEqual(parseNpmAlias("npm:@typescript/typescript6@6.0.2"), {
      registryName: "@typescript/typescript6",
      range: "6.0.2",
    });
    assert.equal(parseNpmAlias("^1.0.0"), null);
    assert.throws(() => parseNpmAlias("npm:@scope/package"), MonitorError);
  });

  it("collects every direct package, aliases, and the effective TS6 compiler", () => {
    const packageJson = {
      dependencies: { react: "^19.2.8" },
      devDependencies: {
        "@typescript/native": "npm:typescript@~7.0.2",
        typescript: "npm:@typescript/typescript6@6.0.2",
      },
    };
    const lockfile = {
      packages: {
        "": {
          dependencies: { react: "^19.2.8" },
          devDependencies: {
            "@typescript/native": "npm:typescript@~7.0.2",
            typescript: "npm:@typescript/typescript6@6.0.2",
          },
        },
        "node_modules/react": { version: "19.2.8" },
        "node_modules/@typescript/native": { name: "typescript", version: "7.0.2" },
        "node_modules/typescript": {
          name: "@typescript/typescript6",
          version: "6.0.2",
        },
        "node_modules/@typescript/old": { name: "typescript", version: "6.0.3" },
      },
    };
    const targets = collectNpmTargets(packageJson, lockfile);
    assert.equal(targets.length, 4);
    assert.deepEqual(
      targets.find((target) => target.declaredName === "@typescript/native"),
      {
        declaredName: "@typescript/native",
        registryName: "typescript",
        requested: "npm:typescript@~7.0.2",
        locked: "7.0.2",
        kind: "development",
        major: null,
      }
    );
    assert.deepEqual(
      targets.find((target) => target.kind === "toolchain"),
      {
        declaredName: "typescript (effective TS6 compiler)",
        registryName: "typescript",
        requested: "major 6",
        locked: "6.0.3",
        kind: "toolchain",
        major: 6,
      }
    );
  });

  it("includes optional and peer dependencies instead of silently omitting them", () => {
    const packageJson = {
      dependencies: {},
      devDependencies: {},
      optionalDependencies: { "optional-tool": "^1.0.0" },
      peerDependencies: { "peer-tool": "^2.0.0" },
    };
    const lockfile = {
      packages: {
        "": {
          dependencies: {},
          devDependencies: {},
          optionalDependencies: { "optional-tool": "^1.0.0" },
          peerDependencies: { "peer-tool": "^2.0.0" },
        },
        "node_modules/optional-tool": { version: "1.0.1" },
        "node_modules/peer-tool": { version: "2.0.1" },
      },
    };
    assert.deepEqual(
      collectNpmTargets(packageJson, lockfile).map((target) => [target.declaredName, target.kind]),
      [
        ["optional-tool", "optional"],
        ["peer-tool", "peer"],
      ]
    );
  });

  it("selects the newest non-deprecated stable npm release", () => {
    const metadata = {
      name: "example",
      "dist-tags": { latest: "1.10.0" },
      versions: {
        "1.9.0": { name: "example", version: "1.9.0" },
        "1.10.0": { name: "example", version: "1.10.0" },
        "2.0.0-beta.1": { name: "example", version: "2.0.0-beta.1" },
        "2.0.0": { name: "example", version: "2.0.0", deprecated: "do not use" },
      },
    };
    assert.equal(inspectNpmMetadata(metadata, "example"), "1.10.0");
    assert.equal(inspectNpmMetadata(metadata, "example", 1), "1.10.0");
  });

  it("honors npm latest for ordinary packages and uses max stable only for a tracked major", () => {
    const metadata = {
      name: "example",
      "dist-tags": { latest: "1.5.0" },
      versions: {
        "1.5.0": { name: "example", version: "1.5.0" },
        "1.6.0": { name: "example", version: "1.6.0" },
        "2.0.0": { name: "example", version: "2.0.0" },
      },
    };
    assert.equal(inspectNpmMetadata(metadata, "example"), "1.5.0");
    assert.equal(inspectNpmMetadata(metadata, "example", 1), "1.6.0");
    assert.throws(
      () => inspectNpmMetadata({ ...metadata, "dist-tags": { latest: "2.1.0-beta.1" } }, "example"),
      /not a stable release/u
    );
    assert.throws(
      () =>
        inspectNpmMetadata(
          {
            ...metadata,
            versions: {
              ...metadata.versions,
              "1.5.0": { name: "wrong-package", version: "1.5.0" },
            },
          },
          "example"
        ),
      /metadata is unusable/u
    );
  });

  it("classifies current, actionable, and inconsistent registry versions", () => {
    assert.equal(classifyVersion("1.2.3", "1.2.3").status, "current");
    assert.equal(classifyVersion("1.2.3", "1.2.4").status, "actionable");
    assert.equal(classifyVersion("1.2.4", "1.2.3").status, "error");
  });

  it("requires the strict install-script allowlist to exactly match the lockfile", () => {
    const lockfile = {
      packages: {
        "": {},
        "node_modules/fsevents": { version: "2.3.3", hasInstallScript: true },
      },
    };
    assert.deepEqual(
      validateInstallScriptPolicy(
        { allowScripts: { "fsevents@2.3.3": true } },
        lockfile,
        "strict-allow-scripts=true\n"
      ),
      ["fsevents@2.3.3"]
    );
    assert.throws(
      () =>
        validateInstallScriptPolicy(
          { allowScripts: { "fsevents@2.3.2": true } },
          lockfile,
          "strict-allow-scripts=true\n"
        ),
      /differs/u
    );
    assert.throws(
      () =>
        validateInstallScriptPolicy(
          { allowScripts: { "fsevents@2.3.3": true } },
          lockfile,
          "strict-allow-scripts=true\nstrict-allow-scripts=false\n"
        ),
      /must enable/u
    );
  });
});

describe("Node type compatibility policy", () => {
  const manifest = { engines: { node: "^26.0.0 || ^22.13.0 || ^24.0.0" } };
  /** @type {import("./dependency-currency.mjs").NpmTarget} */
  const target = {
    declaredName: "@types/node",
    registryName: "@types/node",
    requested: "~22.13.17",
    locked: "22.13.17",
    kind: "development",
    major: null,
  };
  /** @param {string[]} versions @param {string} latest */
  const metadata = (versions, latest) => ({
    name: "@types/node",
    "dist-tags": { latest },
    versions: Object.fromEntries(
      versions.map((version) => [version, { name: "@types/node", version }])
    ),
  });

  it("accepts the current API line and holds the immediately newer minor", () => {
    const current = metadata(["22.13.17"], "22.13.17");
    assert.equal(classifyNpmCurrency(target, current, manifest).status, "current");
    const held = classifyNpmCurrency(
      target,
      metadata(["22.13.17", "22.14.0"], "22.14.0"),
      manifest
    );
    assert.equal(held.status, "hold");
    assert.equal(held.latest, "22.14.0");
    assert.match(held.reason, /Node 22\.13\.0/u);
    assert.equal(reportExitCode([held]), 0);
  });

  it.each(["~22.13.17", "22.13.17"])(
    "reports an eligible patch for %s even when a newer major is held",
    (requested) => {
      const result = classifyNpmCurrency(
        { ...target, requested },
        metadata(["22.13.17", "22.13.18", "26.6.1"], "26.6.1"),
        manifest
      );
      assert.equal(result.status, "actionable");
      assert.equal(result.latest, "22.13.18");
      assert.match(result.reason, /held/u);
      assert.equal(reportExitCode([result]), 1);
    }
  );

  it("does not confuse runtime patch numbers with type-package patch numbers", () => {
    const result = classifyNpmCurrency(target, metadata(["22.13.17"], "22.13.17"), {
      engines: { node: "^22.13.99" },
    });
    assert.equal(result.status, "current");
  });

  it("selects published API-line patches independently of latest tag ordering", () => {
    const releases = metadata(
      ["22.13.16", "22.13.17", "22.13.18", "22.13.19-rc.1", "22.13.20"],
      "22.13.16"
    );
    const inspected = {
      ...releases,
      versions: {
        ...releases.versions,
        "22.13.20": { name: "@types/node", version: "22.13.20", deprecated: "withdrawn" },
      },
    };
    const result = classifyNpmCurrency(target, inspected, manifest);
    assert.equal(result.status, "actionable");
    assert.equal(result.latest, "22.13.18");
  });

  it.each([
    { requested: "^22.13.17", locked: "22.13.17" },
    { requested: "~22.14.0", locked: "22.14.0" },
    { requested: "~22.13.17", locked: "22.14.0" },
    { requested: "~22.13.18", locked: "22.13.17" },
  ])("refuses a declaration or lock that escapes the supported line: %j", (change) => {
    assert.throws(
      () =>
        classifyNpmCurrency(
          { ...target, ...change },
          metadata(["22.13.17", "22.14.0"], "22.14.0"),
          manifest
        ),
      /exact or tilde 22\.13\.x/u
    );
  });

  it("keeps a lock newer than published compatible metadata as an error", () => {
    const result = classifyNpmCurrency(
      { ...target, locked: "22.13.18" },
      metadata(["22.13.17", "26.6.1"], "26.6.1"),
      manifest
    );
    assert.equal(result.status, "error");
    assert.equal(reportExitCode([result]), 2);
  });

  it("does not hide invalid registry metadata behind a held release", () => {
    const releases = metadata(["22.13.17", "22.13.18", "26.6.1"], "26.6.1");
    assert.throws(
      () => classifyNpmCurrency(target, { ...releases, "dist-tags": {} }, manifest),
      MonitorError
    );
    assert.throws(
      () =>
        classifyNpmCurrency(
          target,
          {
            ...releases,
            versions: {
              ...releases.versions,
              "22.13.18": { name: "wrong-package", version: "22.13.18" },
            },
          },
          manifest
        ),
      /range metadata is unusable/u
    );
    assert.throws(
      () => classifyNpmCurrency(target, metadata(["26.6.1"], "26.6.1"), manifest),
      /no stable @types\/node release/u
    );
  });

  it("refuses package aliases that would bypass the Node type policy", () => {
    assert.throws(
      () => classifyNpmCurrency({ ...target, registryName: "other-types" }, {}, manifest),
      /official Node type package/u
    );
    assert.throws(
      () =>
        classifyNpmCurrency(
          { ...target, requested: "npm:@types/node@26.6.1" },
          metadata(["26.6.1"], "26.6.1"),
          manifest
        ),
      /exact or tilde/u
    );
  });

  it.each([{}, { engines: { node: ">=22.13.0" } }, { engines: { node: "^22.13.0 || invalid" } }])(
    "refuses a missing or unreviewed Node engine declaration: %j",
    (invalidManifest) => {
      assert.throws(
        () => classifyNpmCurrency(target, metadata(["22.13.17"], "22.13.17"), invalidManifest),
        MonitorError
      );
    }
  );

  it("requires a new type line when the minimum runtime changes", () => {
    const changedManifest = { engines: { node: "^24.0.0 || ^26.0.0" } };
    const releases = metadata(["22.13.17", "24.0.1", "26.6.1"], "26.6.1");
    assert.throws(() => classifyNpmCurrency(target, releases, changedManifest), /24\.0\.x/u);
    assert.equal(
      classifyNpmCurrency(
        { ...target, requested: "~24.0.1", locked: "24.0.1" },
        releases,
        changedManifest
      ).status,
      "hold"
    );
  });

  it("preserves ordinary package latest-tag behavior without a Node policy", () => {
    const ordinaryTarget = {
      ...target,
      registryName: "example",
      declaredName: "example",
      requested: "^1.5.0",
      locked: "1.5.0",
    };
    const releases = {
      name: "example",
      "dist-tags": { latest: "1.5.0" },
      versions: {
        "1.5.0": { name: "example", version: "1.5.0" },
        "1.6.0": { name: "example", version: "1.6.0" },
      },
    };
    assert.equal(classifyNpmCurrency(ordinaryTarget, releases, {}).status, "current");
  });
});

describe("Cargo dependency inspection", () => {
  it("implements the Cargo caret, tilde, and exact ranges used by direct dependencies", () => {
    assert.equal(satisfiesCargoRequirement("2.99.0", "2.11.5"), true);
    assert.equal(satisfiesCargoRequirement("3.0.0", "2.11.5"), false);
    assert.equal(satisfiesCargoRequirement("0.2.9", "^0.2.3"), true);
    assert.equal(satisfiesCargoRequirement("0.3.0", "^0.2.3"), false);
    assert.equal(satisfiesCargoRequirement("1.2.9", "~1.2.3"), true);
    assert.equal(satisfiesCargoRequirement("1.3.0", "~1.2.3"), false);
    assert.equal(satisfiesCargoRequirement("1.2.3", "=1.2.3"), true);
  });

  it("uses root dependency edges when two compatible versions are locked", () => {
    const source = "registry+https://github.com/rust-lang/crates.io-index";
    const metadata = {
      version: 1,
      packages: [
        {
          id: "root",
          dependencies: [
            {
              name: "arboard",
              rename: null,
              req: "^3.6.1",
              kind: null,
              optional: false,
              source,
            },
            {
              name: "tauri",
              rename: "desktop-runtime",
              req: "^2.11.5",
              kind: null,
              optional: false,
              source,
            },
            {
              name: "tauri-build",
              rename: null,
              req: "^2.6.3",
              kind: "build",
              optional: false,
              source,
            },
          ],
        },
        { id: "arboard-direct", name: "arboard", version: "3.6.1", source },
        { id: "tauri-transitive", name: "tauri", version: "2.11.5", source },
        { id: "tauri-direct", name: "tauri", version: "2.12.0", source },
        { id: "tauri-build-direct", name: "tauri-build", version: "2.6.3", source },
      ],
      resolve: {
        root: "root",
        nodes: [
          {
            id: "root",
            deps: [
              {
                name: "arboard",
                pkg: "arboard-direct",
                dep_kinds: [{ kind: null, target: null }],
              },
              {
                name: "desktop_runtime",
                pkg: "tauri-direct",
                dep_kinds: [{ kind: null, target: null }],
              },
              {
                name: "tauri_build",
                pkg: "tauri-build-direct",
                dep_kinds: [{ kind: "build", target: null }],
              },
            ],
          },
          { id: "arboard-direct", deps: [] },
          { id: "tauri-transitive", deps: [] },
          { id: "tauri-direct", deps: [] },
          { id: "tauri-build-direct", deps: [] },
        ],
      },
    };
    assert.deepEqual(
      collectCargoTargets(metadata).map((target) => [target.declaredName, target.locked]),
      [
        ["arboard", "3.6.1"],
        ["desktop-runtime", "2.12.0"],
        ["tauri-build", "2.6.3"],
      ]
    );
  });

  it("ignores prerelease and yanked crate versions", () => {
    const metadata = {
      crate: { id: "arboard" },
      versions: [
        { num: "4.0.0-beta.1", yanked: false, rust_version: "1.88" },
        { num: "3.7.0", yanked: true, rust_version: "1.88" },
        { num: "3.6.1", yanked: false, rust_version: "1.71" },
      ],
    };
    assert.deepEqual(
      inspectCratesMetadata(
        metadata,
        "arboard",
        parseProjectMsrv(`
[package]
rust-version = "1.88"
`)
      ),
      {
        latest: "3.6.1",
        compatibleLatest: "3.6.1",
        latestRustVersion: "1.71",
        candidateRustVersion: "1.71",
      }
    );
  });

  it("holds releases above the project MSRV and flags missing rust_version evidence", () => {
    const msrv = parseProjectMsrv(`[package]\nrust-version = "1.88"\n`);
    const held = inspectCratesMetadata(
      {
        crate: { id: "example" },
        versions: [
          { num: "2.0.0", yanked: false, rust_version: "1.90" },
          { num: "1.5.0", yanked: false, rust_version: "1.88" },
        ],
      },
      "example",
      msrv
    );
    assert.equal(classifyCargoCurrency("1.5.0", held, msrv.raw).status, "hold");
    assert.match(classifyCargoCurrency("1.5.0", held, msrv.raw).reason, /requires Rust 1\.90/u);

    const unknown = inspectCratesMetadata(
      {
        crate: { id: "example" },
        versions: [
          { num: "1.6.0", yanked: false, rust_version: null },
          { num: "1.5.0", yanked: false, rust_version: "1.88" },
        ],
      },
      "example",
      msrv
    );
    const update = classifyCargoCurrency("1.5.0", unknown, msrv.raw);
    assert.equal(update.status, "actionable");
    assert.match(update.reason, /exact resolved graph must be verified at Rust 1\.88/u);
  });
});

describe("GitHub Action pin inspection", () => {
  it("parses full-SHA pins and rejects moving refs or missing tag comments", () => {
    const parsed = parseActionReferences([
      {
        path: ".github/workflows/ci.yml",
        content: [
          `  - uses: actions/checkout@${SHA_ONE} # v7.0.1`,
          "  - uses: actions/setup-node@v7",
          "  - uses: ./local-action",
        ].join("\n"),
      },
    ]);
    assert.deepEqual(parsed.targets, [
      {
        identifier: "actions/checkout",
        repository: "actions/checkout",
        pin: SHA_ONE,
        declaredTag: "v7.0.1",
        locations: [".github/workflows/ci.yml:1"],
      },
    ]);
    assert.equal(parsed.errors.length, 1);
    assert.match(parsed.errors[0].reason, /full commit SHA/u);
  });

  it("deduplicates the same action pin across workflow files", () => {
    const line = `uses: actions/cache/restore@${SHA_ONE} # v6.1.0`;
    const parsed = parseActionReferences([
      { path: "a.yml", content: line },
      { path: "b.yml", content: line },
    ]);
    assert.equal(parsed.targets.length, 1);
    assert.equal(parsed.targets[0].repository, "actions/cache");
  });

  it("fails closed on unsupported uses syntax but ignores shell text in block scalars", () => {
    const parsed = parseActionReferences([
      {
        path: ".github/workflows/ci.yml",
        content: [
          `steps: [{ uses: actions/checkout@${SHA_ONE} }]`,
          "- run: |",
          "    echo 'uses: actions/setup-node@v7'",
          `- "uses": actions/cache@${SHA_ONE} # v6.1.0`,
        ].join("\n"),
      },
    ]);
    assert.equal(parsed.targets.length, 0);
    assert.equal(parsed.errors.length, 2);
    assert.deepEqual(
      parsed.errors.map((error) => error.location),
      [".github/workflows/ci.yml:1", ".github/workflows/ci.yml:4"]
    );
  });

  it("treats tag dereference mismatch as an error before considering updates", () => {
    const action = { pin: SHA_ONE, declaredTag: "v7.0.0" };
    assert.equal(classifyActionCurrency(action, SHA_TWO, "v7.0.1", SHA_TWO).status, "error");
    assert.equal(classifyActionCurrency(action, SHA_ONE, "v7.0.1", SHA_TWO).status, "actionable");
    assert.equal(
      classifyActionCurrency({ pin: SHA_ONE, declaredTag: "v7.0.1" }, SHA_ONE, "v7.0.1", SHA_ONE)
        .status,
      "current"
    );
  });

  it("reports quoted uses keys in flow mappings instead of silently omitting actions", () => {
    const lines = [
      `steps: [{ "uses": actions/checkout@${SHA_ONE} }]`,
      `- { 'uses': actions/checkout@${SHA_ONE} }`,
      `- { name: checkout, "uses": actions/checkout@${SHA_ONE} }`,
      `jobs: { test: { steps: [{ 'uses': actions/checkout@${SHA_ONE} }] } }`,
      `steps: &reused [{ "uses": actions/checkout@${SHA_ONE} }]`,
    ];
    const parsed = parseActionReferences([{ path: "flow.yml", content: lines.join("\n") }]);
    assert.deepEqual(parsed.targets, []);
    assert.deepEqual(
      parsed.errors.map(({ location, dependency }) => ({ location, dependency })),
      lines.map((_, index) => ({
        location: `flow.yml:${index + 1}`,
        dependency: "unsupported uses syntax",
      }))
    );
  });

  it("ignores quoted uses text in commands, scalar values, and comments", () => {
    const parsed = parseActionReferences([
      {
        path: "literals.yml",
        content: [
          `- run: echo '{ "uses": actions/checkout@${SHA_ONE} }'`,
          `- run: 'echo { "uses": actions/checkout@${SHA_ONE} }'`,
          `- { run: 'echo { "uses": actions/checkout@${SHA_ONE} }' }`,
          `- { name: "a uses: label", run: 'echo ''uses'': text' }`,
          `# steps: [{ "uses": actions/checkout@${SHA_ONE} }]`,
          `- "run": |`,
          `    echo '{ "uses": actions/checkout@${SHA_ONE} }'`,
          `    uses: text in a script`,
          `- uses: actions/checkout@${SHA_ONE} # v7.0.1`,
        ].join("\n"),
      },
    ]);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.targets.length, 1);
    assert.deepEqual(parsed.targets[0].locations, ["literals.yml:9"]);
  });

  it.each(["|", ">", "|2", "|2-", "|-2", ">2+", ">+2", "&script |2-", "!!str >-2"])(
    "keeps uses text inside run: %s scalar content",
    (header) => {
      const parsed = parseActionReferences([
        {
          path: "block.yml",
          content: [
            `  - run: ${header}`,
            `      uses: actions/setup-node@${SHA_TWO} # v7.0.1`,
            `    shell: bash`,
            `  - uses: actions/checkout@${SHA_ONE} # v7.0.1`,
          ].join("\n"),
        },
      ]);
      assert.deepEqual(parsed.errors, []);
      assert.equal(parsed.targets.length, 1);
      assert.deepEqual(parsed.targets[0].locations, ["block.yml:4"]);
    }
  );

  it.each(["|", ">2-", "&action |-2"])(
    "reports uses: %s itself as unsupported rather than skipping the declaration",
    (header) => {
      const parsed = parseActionReferences([
        {
          path: "action-block.yml",
          content: [
            `  - uses: ${header}`,
            `      actions/checkout@${SHA_ONE}`,
            `  - uses: actions/setup-node@${SHA_TWO} # v7.0.1`,
          ].join("\n"),
        },
      ]);
      assert.equal(parsed.errors.length, 1);
      assert.equal(parsed.errors[0].dependency, "unsupported uses syntax");
      assert.equal(parsed.errors[0].location, "action-block.yml:1");
      assert.equal(parsed.targets.length, 1);
      assert.deepEqual(parsed.targets[0].locations, ["action-block.yml:3"]);
    }
  );

  it.each(["'", '"'])("keeps multiline %s scalar contents out of the action inventory", (quote) => {
    const parsed = parseActionReferences([
      {
        path: "quoted.yml",
        content: [
          `- run: ${quote}echo first line`,
          `    uses: actions/setup-node@${SHA_TWO} # v7.0.1`,
          `    last line${quote}`,
          `- uses: actions/checkout@${SHA_ONE} # v7.0.1`,
        ].join("\n"),
      },
    ]);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.targets.length, 1);
    assert.deepEqual(parsed.targets[0].locations, ["quoted.yml:4"]);
  });

  it("resumes flow-key inspection after multiline quoted content and ignores plain apostrophes", () => {
    const parsed = parseActionReferences([
      {
        path: "flow-quoted.yml",
        content: [
          `steps: [{ run: "echo first line`,
          `    uses: actions/setup-node@${SHA_TWO} # v7.0.1`,
          `    last line", 'uses': actions/checkout@${SHA_ONE} }]`,
          `- { name: John's job, uses: actions/checkout@${SHA_ONE} }`,
        ].join("\n"),
      },
    ]);
    assert.deepEqual(parsed.targets, []);
    assert.deepEqual(
      parsed.errors.map(({ location }) => location),
      ["flow-quoted.yml:3", "flow-quoted.yml:4"]
    );
  });

  it("reports an unterminated quoted scalar instead of claiming a complete inventory", () => {
    const parsed = parseActionReferences([{ path: "broken.yml", content: '- run: "unterminated' }]);
    assert.equal(parsed.errors.length, 1);
    assert.match(parsed.errors[0].reason, /unterminated quoted scalar/u);
  });

  it("selects the newest stable non-draft GitHub release", () => {
    assert.equal(
      inspectGitHubReleases([
        { tag_name: "v8.0.0-beta.1", draft: false, prerelease: true },
        { tag_name: "v7.0.0", draft: false, prerelease: false },
        { tag_name: "v7.0.1", draft: false, prerelease: false },
        { tag_name: "v9.0.0", draft: true, prerelease: false },
      ]),
      "v7.0.1"
    );
    assert.throws(
      () => inspectGitHubReleases([{ tag_name: "v7.0.1", draft: "false", prerelease: false }]),
      /invalid action release entry/u
    );
  });
});

describe("Vite-scoped Rolldown safety gate", () => {
  const metadata = {
    name: "rolldown",
    "dist-tags": { latest: "2.0.0" },
    versions: {
      "1.2.5": {
        name: "rolldown",
        version: "1.2.5",
        optionalDependencies: {
          "@rolldown/binding-linux-x64-gnu": "1.2.5",
          "@rolldown/binding-win32-x64-msvc": "1.2.5",
        },
      },
      "1.3.0": { name: "rolldown", version: "1.3.0" },
      "2.0.0": { name: "rolldown", version: "2.0.0" },
    },
  };

  it("finds a Vite nested resolution before a root resolution", () => {
    assert.deepEqual(
      findRolldownLock({
        packages: {
          "node_modules/vite": { dependencies: { rolldown: "~1.2.1" } },
          "node_modules/rolldown": { version: "1.2.5" },
          "node_modules/vite/node_modules/rolldown": { version: "1.2.4" },
        },
      }),
      { locked: "1.2.4", requested: "~1.2.1" }
    );
  });

  it("selects the newest release allowed by Vite even when global latest is outside range", () => {
    assert.equal(satisfiesNpmRequirement("1.2.5", "~1.2.1"), true);
    assert.equal(satisfiesNpmRequirement("1.3.0", "~1.2.1"), false);
    assert.equal(inspectNpmRangeMetadata(metadata, "rolldown", "~1.2.1"), "1.2.5");
    assert.throws(
      () => inspectNpmRangeMetadata(metadata, "rolldown", ">=1.2.1"),
      /Unsupported npm version requirement/u
    );
  });

  it("holds a newer release when one referenced native package is unpublished", () => {
    const bindings = inspectRolldownRelease(metadata, "1.2.5");
    const lockedBinding = "@rolldown/binding-linux-x64-gnu@1.2.4";
    const result = classifyRolldownCurrency({
      locked: "1.2.4",
      latest: "1.2.5",
      lockedBindings: [lockedBinding],
      latestBindings: bindings,
      publishedBindings: [lockedBinding, bindings[0]],
    });
    assert.equal(result.status, "hold");
    assert.equal(
      result.reason,
      "Rolldown 1.2.5 references unpublished native packages: @rolldown/binding-win32-x64-msvc@1.2.5."
    );
  });

  it("promotes a newer release only after every native package is published", () => {
    const bindings = inspectRolldownRelease(metadata, "1.2.5");
    const lockedBinding = "@rolldown/binding-linux-x64-gnu@1.2.4";
    assert.equal(
      classifyRolldownCurrency({
        locked: "1.2.4",
        latest: "1.2.5",
        lockedBindings: [lockedBinding],
        latestBindings: bindings,
        publishedBindings: [lockedBinding, ...bindings],
      }).status,
      "actionable"
    );
    assert.equal(
      classifyRolldownCurrency({
        locked: "1.2.5",
        latest: "1.2.5",
        lockedBindings: bindings,
        latestBindings: bindings,
        publishedBindings: bindings,
      }).status,
      "current"
    );
  });

  it("treats an incomplete locked release as an error and validates package integrity", () => {
    const binding = "@rolldown/binding-win32-x64-msvc@1.2.5";
    assert.equal(
      classifyRolldownCurrency({
        locked: "1.2.5",
        latest: "1.2.5",
        lockedBindings: [binding],
        latestBindings: [binding],
        publishedBindings: [],
      }).status,
      "error"
    );
    assert.equal(
      inspectPublishedBinding(
        {
          name: "@rolldown/binding-win32-x64-msvc",
          version: "1.2.5",
          dist: { integrity: "sha512-example" },
        },
        binding
      ),
      true
    );
    assert.equal(
      inspectPublishedBinding(
        {
          name: "@rolldown/binding-win32-x64-msvc",
          version: "1.2.5",
          dist: {},
        },
        binding
      ),
      false
    );
  });
});

describe("deterministic reporting", () => {
  /** @type {import("./dependency-currency.mjs").CurrencyRow[]} */
  const rows = [
    {
      ecosystem: "npm",
      dependency: "current-package",
      locked: "1.0.0",
      latest: "1.0.0",
      status: "current",
      reason: "Current.",
    },
    {
      ecosystem: "Cargo",
      dependency: "held-package",
      locked: "1.0.0",
      latest: "1.1.0",
      status: "hold",
      reason: "Held.",
    },
  ];

  it("prints deterministic counts and returns success for current and held rows", () => {
    const report = renderReport(rows);
    assert.match(report, /current=1 actionable=0 hold=1 error=0/u);
    assert.ok(report.indexOf("held-package") < report.indexOf("current-package"));
    assert.equal(reportExitCode(rows), 0);
  });

  it("uses distinct nonzero codes for actionable updates and monitor errors", () => {
    assert.equal(reportExitCode([{ status: "actionable" }]), 1);
    assert.equal(reportExitCode([{ status: "error" }, { status: "actionable" }]), 2);
  });

  it("neutralizes Markdown and HTML syntax in report fields", () => {
    assert.equal(
      sanitizeReportField("[link](x) | `code` <tag>"),
      "\\[link\\](x) \\| \\`code\\` &lt;tag&gt;"
    );
  });

  it("stops reading a streamed response as soon as the byte cap is exceeded", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("1234"));
          controller.enqueue(new TextEncoder().encode("5678"));
          controller.close();
        },
      })
    );
    await assert.rejects(() => readBoundedResponse(response, 6), /response size limit/u);
  });
});

describe("unsupported YAML key notation", () => {
  it.each([
    String.raw`"us\u0065s"`,
    String.raw`"\x75ses"`,
    String.raw`"\U00000075ses"`,
    String.raw`"\u0075\u0073\u0065\u0073"`,
  ])("refuses a credible escaped uses key %s but ignores the same command text", (key) => {
    for (const content of [
      `- ${key}: actions/checkout@v7`,
      `steps: [{ ${key}: actions/checkout@v7 }]`,
    ]) {
      const parsed = parseActionReferences([{ path: "escaped.yml", content }]);
      assert.equal(parsed.errors.length, 1);
      assert.equal(parsed.errors[0].dependency, "unsupported uses syntax");
    }
    for (const content of [
      `- run: echo '${key}: actions/checkout@v7'`,
      `- { run: 'echo ${key}: actions/checkout@v7' }`,
      `# - ${key}: actions/checkout@v7`,
      `- run: |\n    ${key}: actions/checkout@v7`,
    ]) {
      assert.deepEqual(parseActionReferences([{ path: "literal.yml", content }]).errors, []);
    }
  });

  it.each(["uses", "'uses'", '"uses"', String.raw`"us\u0065s"`])(
    "refuses an explicit uses key %s without treating quoted shell text as a key",
    (key) => {
      for (const content of [
        `- ? ${key}\n  : actions/checkout@v7`,
        `steps: [{ ? ${key}: actions/checkout@v7 }]`,
      ]) {
        const parsed = parseActionReferences([{ path: "explicit.yml", content }]);
        assert.equal(parsed.errors.length, 1);
        assert.equal(parsed.errors[0].dependency, "unsupported uses syntax");
      }
      const literal = `- run: |\n    ? ${key}\n    : actions/checkout@v7\n- uses: actions/checkout@${SHA_ONE} # v7.0.1`;
      const parsed = parseActionReferences([{ path: "script.yml", content: literal }]);
      assert.deepEqual(parsed.errors, []);
      assert.equal(parsed.targets.length, 1);
    }
  );

  it("does not decode single-quoted or escaped-backslash literals as uses keys", () => {
    const lines = [
      String.raw`- 'us\u0065s': ordinary value`,
      String.raw`- "us\\u0065s": ordinary value`,
      `- ? name\n  : ordinary value`,
      `- uses: actions/checkout@${SHA_ONE} # v7.0.1`,
    ];
    const parsed = parseActionReferences([{ path: "ordinary.yml", content: lines.join("\n") }]);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.targets.length, 1);
    assert.deepEqual(parsed.targets[0].locations, ["ordinary.yml:5"]);
  });
});
