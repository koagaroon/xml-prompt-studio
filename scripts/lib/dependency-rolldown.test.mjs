import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { reportExitCode } from "./dependency-currency.mjs";
import { createJsonRequester } from "./dependency-requests.mjs";
import { checkRolldown } from "./dependency-rolldown.mjs";

const bindingName = "@rolldown/binding-win32-x64-msvc";
const lockfile = {
  packages: {
    "node_modules/vite": { dependencies: { rolldown: "~1.2.1" } },
    "node_modules/rolldown": { version: "1.2.5" },
  },
};

/** @param {string} version */
function bindingMetadata(version) {
  return { name: bindingName, version, dist: { integrity: "sha512-example" } };
}

/** @param {() => Response | Promise<Response>} latestResponse @param {{ lockedMissing?: boolean, current?: boolean }} options */
async function inspect(latestResponse, { lockedMissing = false, current = false } = {}) {
  const metadata = {
    name: "rolldown",
    "dist-tags": { latest: current ? "1.2.5" : "1.2.6" },
    versions: Object.fromEntries(
      (current ? ["1.2.5"] : ["1.2.5", "1.2.6"]).map((version) => [
        version,
        { name: "rolldown", version, optionalDependencies: { [bindingName]: version } },
      ])
    ),
  };
  const request = createJsonRequester(
    async (url) => {
      if (String(url).endsWith("/rolldown")) return Response.json(metadata);
      if (String(url).endsWith("/1.2.5")) {
        return lockedMissing
          ? new Response("not found", { status: 404 })
          : Response.json(bindingMetadata("1.2.5"));
      }
      return await latestResponse();
    },
    async () => {}
  );
  const options = { headers: { Accept: "application/json" }, maxBytes: 2 * 1024 * 1024 };
  return await checkRolldown(lockfile, {
    fetchMetadata: () => request("https://example.test/rolldown", options),
    fetchBinding: (name, version) =>
      request(`https://example.test/${encodeURIComponent(name)}/${version}`, {
        ...options,
        allowNotFound: true,
      }),
  });
}

describe("Rolldown request-to-report classification", () => {
  it("reports an update only with valid new binding metadata", async () => {
    const rows = await inspect(() => Response.json(bindingMetadata("1.2.6")));
    assert.equal(rows[0].status, "actionable");
    assert.equal(reportExitCode(rows), 1);
    assert.equal(rows[0].locked, "1.2.5");
    assert.equal(rows[0].latest, "1.2.6");
  });

  it("keeps a genuine new-binding 404 as an intentional hold", async () => {
    const rows = await inspect(() => new Response("not found", { status: 404 }));
    assert.equal(rows[0].status, "hold");
    assert.equal(reportExitCode(rows), 0);
    assert.match(rows[0].reason, /unpublished native packages/u);
  });

  it.each([
    ["wrong name", { ...bindingMetadata("1.2.6"), name: "another-package" }],
    ["wrong version", bindingMetadata("1.2.4")],
    ["missing integrity", { name: bindingName, version: "1.2.6", dist: {} }],
    ["blank integrity", { name: bindingName, version: "1.2.6", dist: { integrity: " " } }],
    ["JSON null", null],
    ["JSON array", []],
  ])("reports malformed successful metadata (%s) as an error", async (_label, metadata) => {
    const rows = await inspect(() => Response.json(metadata));
    assert.equal(rows[0].status, "error");
    assert.equal(reportExitCode(rows), 2);
    assert.match(rows[0].reason, /Invalid published native package metadata/u);
    assert.ok(rows[0].reason.includes(`${bindingName}@1.2.6`));
  });

  it.each(["network", "invalid JSON"])("reports %s failures as errors", async (failure) => {
    const rows = await inspect(() => {
      if (failure === "network") throw new TypeError("disconnected");
      return new Response("{");
    });
    assert.equal(rows[0].status, "error");
    assert.equal(reportExitCode(rows), 2);
    assert.match(rows[0].reason, /Remote metadata/u);
  });

  it("treats a missing locked binding as an error even when the new release is held", async () => {
    const rows = await inspect(() => new Response("not found", { status: 404 }), {
      lockedMissing: true,
    });
    assert.equal(rows[0].status, "error");
    assert.equal(reportExitCode(rows), 2);
    assert.match(rows[0].reason, /Locked Rolldown/u);
  });

  it("keeps a fully published current release successful", async () => {
    const rows = await inspect(
      () => {
        throw new Error("The current release should not request a newer binding.");
      },
      { current: true }
    );
    assert.equal(rows[0].status, "current");
    assert.equal(reportExitCode(rows), 0);
  });
});
