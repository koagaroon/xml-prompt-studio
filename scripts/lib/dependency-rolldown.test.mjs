import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { reportExitCode } from "./dependency-currency.mjs";
import { METADATA_NOT_FOUND, createJsonRequester } from "./dependency-requests.mjs";
import { checkRolldown } from "./dependency-rolldown.mjs";

const bindingName = "@rolldown/binding-win32-x64-msvc";
const linuxBinding = "@rolldown/binding-linux-x64-gnu";
const androidBinding = "@rolldown/binding-android-arm64";
const lockfile = {
  packages: {
    "node_modules/vite": { dependencies: { rolldown: "~1.2.1" } },
    "node_modules/rolldown": { version: "1.2.5" },
  },
};

/** @param {string} version @param {string} name */
function bindingMetadata(version, name = bindingName) {
  return { name, version, dist: { integrity: "sha512-example" } };
}

/** @param {() => Response | Promise<Response>} latestResponse @param {{ lockedMissing?: boolean, current?: boolean }} options */
async function inspect(latestResponse, { lockedMissing = false, current = false } = {}) {
  const metadata = {
    name: "rolldown",
    "dist-tags": { latest: current ? "1.2.5" : "1.2.6" },
    versions: Object.fromEntries(
      (current ? ["1.2.5"] : ["1.2.5", "1.2.6"]).map((version) => [
        version,
        {
          name: "rolldown",
          version,
          optionalDependencies: { [bindingName]: version, [linuxBinding]: version },
        },
      ])
    ),
  };
  const request = createJsonRequester(
    async (url) => {
      if (String(url).endsWith("/rolldown")) return Response.json(metadata);
      if (String(url).includes(encodeURIComponent(linuxBinding))) {
        return Response.json(bindingMetadata(String(url).split("/").at(-1) ?? "", linuxBinding));
      }
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

/** @param {string[]} versions @param {string[]} bindings */
function releaseInventory(versions, bindings = [bindingName, linuxBinding]) {
  return {
    name: "rolldown",
    "dist-tags": { latest: versions.at(-1) },
    versions: Object.fromEntries(
      versions.map((version) => [
        version,
        {
          name: "rolldown",
          version,
          optionalDependencies: Object.fromEntries(bindings.map((name) => [name, version])),
        },
      ])
    ),
  };
}

/** @param {unknown} metadata @param {{ missing?: string[], invalid?: Record<string, unknown> }} options */
async function inspectInventory(metadata, { missing = [], invalid = {} } = {}) {
  /** @type {string[]} */
  const requests = [];
  const rows = await checkRolldown(lockfile, {
    fetchMetadata: async () => metadata,
    fetchBinding: async (name, version) => {
      const identity = `${name}@${version}`;
      requests.push(identity);
      if (missing.includes(identity)) return METADATA_NOT_FOUND;
      if (Object.hasOwn(invalid, identity)) return invalid[identity];
      return bindingMetadata(version, name);
    },
  });
  return { rows, requests };
}

describe("Rolldown maintained build hosts and candidate discovery", () => {
  it("preserves a usable intermediate update when a newer release is incomplete", async () => {
    const versions = ["1.2.5", "1.2.6", "1.2.7"];
    const baseline = await inspectInventory(releaseInventory(versions.slice(0, 2)));
    const incomplete = await inspectInventory(releaseInventory(versions), {
      missing: [`${bindingName}@1.2.7`],
    });
    const restored = await inspectInventory(releaseInventory(versions));
    assert.equal(baseline.rows[0].latest, "1.2.6");
    assert.deepEqual(
      incomplete.rows.map(({ status, latest }) => [status, latest]),
      [
        ["actionable", "1.2.6"],
        ["hold", "1.2.7"],
      ]
    );
    assert.match(incomplete.rows[1].reason, /unpublished native packages/u);
    assert.equal(reportExitCode(incomplete.rows), 1);
    assert.equal(restored.rows.length, 1);
    assert.equal(restored.rows[0].latest, "1.2.7");
    assert.equal(restored.rows[0].status, "actionable");
  });

  it.each([bindingName, linuxBinding])(
    "holds an update missing maintained binding %s",
    async (name) => {
      const { rows } = await inspectInventory(releaseInventory(["1.2.5", "1.2.6"]), {
        missing: [`${name}@1.2.6`],
      });
      assert.equal(rows[0].status, "hold");
      assert.equal(reportExitCode(rows), 0);
      assert.ok(rows[0].reason.includes(`${name}@1.2.6`));
    }
  );

  it.each([bindingName, linuxBinding])(
    "rejects missing locked maintained binding %s",
    async (name) => {
      const { rows, requests } = await inspectInventory(releaseInventory(["1.2.5", "1.2.6"]), {
        missing: [`${name}@1.2.5`],
      });
      assert.equal(rows[0].status, "error");
      assert.match(rows[0].reason, /Locked Rolldown/u);
      assert.ok(requests.every((identity) => identity.endsWith("@1.2.5")));
    }
  );

  it.each([false, true])(
    "keeps other-platform gaps informational when an update exists: %s",
    async (update) => {
      const versions = update ? ["1.2.5", "1.2.6"] : ["1.2.5"];
      const { rows } = await inspectInventory(
        releaseInventory(versions, [bindingName, linuxBinding, androidBinding]),
        { missing: versions.map((version) => `${androidBinding}@${version}`) }
      );
      assert.equal(rows[0].status, update ? "actionable" : "current");
      assert.equal(reportExitCode(rows), update ? 1 : 0);
      assert.match(rows[0].reason, /Windows x64 MSVC and Linux x64 GNU/u);
      assert.match(rows[0].reason, /publication gaps \(informational\)/u);
      for (const version of versions)
        assert.ok(rows[0].reason.includes(`android-arm64@${version}`));
    }
  );

  it("keeps an unverified other-platform locked binding informational without calling it missing", async () => {
    const { rows } = await inspectInventory(
      releaseInventory(["1.2.5"], [bindingName, linuxBinding, androidBinding]),
      { invalid: { [`${androidBinding}@1.2.5`]: null } }
    );
    assert.equal(rows[0].status, "current");
    assert.equal(reportExitCode(rows), 0);
    assert.match(rows[0].reason, /Other-platform checks incomplete \(informational\)/u);
    assert.doesNotMatch(rows[0].reason, /publication gaps/u);
  });

  it.each(
    [
      "network",
      "HTTP failure",
      "invalid JSON",
      "JSON null",
      "wrong name",
      "wrong version",
      "missing integrity",
    ].flatMap((failure) =>
      [bindingName, linuxBinding, androidBinding].map((name) => [failure, name])
    )
  )("limits %s for %s to the appropriate host scope", async (failure, name) => {
    let attempts = 0;
    const request = createJsonRequester(
      async () => {
        attempts += 1;
        if (failure === "network") throw new TypeError("unavailable");
        if (failure === "HTTP failure") return new Response("unavailable", { status: 503 });
        if (failure === "invalid JSON") return new Response("{");
        if (failure === "JSON null") return Response.json(null);
        if (failure === "wrong name")
          return Response.json(bindingMetadata("1.2.6", "wrong-package"));
        if (failure === "wrong version") return Response.json(bindingMetadata("1.2.4", name));
        return Response.json({ name, version: "1.2.6", dist: {} });
      },
      async () => {}
    );
    const rows = await checkRolldown(lockfile, {
      fetchMetadata: async () =>
        releaseInventory(["1.2.5", "1.2.6"], [bindingName, linuxBinding, androidBinding]),
      fetchBinding: async (requestedName, version) =>
        requestedName === name && version === "1.2.6"
          ? await request("https://example.test/binding", {
              headers: {},
              maxBytes: 1024,
              allowNotFound: true,
            })
          : bindingMetadata(version, requestedName),
    });
    if (name === androidBinding) {
      assert.equal(rows[0].status, "actionable");
      assert.equal(rows[0].latest, "1.2.6");
      assert.equal(reportExitCode(rows), 1);
      assert.match(rows[0].reason, /Other-platform checks incomplete \(informational\)/u);
      assert.match(rows[0].reason, /android-arm64@1\.2\.6/u);
      assert.doesNotMatch(rows[0].reason, /publication gaps/u);
    } else {
      assert.equal(rows[0].status, "error");
      assert.equal(reportExitCode(rows), 2);
      assert.match(rows[0].reason, /Remote metadata|Invalid published native package metadata/u);
    }
    assert.equal(attempts, failure === "network" || failure === "HTTP failure" ? 3 : 1);
  });

  it("rejects invalid overall Rolldown release metadata even for an unmaintained binding", async () => {
    const metadata = releaseInventory(
      ["1.2.5", "1.2.6"],
      [bindingName, linuxBinding, androidBinding]
    );
    metadata.versions["1.2.6"].optionalDependencies[androidBinding] = "invalid";
    const { rows } = await inspectInventory(metadata);
    assert.equal(rows[0].status, "error");
    assert.match(rows[0].reason, /Rolldown 1\.2\.6 has invalid native binding metadata/u);
  });

  it.each([bindingName, linuxBinding])(
    "rejects a release omitting maintained host %s",
    async (name) => {
      const metadata = releaseInventory(["1.2.5", "1.2.6"]);
      delete metadata.versions["1.2.6"].optionalDependencies[name];
      const { rows } = await inspectInventory(metadata);
      assert.equal(rows[0].status, "error");
      assert.match(rows[0].reason, /no maintained-host binding/u);
    }
  );

  it("checks the eighth candidate and bounds requests even with 64 bindings per release", async () => {
    const versions = Array.from({ length: 9 }, (_, index) => `1.2.${index + 5}`);
    const bindings = [
      bindingName,
      linuxBinding,
      ...Array.from({ length: 62 }, (_, index) => `@rolldown/binding-other-${index}`),
    ];
    const { rows, requests } = await inspectInventory(releaseInventory(versions, bindings), {
      missing: versions.slice(2).map((version) => `${bindingName}@${version}`),
    });
    assert.equal(rows[0].status, "actionable");
    assert.equal(rows[0].latest, "1.2.6");
    assert.equal(rows[1].latest, "1.2.13");
    assert.match(rows[1].reason, /6 other newer releases/u);
    assert.equal(requests.length, 142);
    assert.equal(new Set(requests).size, requests.length);
  });

  it("reports incomplete coverage instead of a successful hold after eight failed candidates", async () => {
    const versions = Array.from({ length: 10 }, (_, index) => `1.2.${index + 5}`);
    const { rows, requests } = await inspectInventory(releaseInventory(versions), {
      missing: versions.slice(2).map((version) => `${bindingName}@${version}`),
    });
    assert.equal(rows[0].status, "error");
    assert.equal(reportExitCode(rows), 2);
    assert.match(rows[0].reason, /8-candidate limit.*remain unchecked/u);
    assert.equal(requests.length, 18);
    assert.ok(!requests.some((identity) => identity.endsWith("@1.2.6")));
  });

  it("does not reject a long release history when the newest candidate is usable", async () => {
    const versions = Array.from({ length: 10 }, (_, index) => `1.2.${index + 5}`);
    const { rows, requests } = await inspectInventory(releaseInventory(versions));
    assert.equal(rows[0].status, "actionable");
    assert.equal(rows[0].latest, "1.2.14");
    assert.equal(requests.length, 4);
  });

  it("rejects 65 bindings before starting publication requests", async () => {
    const bindings = [
      bindingName,
      linuxBinding,
      ...Array.from({ length: 63 }, (_, index) => `@rolldown/binding-other-${index}`),
    ];
    const { rows, requests } = await inspectInventory(releaseInventory(["1.2.5"], bindings));
    assert.equal(rows[0].status, "error");
    assert.match(rows[0].reason, /invalid native binding count/u);
    assert.equal(requests.length, 0);
  });

  it("does not inspect deprecated, prerelease, or out-of-range update candidates", async () => {
    const metadata = releaseInventory(["1.2.5", "1.2.6", "1.2.8-rc.1", "1.3.0", "2.0.0"]);
    const deprecated = { ...metadata.versions["1.2.6"], version: "1.2.7", deprecated: "withdrawn" };
    const { rows, requests } = await inspectInventory({
      ...metadata,
      versions: { ...metadata.versions, "1.2.7": deprecated },
    });
    assert.equal(rows[0].latest, "1.2.6");
    assert.equal(rows[0].status, "actionable");
    assert.ok(requests.every((identity) => /@1\.2\.[56]$/u.test(identity)));
  });

  it("rejects malformed intermediate release identity rather than skipping to an older update", async () => {
    const metadata = releaseInventory(["1.2.5", "1.2.6", "1.2.7"]);
    metadata.versions["1.2.6"].name = "wrong-package";
    const { rows } = await inspectInventory(metadata, { missing: [`${bindingName}@1.2.7`] });
    assert.equal(rows[0].status, "error");
    assert.match(rows[0].reason, /1\.2\.6 has invalid release metadata/u);
  });
});
