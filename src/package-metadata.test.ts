import { describe, expect, it } from "vitest";
import packageJson from "../package.json";
import packageLock from "../package-lock.json";

const SUPPORTED_NODE_RANGE = "^22.13.0 || ^24.0.0 || ^26.0.0";
const PINNED_PACKAGE_MANAGER = "npm@11.19.0";
type LockPackageMetadata = {
  hasInstallScript?: boolean;
  version?: string;
};
const lockPackages = packageLock.packages as Record<string, LockPackageMetadata>;

function packageNameFromLockPath(packagePath: string): string {
  const packageSegments = packagePath.split("node_modules/");
  return packageSegments[packageSegments.length - 1] ?? packagePath;
}

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

  it("allows exactly the install scripts present in the lockfile", () => {
    const lockedInstallScripts = Object.entries(lockPackages)
      .filter(([packagePath, metadata]) => Boolean(packagePath && metadata.hasInstallScript))
      .map(([packagePath, metadata]) => {
        if (!metadata.version) {
          throw new Error(`Lockfile package ${packagePath} has no version`);
        }

        return `${packageNameFromLockPath(packagePath)}@${metadata.version}`;
      })
      .sort();

    const allowedInstallScripts = Object.entries(packageJson.allowScripts)
      .filter(([, allowed]) => allowed)
      .map(([packageId]) => packageId)
      .sort();

    expect(allowedInstallScripts).toEqual(lockedInstallScripts);
  });
});
