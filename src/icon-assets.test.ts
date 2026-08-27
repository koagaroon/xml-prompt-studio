import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cwd, execPath } from "node:process";
import { describe, expect, it } from "vitest";
import indexHtml from "../index.html?raw";
import packageJson from "../package.json";
import canonicalAppIcon from "../public/favicon.svg?raw";
import tauriConfig from "../src-tauri/tauri.conf.json";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ICON_GENERATION_TIMEOUT_MS = 30_000;

function readNativeIcon(fileName: string): Buffer {
  return readFileSync(resolve(cwd(), "src-tauri", "icons", fileName));
}

type IcoFrame = {
  bitDepth: number;
  colorCount: number;
  height: number;
  imageOffset: number;
  resourceSize: number;
  width: number;
};

function readIcoFrames(icon: Buffer): IcoFrame[] {
  const frameCount = icon.readUInt16LE(4);

  return Array.from({ length: frameCount }, (_, index) => {
    const entryOffset = 6 + index * 16;

    return {
      width: icon[entryOffset] || 256,
      height: icon[entryOffset + 1] || 256,
      colorCount: icon[entryOffset + 2],
      bitDepth: icon.readUInt16LE(entryOffset + 6),
      resourceSize: icon.readUInt32LE(entryOffset + 8),
      imageOffset: icon.readUInt32LE(entryOffset + 12),
    };
  });
}

describe("application icon assets", () => {
  it("uses public/favicon.svg as the canonical browser and native app mark", () => {
    expect(canonicalAppIcon).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(indexHtml).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
    expect(packageJson.scripts["icons:generate"]).toBe("node scripts/generate-icon-assets.mjs");
    expect(packageJson.scripts["icons:check"]).toBe(
      "node scripts/generate-icon-assets.mjs --check"
    );
    expect(tauriConfig.bundle.icon).toEqual(["icons/icon.ico", "icons/icon.png"]);
  });

  it(
    "regenerates the tracked native assets exactly from the canonical SVG",
    () => {
      const output = execFileSync(
        execPath,
        [resolve(cwd(), "scripts", "generate-icon-assets.mjs"), "--check"],
        { cwd: cwd(), encoding: "utf8", timeout: ICON_GENERATION_TIMEOUT_MS }
      );

      expect(output).toContain("against public/favicon.svg");
    },
    ICON_GENERATION_TIMEOUT_MS + 5_000
  );

  it("keeps the native PNG as a 512px 32-bit RGBA image", () => {
    const icon = readNativeIcon("icon.png");

    expect(icon.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
    expect(icon.toString("ascii", 12, 16)).toBe("IHDR");
    expect(icon.readUInt32BE(16)).toBe(512);
    expect(icon.readUInt32BE(20)).toBe(512);
    expect(icon[24]).toBe(8);
    expect(icon[25]).toBe(6);
  });

  it("keeps a multi-resolution 32-bit Windows ICO", () => {
    const icon = readNativeIcon("icon.ico");

    expect(icon.readUInt16LE(0)).toBe(0);
    expect(icon.readUInt16LE(2)).toBe(1);

    const frames = readIcoFrames(icon);
    expect(frames[0]).toMatchObject({ width: 32, height: 32 });
    expect(frames.map((frame) => frame.width).sort((left, right) => left - right)).toEqual([
      16, 24, 32, 48, 64, 256,
    ]);
    expect(frames.every((frame) => frame.height === frame.width)).toBe(true);
    expect(frames.every((frame) => frame.colorCount === 0)).toBe(true);
    expect(frames.every((frame) => frame.bitDepth === 32)).toBe(true);
    expect(
      frames.every(
        (frame) => frame.resourceSize > 0 && frame.imageOffset + frame.resourceSize <= icon.length
      )
    ).toBe(true);

    for (const frame of frames) {
      const resource = icon.subarray(frame.imageOffset, frame.imageOffset + frame.resourceSize);

      expect(resource.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
      expect(resource.toString("ascii", 12, 16)).toBe("IHDR");
      expect(resource.readUInt32BE(16)).toBe(frame.width);
      expect(resource.readUInt32BE(20)).toBe(frame.height);
      expect(resource[24]).toBe(8);
      expect(resource[25]).toBe(6);
    }
  });
});
