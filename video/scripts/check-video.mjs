import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import console from "node:console";
import { writeFile } from "node:fs/promises";
import process from "node:process";

const file = process.argv[2] ?? "out/cqu-schedule-intro.mp4";
const expectedFrames = Number(process.argv[3] ?? 900);
assert.ok(Number.isSafeInteger(expectedFrames) && expectedFrames > 60);
const { streams } = JSON.parse(
  execFileSync(
    "ffprobe",
    ["-v", "error", "-show_streams", "-of", "json", file],
    { encoding: "utf8" },
  ),
);
const video = streams.find(
  (stream) => stream.codec_type === "video" && !stream.disposition.attached_pic,
);
assert.ok(video);
assert.equal(video.width, 1920);
assert.equal(video.height, 1080);
assert.equal(video.r_frame_rate, "30/1");
assert.equal(Number(video.nb_frames), expectedFrames);

// Compare header ink, so moving shadows and crossfade brightness cannot mimic displaced text.
const pixelsPerFrame = 480 * 32;
const pixels = execFileSync(
  "ffmpeg",
  [
    "-v",
    "error",
    "-i",
    file,
    "-map",
    "0:v:0",
    "-vf",
    "crop=1920:128:0:0,scale=480:32",
    "-pix_fmt",
    "gray",
    "-f",
    "rawvideo",
    "-",
  ],
  { maxBuffer: 32 * 1024 * 1024 },
);
assert.equal(pixels.length, pixelsPerFrame * expectedFrames);
const reference = pixels.subarray(60 * pixelsPerFrame, 61 * pixelsPerFrame);
const corruptedFrames = [];
let maxHeaderMismatch = 0;
for (let frame = 0; frame < expectedFrames; frame++) {
  let changedPixels = 0;
  for (let pixel = 0; pixel < pixelsPerFrame; pixel++) {
    if ((pixels[frame * pixelsPerFrame + pixel] < 180) !== (reference[pixel] < 180))
      changedPixels++;
  }
  const mismatch = changedPixels / pixelsPerFrame;
  maxHeaderMismatch = Math.max(maxHeaderMismatch, mismatch);
  // Allow antialiasing on at most 0.5% of pixels; observed tiled frames change over 2.6%.
  if (mismatch > 0.005)
    corruptedFrames.push({ frame, seconds: frame / 30, mismatch });
}
const result = {
  file,
  checkedFrames: expectedFrames,
  maxHeaderMismatch,
  corruptedFrames,
};
await writeFile(`${file}.check.json`, JSON.stringify(result, null, 2));
assert.deepEqual(
  corruptedFrames,
  [],
  "Exported frames must preserve the stationary header without tiling or sudden shifts",
);
console.log(
  `PASS: decoded ${expectedFrames} frames; no header corruption (max mismatch ${(maxHeaderMismatch * 100).toFixed(3)}%).`,
);
