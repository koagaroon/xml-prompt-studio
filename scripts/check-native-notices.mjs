import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NATIVE_NOTICE_TARGET,
  assertNativeCompilerEnvironment,
  collectNativePackages,
  loadNativeInventory,
  nativeInputFingerprint,
  nativeFeatureArguments,
  nativePackageKey,
  parseCargoMetadata,
  parseNativeInventory,
  validateNativeArtifacts,
  validateNativeGraph,
  validateNativeToolchain,
} from "./lib/native-notices.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (
  args.some((arg) => !["--print-inventory", "--offline"].includes(arg)) ||
  new Set(args).size !== args.length
) {
  throw new Error("Usage: node scripts/check-native-notices.mjs [--print-inventory] [--offline]");
}
const target = process.env.TAURI_ENV_TARGET_TRIPLE ?? NATIVE_NOTICE_TARGET;
if (!/^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)+$/u.test(target))
  throw new Error(`Invalid native target: ${target}`);
if (target !== NATIVE_NOTICE_TARGET) {
  console.warn(
    `WARN: Native notice coverage is unverified for ${target}. Source builds remain available; the bundled native inventory covers ${NATIVE_NOTICE_TARGET} only. Review this target's notices before distribution.`
  );
} else {
  assertNativeCompilerEnvironment(process.env);
  const options = {
    cwd: root,
    encoding: /** @type {const} */ ("utf8"),
    windowsHide: true,
    timeout: 240_000,
    maxBuffer: 64 * 1024 * 1024,
  };
  const config = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const features = nativeFeatureArguments(
    config,
    process.env.TAURI_CONFIG === undefined ? undefined : JSON.parse(process.env.TAURI_CONFIG)
  );
  const metadataArgs = [
    "metadata",
    "--format-version",
    "1",
    args.includes("--offline") ? "--frozen" : "--locked",
    "--all-features",
    "--filter-platform",
    target,
    "--manifest-path",
    join(root, "src-tauri/Cargo.toml"),
  ];
  metadataArgs.push("--features", features.join(","));
  console.error(
    "Coverage profile: committed Cargo and Tauri configuration with the pinned compiler. Custom Cargo/platform configuration and extra CLI features need separate graph and license review before distribution."
  );
  console.error(
    `Checking locked native dependency notices for ${target}${args.includes("--offline") ? " using cached Cargo inputs" : " (Cargo may fetch locked dependency metadata)"}.`
  );
  const metadata = parseCargoMetadata(JSON.parse(execFileSync("cargo", metadataArgs, options)));
  const packages = collectNativePackages(metadata);
  if (args.includes("--print-inventory")) {
    const previous = parseNativeInventory(
      JSON.parse(readFileSync(join(root, "licenses/native/manifest.json"), "utf8"))
    );
    const byKey = new Map(previous.packages.map((entry) => [nativePackageKey(entry), entry]));
    const proposed = packages.map((entry) => {
      const old = byKey.get(nativePackageKey(entry));
      return {
        name: entry.name,
        version: entry.version,
        source: entry.source,
        license: entry.license,
        features: entry.features,
        usage: entry.usage,
        selectedLicense: old?.license === entry.license ? old.selectedLicense : "REVIEW REQUIRED",
        texts: old?.texts ?? [],
        artifacts: old?.artifacts ?? [],
      };
    });
    console.log(
      JSON.stringify(
        { ...previous, inputFingerprint: nativeInputFingerprint(root), packages: proposed },
        null,
        2
      )
    );
    console.error(
      "Inventory proposal only: review changed licenses, source texts, bundled payloads and compiler attribution before updating the manifest. No files were written."
    );
  } else {
    const { inventory } = loadNativeInventory(root);
    validateNativeGraph(inventory, packages);
    validateNativeArtifacts(inventory, packages, readFileSync);
    validateNativeToolchain(inventory, execFileSync("rustc", ["--version", "--verbose"], options));
    console.log(
      `Native notices cover ${packages.length} locked Cargo packages, ${inventory.artifacts.length} bundled payload(s), and Rust ${inventory.toolchain.version}.`
    );
  }
}
