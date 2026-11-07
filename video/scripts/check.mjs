import { productUiConfig } from "../bundler-override.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import console from "node:console";
import { bundle } from "@remotion/bundler";
import { getCompositions, openBrowser, renderStill } from "@remotion/renderer";

// Validate the compiled composition and decode every scene's assets, including its final frame.
assert.deepEqual(
  (await readdir("public")).filter((name) => /\.(png|jpe?g|webp)$/i.test(name)),
  [],
  "UI screenshots must not be bundled",
);
const output = resolve("out/check");
await mkdir(output, { recursive: true });
const serveUrl = await bundle({
  entryPoint: resolve("src/index.ts"),
  rspack: true,
  rspackOverride: productUiConfig,
});
const browser = await openBrowser("chrome");
try {
  const compositions = await getCompositions(serveUrl, {
    puppeteerInstance: browser,
  });
  const composition = compositions.find((item) => item.id === "ScheduleIntro");
  assert.ok(composition, "The main video must be registered");
  assert.equal(composition.durationInFrames / composition.fps, 30);
  assert.equal(composition.width / composition.height, 16 / 9);
  const frames = [
    24, 75, 120, 195, 255, 315, 351, 405, 465, 525, 585, 660, 735, 765, 825,
    870, 899,
  ];
  for (const frame of frames) {
    await renderStill({
      serveUrl,
      composition,
      frame,
      output: `${output}/${frame}.png`,
      puppeteerInstance: browser,
      imageFormat: "png",
      overwrite: true,
    });
  }
  await writeFile(
    `${output}/result.json`,
    JSON.stringify(
      {
        id: composition.id,
        width: composition.width,
        height: composition.height,
        fps: composition.fps,
        durationInFrames: composition.durationInFrames,
        frames,
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS: 30 seconds, 16:9, ${frames.length} frames rendered without missing assets.`,
  );
} finally {
  await browser.close({ silent: true });
}
