import { describe, expect, it } from "vitest";
import packageJson from "../package.json";
import packageLock from "../package-lock.json";

const LOCKED_TOOLCHAIN_NODE_RANGE = "^20.19.0 || ^22.13.0 || >=24";

describe("package metadata", () => {
  it("keeps package.json and package-lock root Node engines aligned with the locked toolchain", () => {
    expect(packageJson.engines.node).toBe(LOCKED_TOOLCHAIN_NODE_RANGE);
    expect(packageLock.packages[""].engines.node).toBe(
      LOCKED_TOOLCHAIN_NODE_RANGE
    );

    // ESLint drives `npm run lint:js`; the root range must not promise a
    // Node version that the checked-in lint toolchain explicitly excludes.
    expect(packageLock.packages["node_modules/eslint"].engines.node).toBe(
      LOCKED_TOOLCHAIN_NODE_RANGE
    );
  });
});
