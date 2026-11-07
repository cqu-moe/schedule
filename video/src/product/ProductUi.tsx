import {
  memo,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Img, staticFile, useDelayRender } from "remotion";
import {
  AppShell,
  ContentContainer,
  PageHeader,
  ActionButton,
  Button,
  Switch,
  DialogHeader,
} from "../../../frontend/node_modules/@cqu-moe/ui/dist/index.js";
import {
  House,
  Plus,
  BookOpen,
  Monitor,
  UserRound,
  CalendarDays,
  Clock,
  Ellipsis,
  ExternalLink,
  MapPin,
  QrCode,
  RefreshCw,
  User,
  X,
} from "../../../frontend/node_modules/lucide-react";
import FullCalendar from "../../../frontend/node_modules/@fullcalendar/react";
import dayGridPlugin from "../../../frontend/node_modules/@fullcalendar/daygrid";
import timeGridPlugin from "../../../frontend/node_modules/@fullcalendar/timegrid";
import zhCnLocale from "../../../frontend/node_modules/@fullcalendar/core/locales/zh-cn";
import type { EventMountArg } from "../../../frontend/node_modules/@fullcalendar/core";
import { DayAgenda } from "./DayAgenda";
import email from "./email.json";
import "./styles.css";

// Native layout at the product's CSS size; the browser rasterizes it at export resolution.
export function ProductUi({
  width,
  zoom = 1,
  children,
}: {
  width: number;
  zoom?: number;
  children: ReactNode;
}) {
  return (
    <div className="product-ui" style={{ width, zoom }}>
      {children}
    </div>
  );
}

export function BindingCard() {
  return (
    <div className="dash-card dash-bind-card" style={{ margin: 0 }}>
      <p className="dash-bind-title">尚未绑定重庆大学统一认证账号</p>
      <p className="dash-sync-meta">
        个人课表同步依赖你的统一认证账号，绑定后即可继续。
      </p>
      <Button variant="outline">绑定重庆大学统一认证账号</Button>
    </div>
  );
}

export function AccountPage() {
  return (
    <AppShell
      brand={
        <a className="site-brand">
          <span className="brand-mark">
            <Img src={staticFile("logo.svg")} />
          </span>
          <span>CQU Schedule</span>
        </a>
      }
      navigation={
        <>
          <a>
            <House size={16} />
            首页
          </a>
          <a aria-current="page">
            <CalendarDays size={16} />
            我的订阅
          </a>
          <a>
            <Plus size={16} />
            添加订阅
          </a>
          <a>
            <BookOpen size={16} />
            使用与 API
          </a>
        </>
      }
      utilities={
        <>
          <Button variant="ghost" size="icon" aria-label="外观设置">
            <Monitor />
          </Button>
          <Button variant="ghost" size="icon" aria-label="账户菜单">
            <UserRound />
          </Button>
        </>
      }
    >
      <ContentContainer width="compact">
        <div className="page-body">
          <PageHeader
            title="我的订阅"
            description="管理课程与考试订阅，让日历跟上你的安排。"
            actions={
              <div className="dash-header-actions">
                <Button variant="outline" disabled>
                  <RefreshCw />
                  同步个人课表
                </Button>
                <Button>
                  <Plus />
                  添加订阅
                </Button>
              </div>
            }
          />
          <div className="dash-meta">
            <p className="dash-count">0 个订阅</p>
            <p className="dash-sync-status is-on">
              <span className="dash-status-dot" />
              自动同步已开启
            </p>
            <p className="dash-sync-status is-on">
              <span className="dash-status-dot" />
              外部订阅已开通
            </p>
          </div>
          <BindingCard />
          <div className="dash-section-heading" style={{ marginTop: 24 }}>
            <h2>课表订阅</h2>
            <a>
              <BookOpen size={16} />
              如何订阅到日历
            </a>
          </div>
        </div>
      </ContentContainer>
    </AppShell>
  );
}

export function SubscriptionCard({
  index,
  copied = false,
}: {
  index: number;
  copied?: boolean;
}) {
  return (
    <ul className="dash-list" style={{ margin: 0 }}>
      <li className="dash-card">
        <div className="dash-card-info">
          <div className="dash-card-title">
            <CalendarDays size={20} />
            <span className="dash-badge">
              {["全部", "课程", "考试"][index]}
            </span>
            <h3 className="dash-card-name">
              {["我的全部课表", "我的课程", "我的考试"][index]}
            </h3>
          </div>
          <div className="dash-card-sub">
            <span className="dash-semester">2026–2027 学年秋季学期</span>
            <span className="dash-sync-meta">同步于 2026/11/06 08:00</span>
          </div>
        </div>
        <div className="dash-card-actions">
          <div className="dash-main-actions">
            <Button>
              <ExternalLink />
              查看课表
            </Button>
            <ActionButton
              variant="outline"
              state={copied ? "success" : "idle"}
              labels={{
                idle: "复制链接",
                loading: "复制中",
                success: "已复制",
                error: "复制失败",
              }}
            />
          </div>
          <div className="dash-secondary-actions">
            <Button variant="outline">
              <RefreshCw />
              同步
            </Button>
            <Button variant="outline" size="icon" aria-label="二维码">
              <QrCode />
            </Button>
            <Button variant="outline" size="icon" aria-label="更多">
              <Ellipsis />
            </Button>
          </div>
        </div>
      </li>
    </ul>
  );
}

export function NotificationSetting() {
  return (
    <section
      className="dash-settings"
      style={{ margin: 0 }}
      aria-label="通知设置"
    >
      <div>
        <h2>课表变更通知</h2>
        <p>课表有变化时，通过邮件提醒你。</p>
      </div>
      <div className="dash-notification">
        <Switch aria-label="课表变更通知" checked />
      </div>
    </section>
  );
}

const courseColors = [
  "var(--link)",
  "var(--success)",
  "var(--warning)",
  "var(--primary)",
  "var(--destructive)",
];
const names: string[] = [];
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
].map(([title, day, start, end, location]) => {
  const name = String(title);
  const exam = name.includes("考试");
  if (!names.includes(name)) names.push(name);
  return {
    title: name,
    start: `2026-11-0${day}T${start}:00+08:00`,
    end: `2026-11-0${day}T${end}:00+08:00`,
    extendedProps: {
      location,
      instructor: "示例教师",
      type: exam ? "exam" : "course",
      color: exam
        ? "var(--destructive)"
        : courseColors[names.indexOf(name) % courseColors.length],
    },
  };
});

function handleEventMount({ el, event }: EventMountArg) {
  el.style.setProperty("--event-color", event.extendedProps.color);
  el.setAttribute("role", "button");
  if (event.extendedProps.type === "exam")
    el.setAttribute("data-event-type", "exam");
  const title = el.querySelector(".fc-event-title");
  if (el.closest(".fc-timegrid") && title && event.extendedProps.location) {
    const location = document.createElement("div");
    location.className = "cal-event-location";
    location.textContent = event.extendedProps.location;
    title.after(location);
  }
}

export const CalendarUi = memo(function CalendarUi({
  size = 1,
}: {
  size?: number;
}) {
  const { delayRender, continueRender } = useDelayRender();
  const [handle] = useState(() => delayRender("FullCalendar layout and fonts"));
  useLayoutEffect(() => {
    // Wait for FullCalendar's layout, never use wall-clock time for video motion.
    document.fonts.ready.then(() =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => continueRender(handle)),
      ),
    );
    return () => continueRender(handle);
  }, [continueRender, handle]);
  return (
    <div
      style={
        {
          background: "var(--background)",
          padding: 24 * size,
          ...Object.fromEntries(
            [1, 2, 3, 4, 10].map((n) => [`--space-${n}`, `${n * 4 * size}px`]),
          ),
          "--text-xs": `${12 * size}px`,
          "--text-sm": `${14 * size}px`,
          "--text-lg": `${18 * size}px`,
          "--text-xl": `${20 * size}px`,
        } as CSSProperties
      }
    >
      <header className="cal-heading">
        <h1>我的全部课表</h1>
        <p>2026–2027 学年秋季学期 · 第 9 周</p>
      </header>
      <div className="cal-calendar">
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin]}
          initialView="timeGridWeek"
          initialDate="2026-11-06"
          now="2026-11-06T08:00:00"
          locale={zhCnLocale}
          timeZone="Asia/Chongqing"
          firstDay={1}
          slotMinTime="08:00:00"
          slotMaxTime="22:00:00"
          slotLabelFormat={{
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }}
          eventTimeFormat={{
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }}
          allDaySlot={false}
          nowIndicator
          headerToolbar={{
            left: "prev,next today",
            center: "title",
            right: "timeGridDay,timeGridWeek,dayGridMonth",
          }}
          buttonText={{ today: "今天", day: "日", week: "周", month: "月" }}
          events={events}
          weekNumbers
          weekNumberContent={() => "W9"}
          eventDidMount={handleEventMount}
          eventInteractive
          height="auto"
        />
      </div>
    </div>
  );
});

export function ExamCard() {
  return (
    <div className="fc">
      <div
        className="fc-timegrid-event fc-v-event fc-event"
        data-event-type="exam"
        style={
          {
            "--event-color": "var(--destructive)",
            minHeight: 136,
          } as CSSProperties
        }
      >
        <div className="fc-event-main">
          <div className="fc-event-main-frame">
            <div className="fc-event-time">10:30 - 12:10</div>
            <div className="fc-event-title-container">
              <div className="fc-event-title fc-sticky">
                线性代数 · 期中考试
              </div>
              <div className="cal-event-location">第二教学楼 B301</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function EventDetail() {
  // The original DialogContent layout, without its viewport portal, so the camera can place it.
  return (
    <div
      className="grid gap-4 rounded-lg border bg-background p-6 shadow-lg"
      style={{ position: "relative" }}
    >
      <X
        size={16}
        style={{ position: "absolute", top: 16, right: 16, opacity: 0.7 }}
      />
      <DialogHeader>
        <h2 className="text-lg leading-none font-semibold">
          线性代数 · 期中考试
        </h2>
        <p className="text-muted-foreground text-sm">
          这条日程的详细信息如下。
        </p>
      </DialogHeader>
      <div className="cal-detail">
        <p className="cal-detail-row">
          <User />
          示例教师
        </p>
        <p className="cal-detail-row">
          <MapPin />
          第二教学楼 B301
        </p>
        <p className="cal-detail-row">
          <Clock />
          11/06 10:30 - 12:10
        </p>
        <span className="cal-badge cal-badge-exam">考试</span>
      </div>
    </div>
  );
}

export function EmailUi({ comparison = false }: { comparison?: boolean }) {
  return (
    <div
      style={{
        background: "white",
        color: "#0c0a09",
        fontFamily:
          "system-ui,-apple-system,'PingFang SC','Microsoft YaHei','Noto Sans SC',sans-serif",
      }}
      dangerouslySetInnerHTML={{
        __html: comparison ? email.comparison : email.body,
      }}
    />
  );
}

export function AgendaUi() {
  return (
    <div className="home-page">
      <DayAgenda />
    </div>
  );
}
