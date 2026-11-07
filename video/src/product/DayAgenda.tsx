// Generated from frontend/src/views/Home.tsx by scripts/prepare-ui.mjs.
import { useState } from "react";
import {
  Button,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../../../frontend/node_modules/@cqu-moe/ui/dist/index.js";
const weekdays = ["一", "二", "三", "四", "五"];
const exampleEvents = [
  {
    name: "高等数学",
    day: 0,
    time: "08:30–10:10",
    place: "第一教学楼 A102",
    tone: "blue",
  },
  {
    name: "大学英语",
    day: 1,
    time: "10:30–12:10",
    place: "第二教学楼 B205",
    tone: "apricot",
  },
  {
    name: "半导体物理与器件基础",
    day: 2,
    time: "08:30–10:10",
    place: "第一教学楼 A308",
    tone: "blue",
  },
  {
    name: "大学物理",
    day: 3,
    time: "10:30–12:10",
    place: "第一教学楼 A204",
    tone: "lilac",
  },
  {
    name: "线性代数 · 期中考试",
    day: 4,
    time: "10:30–12:10",
    place: "第二教学楼 B301",
    tone: "apricot",
  },
  {
    name: "电路原理",
    day: 0,
    time: "14:00–15:40",
    place: "第三教学楼 C103",
    tone: "lilac",
  },
  {
    name: "大学物理实验",
    day: 2,
    time: "14:00–15:40",
    place: "理科实验楼 402",
    tone: "lilac",
  },
  {
    name: "电路原理",
    day: 3,
    time: "14:00–15:40",
    place: "第三教学楼 C103",
    tone: "blue",
  },
];

export function DayAgenda() {
  const [day, setDay] = useState(3);
  return (
    <div className="home-agenda">
      <div className="home-agenda-heading">
        <span>我的一天</span>
        <span>日程示例</span>
      </div>
      <div className="home-agenda-date">
        <strong>{19 + day}</strong>
        <div>
          2026 年 10 月<br />
          <span>星期{weekdays[day]}</span>
        </div>
      </div>
      <div className="home-agenda-days" role="group" aria-label="选择示例日期">
        {weekdays.map((label, index) => (
          <Button
            key={label}
            variant={day === index ? "secondary" : "ghost"}
            aria-label={`查看周${label}安排`}
            aria-pressed={day === index}
            onClick={() => setDay(index)}
          >
            {label}
          </Button>
        ))}
      </div>
      <div
        className="home-agenda-events"
        aria-label={`星期${weekdays[day]}的示例日程`}
      >
        {exampleEvents
          .filter((event) => event.day === day)
          .map((event) => (
            <div className="home-agenda-row" key={event.name}>
              <span className="home-agenda-time">{event.time.slice(0, 5)}</span>
              <Dialog>
                <DialogTrigger asChild>
                  <Button
                    variant="ghost"
                    className={`home-event home-tone-${event.tone}`}
                  >
                    <strong>{event.name}</strong>
                    <span>{event.time}</span>
                    <span>{event.place}</span>
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogTitle>{event.name}</DialogTitle>
                  <DialogDescription>
                    日程示例，用于展示订阅效果，不是真实课表。
                  </DialogDescription>
                  <dl className="home-event-detail">
                    <div>
                      <dt>时间</dt>
                      <dd>
                        2026 年 10 月 {19 + day} 日<br />
                        {event.time}
                      </dd>
                    </div>
                    <div>
                      <dt>地点</dt>
                      <dd>{event.place}</dd>
                    </div>
                  </dl>
                </DialogContent>
              </Dialog>
            </div>
          ))}
      </div>
    </div>
  );
}
