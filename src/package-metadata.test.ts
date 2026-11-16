import { describe, expect, it } from "vitest";
import packageJson from "../package.json";
import packageLock from "../package-lock.json";
import tsconfigJson from "../tsconfig.json";
import tsconfigNodeJson from "../tsconfig.node.json";
import tsconfigTestJson from "../tsconfig.test.json";

const SUPPORTED_NODE_RANGE = "^24.21.0";
const PINNED_PACKAGE_MANAGER = "npm@12.2.2";
describe("package metadata", () => {
  it("keeps the root Node and npm contracts explicit", () => {
    expect(packageJson.engines.node).toBe(SUPPORTED_NODE_RANGE);
    expect(packageLock.packages[""].engines.node).toBe(SUPPORTED_NODE_RANGE);
    expect(packageJson.packageManager).toBe(PINNED_PACKAGE_MANAGER);
  });

  it("keeps both TypeScript aliases aligned with the lockfile", () => {
    expect(packageLock.packages[""].devDependencies["@typescript/native"]).toBe(
      packageJson.devDependencies["@typescript/native"]
    );
    expect(packageLock.packages[""].devDependencies.typescript).toBe(
      packageJson.devDependencies.typescript
    );
    expect(packageLock.packages["node_modules/@typescript/native"].version).toMatch(/^7\./u);
    expect(packageLock.packages["node_modules/typescript"].version).toMatch(/^6\./u);
  });

  it("keeps browser, test, and Node type environments separate", () => {
    expect(tsconfigJson.compilerOptions.types).toEqual(["vite/client"]);
    expect(tsconfigJson.exclude).toEqual([
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "src/**/*.spec.ts",
      "src/**/*.spec.tsx",
    ]);
    expect(tsconfigTestJson.compilerOptions.types).toEqual(["vite/client", "node"]);
    expect(tsconfigTestJson.include).toContain("src/**/*.test.ts");
    expect(tsconfigTestJson.include).toContain("src/vite-env.d.ts");
    expect(tsconfigTestJson.exclude).toEqual([]);
    expect(tsconfigNodeJson.compilerOptions.types).toEqual(["node"]);
    expect(packageJson.scripts["typecheck:ts6"]).toContain("--project tsconfig.test.json");
    expect(packageJson.scripts["typecheck:ts7"]).toContain("--project tsconfig.ts7.test.json");
  });
});
