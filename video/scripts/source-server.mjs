import { createServer } from "../../frontend/node_modules/vite/dist/node/index.js";
import { renderScheduleChangeEmail } from "../../src/services/schedule-email.ts";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

const output = fileURLToPath(new URL("../public/", import.meta.url));
await mkdir(output, { recursive: true });
await copyFile(
  new URL("../../frontend/public/brand/logo.svg", import.meta.url),
  `${output}logo.svg`,
);
const subscriptions = ["我的全部课表", "我的课程", "我的考试"].map(
  (source_name, i) => ({
    id: `demo-${i}`,
    user_id: "video-demo",
    source_type: ["personal_all", "personal_courses", "personal_exams"][i],
    source_id: "personal",
    source_name,
    is_personal: true,
    is_active: true,
    session_id: "2026-fall",
    session_name: "2026–2027 学年秋季学期",
    semester_start: "2026-09-07",
    last_synced_at: "2026-11-06T00:00:00Z",
    sync_status: "success",
    sync_run_id: null,
    sync_trigger: null,
    sync_requested_at: null,
    sync_started_at: null,
    sync_finished_at: null,
    sync_error_code: null,
    sync_error_message: null,
    manual_refresh_at: null,
    created_at: "2026-09-07T00:00:00Z",
    updated_at: "2026-11-06T00:00:00Z",
    links: [
      {
        id: `demo-link-${i}`,
        token: `video-demo-${i}`,
        label: null,
        formats: ["ics", "web"],
        is_default: true,
      },
    ],
  }),
);
const events = [
  ["高等数学", 2, "08:30", "10:10", "第一教学楼 A102"],
  ["电路原理", 2, "14:00", "15:40", "第三教学楼 C103"],
  ["大学英语", 3, "10:30", "12:10", "第二教学楼 B205"],
  ["数字逻辑设计", 3, "14:00", "15:40", "第一教学楼 A308"],
  ["高等数学", 4, "08:30", "10:10", "第一教学楼 A102"],
  ["大学物理实验", 4, "14:00", "15:40", "理科实验楼 402"],
  ["大学物理", 5, "10:30", "12:10", "第一教学楼 A204"],
  ["电路原理", 5, "14:00", "15:40", "第三教学楼 C103"],
  ["线性代数 · 期中考试", 6, "10:30", "12:10", "第二教学楼 B301"],
].map(([name, day, start, end, location]) => ({
  name,
  location,
  instructor: "示例教师",
  type: name.includes("考试") ? "exam" : "course",
  start_time: `2026-11-0${day}T${start}:00+08:00`,
  end_time: `2026-11-0${day}T${end}:00+08:00`,
}));
const beforeDetails = {
  weekday: "周一",
  time: "14:00–15:40",
  position: "第三教学楼 C103",
  room: "C103",
  lecturer: "示例教师",
  experiment: "",
  seat: "",
};
const mail = renderScheduleChangeEmail(
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
await writeFile(`${output}email.html`, mail.html);

const server = await createServer({
  root: fileURLToPath(new URL("../../frontend/", import.meta.url)),
  server: { host: "127.0.0.1", port: 5178, strictPort: true },
  plugins: [
    {
      name: "video-synthetic-api",
      transformIndexHtml: () => [
        {
          tag: "script",
          injectTo: "head-prepend",
          children: `
      const OriginalDate = Date;
      window.Date = class extends OriginalDate {
        constructor(...args) { super(...(args.length ? args : ['2026-11-06T08:00:00+08:00'])); }
        static now() { return new OriginalDate('2026-11-06T08:00:00+08:00').getTime(); }
      };
    `,
        },
      ],
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const path = new URL(req.url, "http://localhost").pathname;
          if (path === "/video-email") {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            return res.end(
              mail.html.replace(
                "https://schedule.cqu.moe/brand/icon-192.png",
                "/brand/icon-192.png",
              ),
            );
          }
          if (!path.startsWith("/api/")) return next();
          const unbound = req.headers.referer?.includes("unbound");
          const responses = {
            "/api/v2/config": { public_url: "https://schedule.cqu.moe" },
            "/api/v2/me": {
              user: {
                id: "video-demo",
                name: "同学",
                email: "demo@example.invalid",
                role: "student",
              },
              cquBindStatus: unbound ? "unbound" : "active",
              caps: {
                calendar: {
                  sync: true,
                  external: true,
                  share: true,
                  change_notification: true,
                  sub_limit: 5,
                  share_limit: 10,
                  sync_interval: 60,
                  manual_refresh: 5,
                  external_sync_interval: 60,
                  external_manual_refresh: 5,
                },
              },
            },
            "/api/v2/subscriptions": {
              subscriptions: unbound ? [] : subscriptions,
              count: unbound ? 0 : 3,
              personal_setup: null,
              manual_remaining: 5,
            },
            "/api/v2/notification-settings": { eligible: true, enabled: true },
            "/api/v2/calendar/video-demo-0/view.json": {
              semester: "2026–2027 学年秋季学期",
              semester_start: "2026-09-07",
              events,
            },
          };
          res.setHeader("Content-Type", "application/json");
          if (req.method !== "GET" || !(path in responses)) {
            res.statusCode = 404;
            return res.end(
              JSON.stringify({
                error: "This preview only serves synthetic read-only data.",
              }),
            );
          }
          res.end(JSON.stringify(responses[path]));
        });
      },
    },
  ],
});
await server.listen();
server.printUrls();
