import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import console from "node:console";
import { rename, rm } from "node:fs/promises";

const video = "out/cqu-schedule-intro.mp4";
const cover = "out/cqu-schedule-intro-cover.png";
const temporary = "out/cqu-schedule-intro.cover-tmp.mp4";
const probe = (file) =>
  JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_streams", "-of", "json", file],
      { encoding: "utf8" },
    ),
  );
const streamHash = (file, stream) =>
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      "-map",
      stream,
      "-c",
      "copy",
      "-f",
      "hash",
      "-hash",
      "sha256",
      "-",
    ],
    { encoding: "utf8" },
  ).trim();

const main = probe(video).streams.find(
  (stream) => stream.codec_type === "video" && !stream.disposition.attached_pic,
);
assert.ok(
  main && Number(main.nb_frames) > 0,
  "The rendered video must contain frames",
);
execFileSync("ffmpeg", [
  "-v",
  "error",
  "-y",
  "-i",
  video,
  "-map",
  "0:v:0",
  "-vf",
  `select=eq(n\\,${Number(main.nb_frames) - 1})`,
  "-frames:v",
  "1",
  "-update",
  "1",
  cover,
]);
try {
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    video,
    "-i",
    cover,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-map",
    "1:v:0",
    "-c",
    "copy",
    "-disposition:v:1",
    "attached_pic",
    "-movflags",
    "+faststart",
    temporary,
  ]);
  const poster = probe(temporary).streams.find(
    (stream) => stream.disposition.attached_pic,
  );
  assert.ok(poster, "MP4 must contain its cover");
  assert.equal(poster.width, main.width);
  assert.equal(poster.height, main.height);
  for (const stream of ["0:v:0", "0:a:0"]) {
    assert.equal(
      streamHash(temporary, stream),
      streamHash(video, stream),
      "Adding a cover must preserve the video and audio packets",
    );
  }
  await rename(temporary, video);
} finally {
  await rm(temporary, { force: true });
}
console.log(
  `Saved ${cover} and attached it to ${video}; video and audio are unchanged.`,
);
