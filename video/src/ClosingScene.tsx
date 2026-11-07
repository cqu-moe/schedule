import { AgendaUi, ProductUi } from "./product/ProductUi";
import {
  Interactive,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Frame, Title, clamp, move, shadow } from "./Frame";

export const ClosingScene = () => {
  const { fps } = useVideoConfig();
  const t = useCurrentFrame() / fps;
  return (
    <Frame
      chapter="CQU MOE / SCHEDULE"
      caption="非学校官方服务 · 安排请以学校系统为准"
    >
      <Title style={{ top: 280, fontSize: 112, letterSpacing: -5 }}>
        课表之外，
        <br />
        还有
        <span style={{ color: "oklch(0.45 0.16 258)", position: "relative" }}>
          生活
          <svg
            viewBox="0 0 200 24"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            style={{
              position: "absolute",
              left: 0,
              bottom: -20,
              width: "100%",
              height: 30,
            }}
          >
            <path
              d="M3 10C55 4 123 4 195 8"
              strokeWidth="3.5"
              pathLength="1"
              strokeDasharray="1"
              strokeDashoffset={interpolate(t, [1, 2.2], [1, 0], {
                ...clamp,
                easing: move,
              })}
            />
            <path
              d="M14 19C61 13 119 12 171 15"
              strokeWidth="3"
              pathLength="1"
              strokeDasharray="1"
              strokeDashoffset={interpolate(t, [1.5, 2.7], [1, 0], {
                ...clamp,
                easing: move,
              })}
            />
          </svg>
        </span>
        。
      </Title>
      <Interactive.P
        name="片尾说明"
        premountFor={fps}
        style={{
          position: "absolute",
          left: 102,
          top: 615,
          margin: 0,
          color: "#777",
          fontSize: 34,
          opacity: interpolate(t, [0.6, 1.8], [0, 1], clamp),
        }}
      >
        少一次来回查找，多一点自己的时间。
      </Interactive.P>
      <Interactive.P
        name="项目网址"
        premountFor={fps}
        style={{
          position: "absolute",
          left: 102,
          top: 751,
          margin: 0,
          fontSize: 38,
          fontWeight: 550,
          color: "#343434",
          opacity: interpolate(t, [1.7, 2.9], [0, 1], clamp),
        }}
      >
        schedule.cqu.moe{" "}
        <span
          style={{
            display: "inline-block",
            paddingLeft: 24,
            translate: `${interpolate(t, [2, 3.4], [-14, 0], { ...clamp, easing: move })}px ${interpolate(t, [2, 3.4], [14, 0], { ...clamp, easing: move })}px`,
          }}
        >
          ↗
        </span>
      </Interactive.P>
      <Interactive.Div
        name="首页原有我的一天组件"
        premountFor={fps}
        style={{
          position: "absolute",
          left: 1180,
          top: 224,
          width: 580,
          borderRadius: 24,
          overflow: "hidden",
          boxShadow: shadow,
          rotate: interpolate(t, [0, 4], ["3deg", "0deg"], {
            ...clamp,
            easing: move,
          }),
          opacity: interpolate(t, [0.1, 1.4], [0, 1], clamp),
          translate: `${interpolate(t, [0.1, 1.6, 4], [65, 0, -18], { ...clamp, easing: move })}px ${interpolate(t, [0.1, 1.6], [45, 0], { ...clamp, easing: move })}px`,
        }}
      >
        <ProductUi width={472} zoom={580 / 472}>
          <AgendaUi />
        </ProductUi>
      </Interactive.Div>
    </Frame>
  );
};
