import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { RELEASE_AUDIT_LIMITS, queryReleaseAdvisories } from "./dependency-release-audit.mjs";

/** @type {import("./dependency-release-audit.mjs").ReleasePackage[]} */
const packages = [
  { ecosystem: "npm", name: "@example/package", version: "1.2.3" },
  { ecosystem: "crates.io", name: "example-crate", version: "0.4.5" },
];

/** @param {number} count */
function packageInventory(count) {
  return Array.from({ length: count }, (_, index) => ({
    ...packages[0],
    name: `example-${index}`,
  }));
}

/** @param {number} count */
function advisories(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `OSV-2026-${index}` }));
}

describe("released-package advisory queries", () => {
  it("keeps clean packages in input order and queries exact registry identities", async () => {
    const result = await queryReleaseAdvisories(packages, async (payload) => {
      assert.deepEqual(payload, {
        queries: [
          { package: { ecosystem: "npm", name: "@example/package" }, version: "1.2.3" },
          { package: { ecosystem: "crates.io", name: "example-crate" }, version: "0.4.5" },
        ],
      });
      return { results: [{}, { vulns: [] }] };
    });
    assert.deepEqual(
      result,
      packages.map((entry) => ({ ...entry, advisories: [] }))
    );
    assert.equal(Object.hasOwn(packages[0], "advisories"), false);
  });

  it("keeps different versions and ecosystems separate while deduplicating advisory IDs", async () => {
    const inventory = [
      { ...packages[0], name: "example" },
      { ...packages[0], name: "example", version: "2.0.0" },
      { ...packages[1], name: "example", version: "1.2.3" },
    ];
    const result = await queryReleaseAdvisories(inventory, async () => ({
      results: [
        { vulns: [{ id: "GHSA-abcd-1234-efgh" }, { id: "GHSA-abcd-1234-efgh" }] },
        {},
        { vulns: [{ id: "RUSTSEC-2026-0001" }] },
      ],
    }));
    assert.deepEqual(result, [
      { ...inventory[0], advisories: ["GHSA-abcd-1234-efgh"] },
      { ...inventory[1], advisories: [] },
      { ...inventory[2], advisories: ["RUSTSEC-2026-0001"] },
    ]);
  });

  it("queries only unfinished packages and maps shrinking pages to their original identities", async () => {
    const inventory = [...packages, { ...packages[0], version: "2.0.0" }];
    /** @type {import("./dependency-release-audit.mjs").AdvisoryBatch[]} */
    const batches = [];
    const responses = [
      {
        results: [
          { vulns: [{ id: "GHSA-first" }], next_page_token: "a" },
          { vulns: [{ id: "RUSTSEC-middle" }] },
          { next_page_token: "a" },
        ],
      },
      {
        results: [
          { vulns: [{ id: "GHSA-first" }, { id: "GHSA-second" }] },
          { vulns: [{ id: "GHSA-third" }], next_page_token: "b" },
        ],
      },
      { results: [{ vulns: [{ id: "GHSA-fourth" }] }] },
    ];
    const result = await queryReleaseAdvisories(inventory, async (payload) => {
      batches.push(payload);
      return responses[batches.length - 1];
    });
    assert.deepEqual(
      batches.map((batch) => batch.queries.length),
      [3, 2, 1]
    );
    assert.deepEqual(batches[1].queries, [
      {
        package: { ecosystem: "npm", name: "@example/package" },
        version: "1.2.3",
        page_token: "a",
      },
      {
        package: { ecosystem: "npm", name: "@example/package" },
        version: "2.0.0",
        page_token: "a",
      },
    ]);
    assert.deepEqual(batches[2].queries, [
      {
        package: { ecosystem: "npm", name: "@example/package" },
        version: "2.0.0",
        page_token: "b",
      },
    ]);
    assert.deepEqual(
      result.map((entry) => entry.advisories),
      [["GHSA-first", "GHSA-second"], ["RUSTSEC-middle"], ["GHSA-third", "GHSA-fourth"]]
    );
  });

  it("makes no request for an empty inventory", async () => {
    assert.deepEqual(
      await queryReleaseAdvisories([], async () => assert.fail("No query was expected.")),
      []
    );
  });

  it("accepts the package limit and keeps every request within the batch limit", async () => {
    const inventory = packageInventory(RELEASE_AUDIT_LIMITS.packages);
    /** @type {import("./dependency-release-audit.mjs").AdvisoryQuery[]} */
    const queried = [];
    const result = await queryReleaseAdvisories(inventory, async ({ queries }) => {
      assert.ok(queries.length <= RELEASE_AUDIT_LIMITS.batchSize);
      queried.push(...queries);
      return { results: queries.map(() => ({})) };
    });
    assert.equal(result.length, inventory.length);
    assert.deepEqual(
      queried.map((query) => query.package.name),
      inventory.map((entry) => entry.name)
    );
  });

  it.each([
    ["non-array", null],
    ["too many packages", packageInventory(RELEASE_AUDIT_LIMITS.packages + 1)],
    ["duplicate identity", [packages[0], packages[0]]],
    ["sparse inventory", new Array(1)],
    ["null package", [null]],
    ["unknown ecosystem", [{ ...packages[0], ecosystem: "pypi" }]],
    ["npm URL", [{ ...packages[0], name: "https://example.test/package" }]],
    ["crate separator", [{ ...packages[1], name: "example/crate" }]],
    ["empty name", [{ ...packages[0], name: "" }]],
    ["npm name length", [{ ...packages[0], name: "a".repeat(215) }]],
    ["crate name length", [{ ...packages[1], name: "a".repeat(65) }]],
    ["missing version", [{ ecosystem: "npm", name: "example" }]],
    ["version range", [{ ...packages[0], version: "^1.2.3" }]],
    ["prerelease", [{ ...packages[0], version: "1.2.3-rc.1" }]],
    ["version prefix", [{ ...packages[0], version: "v1.2.3" }]],
  ])("rejects an invalid inventory (%s) before querying", async (_label, inventory) => {
    await assert.rejects(
      () =>
        queryReleaseAdvisories(
          /** @type {import("./dependency-release-audit.mjs").ReleasePackage[]} */ (inventory),
          async () => assert.fail("Invalid input must not reach the requester.")
        ),
      /Release advisory/u
    );
  });

  it.each([
    ["null response", null],
    ["array response", []],
    ["missing results", {}],
    ["null results", { results: null }],
    ["short result array", { results: [{}] }],
    ["long result array", { results: [{}, {}, {}] }],
    ["sparse results", { results: new Array(2) }],
    ["null result", { results: [null, {}] }],
    ["array result", { results: [[], {}] }],
    ["batch error", { results: [{}, {}], error: "failed" }],
    ["package error", { results: [{ error: "failed" }, {}] }],
    ["null advisories", { results: [{ vulns: null }, {}] }],
    ["object advisories", { results: [{ vulns: {} }, {}] }],
    ["null advisory", { results: [{ vulns: [null] }, {}] }],
    ["missing ID", { results: [{ vulns: [{}] }, {}] }],
    ["numeric ID", { results: [{ vulns: [{ id: 123 }] }, {}] }],
    ["blank ID", { results: [{ vulns: [{ id: "" }] }, {}] }],
    ["unsafe ID", { results: [{ vulns: [{ id: "GHSA-id](https://example.test)" }] }, {}] }],
    ["oversized ID", { results: [{ vulns: [{ id: "a".repeat(129) }] }, {}] }],
    ["null token", { results: [{ next_page_token: null }, {}] }],
    ["empty token", { results: [{ next_page_token: "" }, {}] }],
    ["blank token", { results: [{ next_page_token: " " }, {}] }],
    [
      "oversized token",
      { results: [{ next_page_token: "a".repeat(RELEASE_AUDIT_LIMITS.pageTokenLength + 1) }, {}] },
    ],
  ])("fails closed on malformed metadata (%s)", async (_label, response) => {
    await assert.rejects(
      () => queryReleaseAdvisories(packages, async () => response),
      /Release advisory/u
    );
  });

  it.each([false, true])("rejects a pagination token loop (indirect: %s)", async (indirect) => {
    let requests = 0;
    await assert.rejects(
      () =>
        queryReleaseAdvisories([packages[0]], async () => {
          requests += 1;
          return { results: [{ next_page_token: indirect && requests === 2 ? "b" : "a" }] };
        }),
      /repeated a token/u
    );
    assert.equal(requests, indirect ? 3 : 2);
  });

  it.each([false, true])(
    "enforces the per-package page boundary (complete: %s)",
    async (complete) => {
      let requests = 0;
      const run = () =>
        queryReleaseAdvisories([packages[0]], async () => {
          requests += 1;
          return {
            results: [
              complete && requests === RELEASE_AUDIT_LIMITS.pagesPerPackage
                ? {}
                : { next_page_token: `token-${requests}` },
            ],
          };
        });
      if (complete) assert.deepEqual(await run(), [{ ...packages[0], advisories: [] }]);
      else await assert.rejects(run, /exceeded the page limit/u);
      assert.equal(requests, RELEASE_AUDIT_LIMITS.pagesPerPackage);
    }
  );

  it("accepts the per-page advisory limit and rejects one additional ID", async () => {
    const run = (/** @type {number} */ count) =>
      queryReleaseAdvisories([packages[0]], async () => ({
        results: [{ vulns: advisories(count) }],
      }));
    assert.equal(
      (await run(RELEASE_AUDIT_LIMITS.advisoriesPerPage))[0].advisories.length,
      RELEASE_AUDIT_LIMITS.advisoriesPerPage
    );
    await assert.rejects(() => run(RELEASE_AUDIT_LIMITS.advisoriesPerPage + 1), /page limit/u);
  });

  it("accepts the total advisory limit and rejects one additional ID across packages", async () => {
    const count = RELEASE_AUDIT_LIMITS.advisories / RELEASE_AUDIT_LIMITS.advisoriesPerPage;
    const inventory = packageInventory(count);
    const result = await queryReleaseAdvisories(inventory, async ({ queries }) => ({
      results: queries.map(() => ({ vulns: advisories(RELEASE_AUDIT_LIMITS.advisoriesPerPage) })),
    }));
    assert.equal(
      result.reduce((sum, entry) => sum + entry.advisories.length, 0),
      RELEASE_AUDIT_LIMITS.advisories
    );
    await assert.rejects(
      () =>
        queryReleaseAdvisories([...inventory, packages[0]], async ({ queries }) => ({
          results: queries.map((_, index) => ({
            vulns: advisories(index === count ? 1 : RELEASE_AUDIT_LIMITS.advisoriesPerPage),
          })),
        })),
      /total limit/u
    );
  });

  it("counts duplicate IDs across pages toward the total result limit", async () => {
    let requests = 0;
    const fullPages = RELEASE_AUDIT_LIMITS.advisories / RELEASE_AUDIT_LIMITS.advisoriesPerPage;
    const repeated = Array.from({ length: RELEASE_AUDIT_LIMITS.advisoriesPerPage }, () => ({
      id: "GHSA-repeat",
    }));
    await assert.rejects(
      () =>
        queryReleaseAdvisories([packages[0]], async () => {
          requests += 1;
          return {
            results: [
              {
                vulns: requests <= fullPages ? repeated : [{ id: "GHSA-repeat" }],
                next_page_token: `token-${requests}`,
              },
            ],
          };
        }),
      /total limit/u
    );
    assert.equal(requests, fullPages + 1);
  });

  it("bounds the total number of requests across independently paginated batches", async () => {
    const inventory = packageInventory(
      RELEASE_AUDIT_LIMITS.batchSize *
        (RELEASE_AUDIT_LIMITS.requests / RELEASE_AUDIT_LIMITS.pagesPerPackage + 1)
    );
    let requests = 0;
    await assert.rejects(
      () =>
        queryReleaseAdvisories(inventory, async ({ queries }) => {
          requests += 1;
          return {
            results: queries.map(() =>
              requests % RELEASE_AUDIT_LIMITS.pagesPerPackage === 0
                ? {}
                : { next_page_token: `token-${requests}` }
            ),
          };
        }),
      /request limit/u
    );
    assert.equal(requests, RELEASE_AUDIT_LIMITS.requests);
  });

  it("accepts a complete response on the final permitted request", async () => {
    const inventory = packageInventory(
      (RELEASE_AUDIT_LIMITS.batchSize * RELEASE_AUDIT_LIMITS.requests) /
        RELEASE_AUDIT_LIMITS.pagesPerPackage
    );
    let requests = 0;
    const result = await queryReleaseAdvisories(inventory, async ({ queries }) => {
      requests += 1;
      return {
        results: queries.map(() =>
          requests % RELEASE_AUDIT_LIMITS.pagesPerPackage === 0
            ? {}
            : { next_page_token: `token-${requests}` }
        ),
      };
    });
    assert.equal(requests, RELEASE_AUDIT_LIMITS.requests);
    assert.equal(result.length, inventory.length);
  });

  it("propagates requester failures without returning clean results", async () => {
    const failure = new Error("Request timed out.");
    await assert.rejects(
      () =>
        queryReleaseAdvisories(packages, async () => {
          throw failure;
        }),
      failure
    );
  });
});
