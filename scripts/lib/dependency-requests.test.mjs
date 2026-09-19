import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { METADATA_NOT_FOUND, createJsonRequester } from "./dependency-requests.mjs";

const options = { headers: { Accept: "application/json" }, maxBytes: 1024 };

describe("bounded metadata requests", () => {
  it("distinguishes a permitted HTTP 404 from a successful JSON null", async () => {
    const request = createJsonRequester(async (url) =>
      String(url).endsWith("missing")
        ? new Response("not found", { status: 404 })
        : Response.json(null)
    );
    assert.equal(
      await request("https://example.test/missing", { ...options, allowNotFound: true }),
      METADATA_NOT_FOUND
    );
    assert.equal(await request("https://example.test/null", options), null);
    await assert.rejects(() => request("https://example.test/missing", options), /HTTP 404/u);
  });

  it("shares concurrent requests but keeps response-policy caches separate", async () => {
    let requests = 0;
    const request = createJsonRequester(async (_url, init) => {
      requests += 1;
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal instanceof AbortSignal);
      return Response.json({ value: "large enough to exceed a one-byte cap" });
    });
    const url = "https://example.test/package";
    const [first, second] = await Promise.all([request(url, options), request(url, options)]);
    assert.deepEqual(first, second);
    assert.equal(requests, 1);
    await assert.rejects(() => request(url, { ...options, maxBytes: 1 }), /response size limit/u);
    assert.equal(requests, 2);
  });

  it.each([429, 500, "network"])(
    "bounds retryable %s failures to three attempts",
    async (failure) => {
      let requests = 0;
      /** @type {number[]} */
      const delays = [];
      const request = createJsonRequester(
        async () => {
          requests += 1;
          if (failure === "network") throw new TypeError("unavailable");
          return new Response("retry", { status: Number(failure) });
        },
        async (milliseconds) => {
          delays.push(milliseconds);
        }
      );
      await assert.rejects(
        () => request("https://example.test/failure", options),
        /Remote metadata/u
      );
      assert.equal(requests, 3);
      assert.deepEqual(delays, [300, 600]);
    }
  );

  it("accepts a successful retry", async () => {
    let requests = 0;
    const request = createJsonRequester(
      async () =>
        ++requests === 1 ? new Response("busy", { status: 503 }) : Response.json({ ok: true }),
      async () => {}
    );
    assert.deepEqual(await request("https://example.test/recovered", options), { ok: true });
    assert.equal(requests, 2);
  });

  it.each(["json", "size", "forbidden"])(
    "does not retry a %s validation failure",
    async (failure) => {
      let requests = 0;
      const request = createJsonRequester(async () => {
        requests += 1;
        if (failure === "forbidden") return new Response("denied", { status: 403 });
        return new Response(failure === "json" ? "{" : " ".repeat(1025));
      });
      await assert.rejects(() => request("https://example.test/invalid", options));
      assert.equal(requests, 1);
    }
  );
});
