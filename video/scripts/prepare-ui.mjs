import { URL } from "node:url";
import console from "node:console";
import { format } from "prettier";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { JSDOM } from "../../frontend/node_modules/jsdom/lib/api.js";
import { renderScheduleChangeEmail } from "../../src/services/schedule-email.ts";

const target = new URL("../src/product/", import.meta.url);
await mkdir(target, { recursive: true });
const home = await readFile(
  new URL("../../frontend/src/views/Home.tsx", import.meta.url),
  "utf8",
);
const data = home.slice(
  home.indexOf("const weekdays ="),
  home.indexOf("export default function Home"),
);
const start = home.indexOf("function DayAgenda()");
const end = home.indexOf("\nfunction HomeCta", start);
assert.ok(start > 0 && end > start && data.includes("exampleEvents"));
await writeFile(
  new URL("DayAgenda.tsx", target),
  await format(
    `// Generated from frontend/src/views/Home.tsx by scripts/prepare-ui.mjs.\nimport { useState } from 'react';\nimport { Button, Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription } from '../../../frontend/node_modules/@cqu-moe/ui/dist/index.js';\n${data}\nexport ${home.slice(start, end)}\n`,
    { parser: "typescript" },
  ),
);
const beforeDetails = {
  weekday: "周一",
  time: "14:00–15:40",
  position: "第三教学楼 C103",
  room: "C103",
  lecturer: "示例教师",
  experiment: "",
  seat: "",
};
const { html } = renderScheduleChangeEmail(
  {
    courses: [
      {
        kind: "changed",
        name: "电路原理",
        dates: ["2026-11-09"],
        extraDates: 0,
        datePairs: [
          { before: "2026-11-09T06:00:00Z", after: "2026-11-09T06:00:00Z" },
        ],
        beforeDetails,
        afterDetails: {
          ...beforeDetails,
          position: "第三教学楼 C205",
          room: "C205",
        },
      },
    ],
    exams: [],
    total: 1,
  },
  new Date("2026-11-06T00:00:00Z"),
);
const { document } = new JSDOM(html).window;
const logo = await readFile(
  new URL("../../frontend/public/brand/logo.svg", import.meta.url),
  "utf8",
);
const icon = document.querySelector("img");
assert.ok(icon);
icon.outerHTML = logo.replace(
  "<svg ",
  '<svg width="32" height="32" style="display:block" ',
);
const card = document.querySelector("table.card");
assert.ok(
  card?.textContent.includes("C103") && card.textContent.includes("C205"),
);
assert.equal(document.querySelectorAll("img").length, 0);
await writeFile(
  new URL("email.json", target),
  JSON.stringify(
    { body: document.body.innerHTML, comparison: card.outerHTML },
    null,
    2,
  ),
);
await writeFile(
  new URL("../public/email.html", import.meta.url),
  document.documentElement.outerHTML,
);
console.log("Prepared the original DayAgenda component and live email markup.");
