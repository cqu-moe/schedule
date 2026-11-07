import {
  CalendarUi,
  ExamCard,
  EventDetail,
  ProductUi,
} from "./product/ProductUi";
import {
  Interactive,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Frame, Title, clamp, move, shadow } from "./Frame";
import { Pointer } from "./Pointer";

export const CalendarScene = () => {
  const { fps } = useVideoConfig();
  const t = useCurrentFrame() / fps;
  return (
    <Frame chapter="02 / 课表日历" caption="课程、考试 · 时间、地点 · 教学周">
      <Title>课程与考试，一眼看清。</Title>
      <Interactive.Div
        name="真实 FullCalendar 课表"
        className={t >= 3.65 ? "calendar-picked" : undefined}
        premountFor={fps}
        style={{
          position: "absolute",
          left: 96,
          top: 278,
          width: 1728,
          height: 666,
          borderRadius: 14,
          overflow: "hidden",
          boxShadow: shadow,
          border: "1px solid #ddd",
          opacity: interpolate(t, [0, 1.2, 3.6, 5], [0, 1, 1, 0.42], clamp),
          translate: `0 ${interpolate(t, [0, 1.4], [60, 0], { ...clamp, easing: move })}px`,
        }}
      >
        <div
          style={{
            width: "100%",
            translate: `0 ${interpolate(t, [1.3, 3.5, 6.5, 8.3], [0, -220, -220, -255], { ...clamp, easing: move })}px`,
          }}
        >
          <ProductUi width={1728}>
            <CalendarUi size={1.2} />
          </ProductUi>
        </div>
      </Interactive.Div>
      <Pointer
        clickAt={3.65}
        style={{
          left: interpolate(t, [2.4, 3.65], [1520, 1190], {
            ...clamp,
            easing: move,
          }),
          top: interpolate(t, [2.4, 3.65], [850, 500], {
            ...clamp,
            easing: move,
          }),
          opacity: interpolate(t, [2.4, 2.8, 3.9, 4.4], [0, 1, 1, 0], clamp),
        }}
      />
      <Interactive.Div
        name="从课表中聚焦原考试卡片"
        premountFor={fps}
        style={{
          position: "absolute",
          left: interpolate(t, [3.65, 5.1, 6.6, 8.3], [1103, 1010, 1010, 995], {
            ...clamp,
            easing: move,
          }),
          top: interpolate(t, [3.65, 5.1], [485, 340], {
            ...clamp,
            easing: move,
          }),
          transformOrigin: "top left",
          scale: interpolate(t, [3.65, 5.1], [0.604, 1], {
            ...clamp,
            easing: move,
          }),
          opacity: t >= 3.65 ? 1 : 0,
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: shadow,
        }}
      >
        <ProductUi width={186} zoom={370 / 186}>
          <ExamCard />
        </ProductUi>
      </Interactive.Div>
      <Interactive.Div
        name="实际考试详情弹窗"
        premountFor={fps}
        style={{
          position: "absolute",
          left: 1010,
          top: 625,
          width: 750,
          borderRadius: 18,
          overflow: "hidden",
          boxShadow: "0 25px 85px rgba(20,24,32,.18)",
          opacity: interpolate(t, [4.55, 5.8], [0, 1], clamp),
          translate: `${interpolate(t, [6.6, 8.3], [0, -15], { ...clamp, easing: move })}px ${interpolate(t, [4.55, 6.05], [-55, 0], { ...clamp, easing: move })}px`,
          scale: interpolate(t, [4.55, 6.05], [0.94, 1], {
            ...clamp,
            easing: move,
          }),
          transformOrigin: "top left",
        }}
      >
        <ProductUi width={512} zoom={750 / 512}>
          <EventDetail />
        </ProductUi>
      </Interactive.Div>
      <Interactive.P
        name="聚焦信息说明"
        premountFor={fps}
        style={{
          position: "absolute",
          left: 135,
          top: 735,
          padding: "22px 30px",
          background: "rgba(250,250,250,.96)",
          borderRadius: 12,
          fontSize: 38,
          color: "#343434",
          opacity: interpolate(t, [5.7, 7], [0, 1], clamp),
          translate: `0 ${interpolate(t, [5.7, 7.3], [25, 0], { ...clamp, easing: move })}px`,
        }}
      >
        点开一门课，
        <br />
        <span style={{ fontSize: 28, color: "#777", lineHeight: 2 }}>
          时间、地点、考试安排，都在这里。
        </span>
      </Interactive.P>
    </Frame>
  );
};
