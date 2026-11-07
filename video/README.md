# CQU Schedule · 30 秒介绍

1920 × 1080，30 fps，900 帧。中文字幕与原创轻音乐，无配音。

## 预览与导出

本目录直接使用 `../frontend/node_modules` 中锁定的设计系统和 FullCalendar。先按前端 README 安装依赖，再运行：

```sh
cd video
npm ci
npm run prepare:ui
npm run dev -- --no-open --port=3018
```

预览：http://localhost:3018/ScheduleIntro。主时间轴及五个场景均可编辑。

```sh
npm run render
```

输出 `out/cqu-schedule-intro.mp4`：H.264 / yuv420p，1080p、30 fps、30 秒，含背景音乐。整个 `out/` 已从 Git 忽略。

渲染与检查统一使用 Remotion 自动下载并锁定版本的 Chrome Headless Shell。不要用系统 Chrome 或 Playwright Chromium 覆盖浏览器路径：这些完整浏览器与默认的 Headless Shell 启动模式不匹配，曾在并行抓帧时出现间歇性重复平铺画面。首次运行需要联网下载浏览器。

封面使用片尾最后一帧。`npm run render` 完成后自动保存 `out/cqu-schedule-intro-cover.png` 并写入 MP4 的封面轨；也可单独运行 `npm run cover`。此步骤需要 PATH 中的 `ffmpeg` 和 `ffprobe`（macOS 可用 `brew install ffmpeg`）。封面写入前会核对画面尺寸及音视频流校验值，保持原成片不重编码。播放器若不读取内嵌封面，可直接使用独立 PNG。

## 真实界面来源

视频不使用页面截图、栅格裁片或 Canvas 图片来展示 UI。文本和图形由浏览器直接按输出分辨率绘制。`src/product/` 保存仅用于视频的演示适配，产品源码保持不变：

- `AppShell`、`ContentContainer`、`PageHeader`、按钮、复制反馈和通知开关直接使用工程安装的 `@cqu-moe/ui`。
- 绑定提示、订阅卡片及详情沿用 `Dashboard.tsx` / `Calendar.tsx` 的 JSX 结构与原 CSS；详情移除 viewport portal，以便镜头定位。
- 日历使用真实 FullCalendar、原插件、原事件样式、中文日期与演示数据。日历直接在最终尺寸布局，避免 DOM 测量受 CSS 缩放影响。
- `DayAgenda.tsx` 从 `frontend/src/views/Home.tsx` 的原组件生成；没有重画日程卡。
- `email.json` 由原 `src/services/schedule-email.ts` 函数生成，保留 HTML 表格及内联样式；邮件图标替换为工程原 SVG。
- `styles.css` 引入实际主题、设计组件 CSS、Tailwind 基础样式及相关页面 CSS。视频固定浅色；禁用产品 CSS 过渡，由 Remotion 帧控制镜头。
- `bundler-override.mjs` 让前端组件和视频共用同一 React 实例。CLI 与关键帧检查使用相同配置。

`npm run prepare:ui` 可在原首页或邮件模板变化后刷新生成文件。提取脚本检查组件边界、前后教室文字及无栅格邮件图标。

## 镜头与节奏

| 时间      | 内容                           | 来源                     |
| --------- | ------------------------------ | ------------------------ |
| 0–4.5 秒  | 已登录后的统一认证账号绑定提示 | AppShell / Dashboard     |
| 4.5–12 秒 | 课程、考试、教学周及详情       | Calendar / FullCalendar  |
| 12–18 秒  | 三种课表订阅、复制链接         | Dashboard / ActionButton |
| 18–26 秒  | 开启通知、教室变化前后对照     | Switch / 原邮件 HTML     |
| 26–30 秒  | 课表之外，还有生活             | Home / DayAgenda         |

转场为 24 帧（0.8 秒）叠化；大画面入场约 1.4–1.6 秒，先加速再减速。镜头接续滚动、点击、聚焦、复制反馈、连线和手绘标记，保留阅读时间。源场景时长包含转场重叠，主片仍为 900 帧。

仅使用虚构账号、课程、考试、链接和日期，不读取真实账户。课表日期固定为 2026-11-06；片尾保留原首页日期示例。邮件表达同步发现安排变化后的通知，不表示课前提醒或实时推送。日历客户端按各自频率刷新订阅。

`public/` 只包含 SVG 标志、HTML 邮件及原创音乐。`scripts/source-server.mjs` 可用于对照实际 Vite 页面，提供只读演示数据；不参与视频截图或渲染。`scripts/soundtrack.py` 使用 NumPy 合成器乐，已生成的 WAV 可直接使用。

## 验收

```sh
npm run lint
npm run check
npm run check:video
```

`check` 拒绝 public 中的栅格截图，验证编译后的 30 秒及 16:9，渲染十七个关键帧并保存 `out/check/result.json`。与导出使用相同的锁定浏览器。人工检查文字、完整日历列、邮件对照、按钮与片尾；导出后再检查 MP4 流信息并完整解码。

`check:video` 完整解码成片，核对尺寸、帧率和帧数，并逐帧检查固定页眉的位置与像素稳定性，允许转场叠化和压缩噪声；可发现原成片中关键帧抽样漏掉的重复平铺坏帧。导出后自动执行。

仓库 Frontend CI 使用同一锁定浏览器，检查生成文件与原工程一致、运行 lint / TypeScript，并渲染关键帧；另导出日历段 249 帧并执行连续帧检查。CI 不上传 MP4 或渲染图片。

本目录独立于线上构建，交付为可编辑工程和本地 MP4。
