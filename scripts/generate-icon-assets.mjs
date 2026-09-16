import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");
const canonicalIcon = join(repoRoot, "public", "favicon.svg");
const nativeIconDirectory = join(repoRoot, "src-tauri", "icons");
const tauriCli = join(repoRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
const nativeIconFiles = ["icon.png", "icon.ico"];
const argumentsList = process.argv.slice(2);
const checkOnly = argumentsList.length === 1 && argumentsList[0] === "--check";

if (argumentsList.length > 0 && !checkOnly) {
  throw new Error("Usage: node scripts/generate-icon-assets.mjs [--check]");
}

const generatedIconDirectory = await mkdtemp(join(tmpdir(), "xml-prompt-studio-icons-"));

/** @returns {Promise<void>} */
function generateIcons() {
  return new Promise((resolveGeneration, rejectGeneration) => {
    const child = spawn(
      process.execPath,
      [tauriCli, "icon", canonicalIcon, "--output", generatedIconDirectory],
      { cwd: repoRoot, stdio: "inherit" }
    );

    child.once("error", rejectGeneration);
    child.once("close", (exitCode) => {
      if (exitCode === 0) {
        resolveGeneration();
        return;
      }

      rejectGeneration(new Error(`Tauri icon generation exited with code ${String(exitCode)}.`));
    });
  });
}

async function checkNativeIcons() {
  for (const fileName of nativeIconFiles) {
    const [generatedIcon, trackedIcon] = await Promise.all([
      readFile(join(generatedIconDirectory, fileName)),
      readFile(join(nativeIconDirectory, fileName)),
    ]);

    if (!generatedIcon.equals(trackedIcon)) {
      throw new Error(`${fileName} is out of date. Run npm run icons:generate.`);
    }
  }
}

try {
  await generateIcons();

  if (checkOnly) {
    await checkNativeIcons();
    console.log(`Verified ${nativeIconFiles.join(" and ")} against public/favicon.svg.`);
  } else {
    await mkdir(nativeIconDirectory, { recursive: true });
    // Keep the tracked native set limited to the files configured in tauri.conf.json.
    await Promise.all(
      nativeIconFiles.map((fileName) =>
        copyFile(join(generatedIconDirectory, fileName), join(nativeIconDirectory, fileName))
      )
    );
    console.log(`Generated ${nativeIconFiles.join(" and ")} from public/favicon.svg.`);
  }
} finally {
  await rm(generatedIconDirectory, { recursive: true, force: true });
}
