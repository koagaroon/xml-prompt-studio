import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { buildFrontendNotices } from "./lib/frontend-notices.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check-dist")) {
  throw new Error("Usage: node scripts/generate-frontend-notices.mjs [--check-dist]");
}
const text = buildFrontendNotices(root);
if (args[0] === "--check-dist") {
  const packaged = readFileSync(join(root, "dist", "third-party-notices.txt"), "utf8");
  if (packaged !== text) {
    throw new Error("Packaged runtime notices differ from the locked dependency/license inputs.");
  }
  console.log("Packaged frontend, asset and reviewed native notices match their locked inputs.");
} else {
  writeFileSync(join(root, "public", "third-party-notices.txt"), text, "utf8");
  console.log("Generated frontend, asset and reviewed native notices from local license inputs.");
}
